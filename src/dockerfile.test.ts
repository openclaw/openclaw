import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PLUGIN_ROOT_DIR } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { isMap, parseAllDocuments } from "yaml";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "./test-utils/node-process.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function readDockerfile(name = "Dockerfile", collapse = false) {
  const text = await readFile(join(repoRoot, name), "utf8");
  return collapse ? text.replace(/\\\r?\n[ \t]*/g, " ") : text;
}

async function copyTo(source: string, target: string) {
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  execFileSync(file, args, { cwd, env: { PATH: process.env.PATH, ...env }, stdio: "pipe" });
}

function expectInOrder(text: string, ...fragments: string[]) {
  let previous = -1;
  for (const fragment of fragments) {
    const index = text.indexOf(fragment);
    expect(index, fragment).toBeGreaterThan(previous);
    previous = index;
  }
}

function expectContains(text: string, ...fragments: string[]) {
  for (const fragment of fragments) {
    expect(text).toContain(fragment);
  }
}

async function stageManifests(body: string, fixture: string, stage: string) {
  const stageRoot = join(fixture, stage);
  const expanded = body.replaceAll("${OPENCLAW_BUNDLED_PLUGIN_DIR}", BUNDLED_PLUGIN_ROOT_DIR);
  for (const [, from, inputs, destination] of expanded.matchAll(
    /^COPY (?:--from=(\S+) )?(.+) (\S+)$/gm,
  )) {
    assert(inputs && destination, "Docker manifest COPY inputs are missing");
    const sourceRoot = from ? join(fixture, from) : repoRoot;
    const destinationRoot = join(stageRoot, destination.startsWith("/") ? "" : "app", destination);
    for (const input of inputs.split(/\s+/)) {
      const source = join(sourceRoot, input);
      const sourceStat = await stat(source);
      const target =
        !sourceStat.isDirectory() && destination.endsWith("/")
          ? join(destinationRoot, basename(input))
          : destinationRoot;
      if (from || sourceStat.isFile()) {
        await copyTo(source, target);
        continue;
      }
      await mkdir(target, { recursive: true });
      // The extraction stage reads only direct workspace manifests, not their source trees.
      const entries = await readdir(source, { withFileTypes: true });
      for (const entry of entries.filter((item) => item.isDirectory())) {
        const files = await readdir(join(source, entry.name));
        for (const file of files.filter(
          (name) => name === "package.json" || name === "openclaw.plugin.json",
        )) {
          await copyTo(join(source, entry.name, file), join(target, entry.name, file));
        }
      }
    }
  }
  return stageRoot;
}

describe("Dockerfile", () => {
  it.runIf(process.platform !== "win32").each(["", "matrix"])(
    "stages locked manifests and optional plugin selection: %j",
    async (selection) => {
      const dockerfile = await readDockerfile("Dockerfile", true);
      const stages = new Map(
        [...dockerfile.matchAll(/^FROM \S+ AS (\S+)\n([\s\S]*?)(?=^FROM |(?![\s\S]))/gm)].map(
          ([, name, body]) => [name, body],
        ),
      );
      const workspaceBody = stages.get("workspace-deps");
      const dependencyBody = stages.get("dependency-inputs");
      assert(workspaceBody && dependencyBody, "Docker dependency input stages are missing");
      const fixture = tempDirs.make("openclaw-docker-workspace-manifests-");
      const workspaceRoot = await stageManifests(workspaceBody, fixture, "workspace-deps");
      const extraction = [...workspaceBody.matchAll(/^RUN (.+)$/gm)]
        .map(([, command]) => command)
        .join("\n")
        .replace(/\/(tmp|out)(?=\/|["\s]|$)/g, `${workspaceRoot}/$1`);
      expect(extraction).not.toBe("");
      run("/bin/sh", ["-eu", "-c", extraction], {
        OPENCLAW_EXTENSIONS: selection,
        OPENCLAW_BUNDLED_PLUGIN_DIR: BUNDLED_PLUGIN_ROOT_DIR,
      });
      const inputsRoot = await stageManifests(dependencyBody, fixture, "dependency-inputs");
      const appRoot = join(inputsRoot, "app");
      const documents = parseAllDocuments(await readFile(join(appRoot, "pnpm-lock.yaml"), "utf8"));
      expect(documents.flatMap((document) => document.errors)).toEqual([]);
      const importers = documents.at(-1)?.get("importers", true);
      if (!isMap(importers)) {
        throw new Error("Application pnpm lockfile importers are missing");
      }
      expect(importers.items.length).toBeGreaterThan(1);
      for (const importer of importers.items) {
        const manifest = join(String(importer.key), "package.json");
        expect(
          await readFile(join(appRoot, manifest)).catch(() => null),
          `Docker dependency inputs are missing ${manifest}`,
        ).toEqual(await readFile(join(repoRoot, manifest)));
      }

      const readPluginDirs = (kind: string) =>
        readFile(join(inputsRoot, `tmp/openclaw-${kind}-plugin-dirs`), "utf8");
      const selected = await readPluginDirs("selected");
      expect(selected).toBe(selection ? `${selection}\n` : "");
      const installed = (await readPluginDirs("workspace")).trim().split("\n");
      expect(installed).toContain("telegram");
      expect(installed).not.toContain("facetime");
      expect(installed.includes("matrix")).toBe(selection === "matrix");
    },
  );

  it("keeps validated plugin selection outside build-context copies", async () => {
    const dockerfile = await readDockerfile();
    expectInOrder(
      dockerfile,
      "COPY --from=workspace-deps /out/openclaw-selected-plugin-dirs /tmp/openclaw-selected-plugin-dirs",
      "COPY . .",
    );
    expect(dockerfile).not.toContain("/app/.openclaw-selected-plugin-dirs");
    expect(dockerfile).not.toContain("./.openclaw-selected-plugin-dirs");
    expectContains(
      dockerfile,
      'selected_plugin_dirs="$(cat /tmp/openclaw-selected-plugin-dirs)"',
      'OPENCLAW_EXTENSIONS="$(cat /tmp/openclaw-selected-plugin-dirs)"',
    );
  });

  it.each(["Dockerfile", "scripts/docker/cleanup-smoke/Dockerfile"])(
    "runs root lifecycle scripts from %s dependency inputs",
    async (dockerfileName) => {
      const dockerfile = await readDockerfile(dockerfileName, true);
      const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
      expect(installIndex).toBeGreaterThan(-1);
      const fixture = tempDirs.make("openclaw-docker-lifecycle-");
      // Execute lifecycle scripts using only actual pre-install COPY inputs.
      for (const [, sources, destination] of dockerfile
        .slice(0, installIndex)
        .matchAll(/^COPY (?!-{2})([^\n]+) (\.\/\S*)$/gm)) {
        assert(sources && destination, "Expected local COPY sources and destination");
        const inputs = sources
          .split(/\s+/)
          .filter((s) => s === "package.json" || s.endsWith(".mjs"));
        for (const input of inputs) {
          await copyTo(
            join(repoRoot, input),
            join(fixture, destination, destination.endsWith("/") ? basename(input) : ""),
          );
        }
      }
      const packageJson = JSON.parse(await readFile(join(fixture, "package.json"), "utf8")) as {
        scripts: Record<string, string>;
      };
      const home = join(fixture, "home");
      await mkdir(home);
      const env = { HOME: home, USERPROFILE: home, npm_config_user_agent: "pnpm/12" };
      for (const lifecycle of ["preinstall", "install", "postinstall", "prepare"]) {
        const command = packageJson.scripts[lifecycle];
        if (!command) {
          continue;
        }
        const scriptPath = command.match(/^node (scripts\/[^\s]+)$/)?.[1];
        assert(scriptPath, `Unsupported root lifecycle command: ${command}`);
        const execute = () => run(resolveTestNodeExecPath(), [scriptPath], env, fixture);
        expect.soft(execute, lifecycle).not.toThrow();
      }
    },
  );

  it("normalizes plugin and agent paths permissions in image layers", async () => {
    const dockerfile = await readDockerfile();
    expectContains(
      dockerfile,
      "RUN for dir in /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} /app/.agent /app/.agents; do \\",
      'find "$dir" -type d -exec chmod 755 {} +',
      'find "$dir" -type f -exec chmod 644 {} +',
    );
  });

  it("counts primary pub keys before Docker apt fingerprint compare and dearmor", async () => {
    const dockerfile = await readDockerfile("Dockerfile", true);
    expect(dockerfile).toContain('== "fpr" {');
    expect(dockerfile).not.toContain('\\"fpr\\"');
    expect(dockerfile).toMatch(
      /curl -fsSL --connect-timeout 10 --max-time 120\s+https:\/\/download\.docker\.com\/linux\/debian\/gpg -o \/tmp\/docker\.gpg\.asc/u,
    );
    const anchor = dockerfile.indexOf(
      "https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc",
    );
    const slice = dockerfile.slice(anchor);
    expectContains(slice, '$1 == "pub"', '[ "$docker_gpg_pub_count" != "1" ]');
    expect(slice).not.toContain('\\"pub\\"');
    expectInOrder(slice, "docker_gpg_pub_count=", "actual_fingerprint=", "gpg --dearmor");
  });

  it("pre-creates named-volume mount points before switching to the node user", async () => {
    const dockerfile = await readDockerfile();
    const runtime = dockerfile.slice(dockerfile.lastIndexOf("FROM base-runtime"));
    // #85968: the node-owned parent must precede the private leaf directories.
    expectInOrder(
      runtime,
      "FROM base-runtime",
      "RUN install -d -m 0755 -o node -g node /home/node/.config",
      "install -d -m 0700 -o node -g node \\",
      "USER node",
    );
    expect(dockerfile).not.toContain("mkdir -p /home/node/.openclaw");
    expectContains(
      dockerfile,
      "stat -c '%U:%G %a' /home/node/.openclaw | grep -qx 'node:node 700'",
      "stat -c '%U:%G %a' /home/node/.openclaw/workspace | grep -qx 'node:node 700'",
      "stat -c '%U:%G %a' /home/node/.config | grep -qx 'node:node 755'",
      "stat -c '%U:%G %a' /home/node/.config/openclaw | grep -qx 'node:node 700'",
    );
  });
});
