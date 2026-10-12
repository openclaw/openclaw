// Tests Dockerfile metadata and expected install commands.
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLED_PLUGIN_ROOT_DIR } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { isMap, parseAllDocuments } from "yaml";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";
import { resolveTestNodeExecPath } from "./test-utils/node-process.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const dockerfilePath = join(repoRoot, "Dockerfile");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function collapseDockerContinuations(dockerfile: string): string {
  return dockerfile.replace(/\\\r?\n[ \t]*/g, " ");
}

async function stageDockerManifestCopies(params: { body: string; fixture: string; stage: string }) {
  const stageRoot = join(params.fixture, params.stage);
  const body = params.body.replaceAll("${OPENCLAW_BUNDLED_PLUGIN_DIR}", BUNDLED_PLUGIN_ROOT_DIR);
  for (const [, from, inputs, destination] of body.matchAll(
    /^COPY (?:--from=(\S+) )?(.+) (\S+)$/gm,
  )) {
    if (!inputs || !destination) {
      throw new Error("Docker manifest COPY inputs are missing");
    }
    const sourceRoot = from ? join(params.fixture, from) : repoRoot;
    const destinationRoot = destination.startsWith("/")
      ? join(stageRoot, destination)
      : join(stageRoot, "app", destination);
    for (const input of inputs.split(/\s+/)) {
      const source = join(sourceRoot, input);
      const sourceStat = await stat(source);
      const target =
        !sourceStat.isDirectory() && destination.endsWith("/")
          ? join(destinationRoot, basename(input))
          : destinationRoot;
      await mkdir(dirname(target), { recursive: true });
      if (from || sourceStat.isFile()) {
        await cp(source, target, { recursive: true });
        continue;
      }
      await mkdir(target, { recursive: true });
      // The extraction stage reads only direct workspace manifests, not their source trees.
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
          continue;
        }
        for (const file of await readdir(join(source, entry.name))) {
          if (file !== "package.json" && file !== "openclaw.plugin.json") {
            continue;
          }
          const manifestTarget = join(target, entry.name, file);
          await mkdir(dirname(manifestTarget), { recursive: true });
          await cp(join(source, entry.name, file), manifestTarget);
        }
      }
    }
  }
  return stageRoot;
}

describe("Dockerfile", () => {
  it.runIf(process.platform !== "win32").each(["", "matrix"])(
    "stages every locked workspace manifest while retaining optional plugin selection: %j",
    async (selection) => {
      const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
      const stages = new Map(
        [...dockerfile.matchAll(/^FROM \S+ AS (\S+)\n([\s\S]*?)(?=^FROM |(?![\s\S]))/gm)].map(
          ([, name, body]) => [name, body],
        ),
      );
      const workspaceBody = stages.get("workspace-deps");
      const dependencyBody = stages.get("dependency-inputs");
      if (!workspaceBody || !dependencyBody) {
        throw new Error("Docker dependency input stages are missing");
      }
      const fixture = tempDirs.make("openclaw-docker-workspace-manifests-");
      const workspaceRoot = await stageDockerManifestCopies({
        body: workspaceBody,
        fixture,
        stage: "workspace-deps",
      });
      const extraction = [...workspaceBody.matchAll(/^RUN (.+)$/gm)]
        .map(([, command]) => command)
        .join("\n")
        .replace(/\/(tmp|out)(?=\/|["\s]|$)/g, `${workspaceRoot}/$1`);
      expect(extraction).not.toBe("");
      execFileSync("/bin/sh", ["-eu", "-c", extraction], {
        env: {
          PATH: process.env.PATH,
          OPENCLAW_EXTENSIONS: selection,
          OPENCLAW_BUNDLED_PLUGIN_DIR: BUNDLED_PLUGIN_ROOT_DIR,
        },
      });
      const inputsRoot = await stageDockerManifestCopies({
        body: dependencyBody,
        fixture,
        stage: "dependency-inputs",
      });
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

      const selected = await readFile(
        join(inputsRoot, "tmp/openclaw-selected-plugin-dirs"),
        "utf8",
      );
      expect(selected).toBe(selection ? `${selection}\n` : "");
      const installed = (
        await readFile(join(inputsRoot, "tmp/openclaw-workspace-plugin-dirs"), "utf8")
      )
        .trim()
        .split("\n");
      expect(installed).toContain("telegram");
      expect(installed).not.toContain("facetime");
      expect(installed.includes("matrix")).toBe(selection === "matrix");
    },
  );

  it("keeps validated plugin selection outside the build-context copy destination", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const selectionCopyIndex = dockerfile.indexOf(
      "COPY --from=workspace-deps /out/openclaw-selected-plugin-dirs /tmp/openclaw-selected-plugin-dirs",
    );
    const buildContextCopyIndex = dockerfile.indexOf("COPY . .");

    expect(selectionCopyIndex).toBeGreaterThan(-1);
    expect(buildContextCopyIndex).toBeGreaterThan(selectionCopyIndex);
    expect(dockerfile).not.toContain("/app/.openclaw-selected-plugin-dirs");
    expect(dockerfile).not.toContain("./.openclaw-selected-plugin-dirs");
    expect(dockerfile).toContain(
      'selected_plugin_dirs="$(cat /tmp/openclaw-selected-plugin-dirs)"',
    );
    expect(dockerfile).toContain('OPENCLAW_EXTENSIONS="$(cat /tmp/openclaw-selected-plugin-dirs)"');
  });

  it.each(["Dockerfile", "scripts/docker/cleanup-smoke/Dockerfile"])(
    "runs root lifecycle scripts from %s dependency inputs",
    async (dockerfileName) => {
      const dockerfile = collapseDockerContinuations(
        await readFile(join(repoRoot, dockerfileName), "utf8"),
      );
      const installIndex = dockerfile.indexOf("pnpm install --frozen-lockfile");
      expect(installIndex).toBeGreaterThan(-1);
      const fixture = await mkdtemp(join(tmpdir(), "openclaw-docker-lifecycle-"));
      try {
        // Stage the actual local COPY inputs, not a separately maintained import list.
        // Workspace manifests do not contribute executable root lifecycle modules.
        for (const [, sources, destination] of dockerfile
          .slice(0, installIndex)
          .matchAll(/^COPY ([^\n]+) (\.\/\S*)$/gm)) {
          if (!sources || !destination) {
            throw new Error("Expected local COPY sources and destination");
          }
          if (sources.startsWith("--")) {
            continue;
          }
          for (const input of sources.split(/\s+/)) {
            if (input !== "package.json" && !input.endsWith(".mjs")) {
              continue;
            }
            const target = join(
              fixture,
              destination.endsWith("/") ? join(destination, basename(input)) : destination,
            );
            await mkdir(dirname(target), { recursive: true });
            await cp(join(repoRoot, input), target);
          }
        }
        const packageJson = JSON.parse(await readFile(join(fixture, "package.json"), "utf8")) as {
          scripts: Record<string, string>;
        };
        const home = join(fixture, "home");
        await mkdir(home);
        for (const lifecycle of ["preinstall", "install", "postinstall", "prepare"]) {
          const command = packageJson.scripts[lifecycle];
          if (!command) {
            continue;
          }
          const scriptPath = command.match(/^node (scripts\/[^\s]+)$/)?.[1];
          if (!scriptPath) {
            throw new Error(`Unsupported root lifecycle command: ${command}`);
          }
          expect
            .soft(
              () =>
                execFileSync(resolveTestNodeExecPath(), [scriptPath], {
                  cwd: fixture,
                  env: {
                    HOME: home,
                    USERPROFILE: home,
                    PATH: process.env.PATH,
                    npm_config_user_agent: "pnpm/12",
                  },
                  stdio: "pipe",
                }),
              lifecycle,
            )
            .not.toThrow();
        }
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );

  it("normalizes plugin and agent paths permissions in image layers", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    expect(dockerfile).toContain(
      "RUN for dir in /app/${OPENCLAW_BUNDLED_PLUGIN_DIR} /app/.agent /app/.agents; do \\",
    );
    expect(dockerfile).toContain('find "$dir" -type d -exec chmod 755 {} +');
    expect(dockerfile).toContain('find "$dir" -type f -exec chmod 644 {} +');
  });

  it("counts primary pub keys before Docker apt fingerprint compare and dearmor", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    expect(dockerfile).toContain('== "fpr" {');
    expect(dockerfile).not.toContain('\\"fpr\\"');
    expect(dockerfile).toMatch(
      /curl -fsSL --connect-timeout 10 --max-time 120\s+https:\/\/download\.docker\.com\/linux\/debian\/gpg -o \/tmp\/docker\.gpg\.asc/u,
    );
    const anchor = dockerfile.indexOf(
      "https://download.docker.com/linux/debian/gpg -o /tmp/docker.gpg.asc",
    );
    expect(anchor).toBeGreaterThan(-1);
    const slice = dockerfile.slice(anchor);
    expect(slice).toContain("docker_gpg_pub_count=");
    expect(slice).toContain('$1 == "pub"');
    expect(slice).not.toContain('\\"pub\\"');
    const pubCountIdx = slice.indexOf("docker_gpg_pub_count=");
    const fpIdx = slice.indexOf("actual_fingerprint=");
    const dearmorIdx = slice.indexOf("gpg --dearmor");
    expect(pubCountIdx).toBeLessThan(fpIdx);
    expect(fpIdx).toBeLessThan(dearmorIdx);
    expect(slice).toContain('[ "$docker_gpg_pub_count" != "1" ]');
  });

  it("pre-creates named-volume mount points before switching to the node user", async () => {
    const dockerfile = await readFile(dockerfilePath, "utf8");
    const runtimeStageIndex = dockerfile.lastIndexOf("FROM base-runtime");
    const parentConfigDirIndex = dockerfile.indexOf(
      "RUN install -d -m 0755 -o node -g node /home/node/.config",
      runtimeStageIndex,
    );
    const stateDirIndex = dockerfile.indexOf(
      "install -d -m 0700 -o node -g node \\",
      parentConfigDirIndex,
    );
    const userIndex = dockerfile.indexOf("USER node", runtimeStageIndex);

    expect(runtimeStageIndex).toBeGreaterThan(-1);
    // Regression: /home/node/.config parent must be created with node ownership
    // before the leaf .config/openclaw dir (issue #85968).
    expect(parentConfigDirIndex).toBeGreaterThan(-1);
    expect(stateDirIndex).toBeGreaterThan(-1);
    expect(userIndex).toBeGreaterThan(-1);
    expect(parentConfigDirIndex).toBeGreaterThan(runtimeStageIndex);
    expect(parentConfigDirIndex).toBeLessThan(stateDirIndex);
    expect(stateDirIndex).toBeGreaterThan(runtimeStageIndex);
    expect(stateDirIndex).toBeLessThan(userIndex);
    expect(dockerfile).not.toContain("mkdir -p /home/node/.openclaw");
    expect(dockerfile).toContain("/home/node/.openclaw/workspace");
    expect(dockerfile).toContain("/home/node/.config/openclaw");
    expect(dockerfile).toContain(
      "stat -c '%U:%G %a' /home/node/.openclaw | grep -qx 'node:node 700'",
    );
    expect(dockerfile).toContain(
      "stat -c '%U:%G %a' /home/node/.openclaw/workspace | grep -qx 'node:node 700'",
    );
    // Regression: assert parent /home/node/.config is also node-owned (issue #85968).
    expect(dockerfile).toContain(
      "stat -c '%U:%G %a' /home/node/.config | grep -qx 'node:node 755'",
    );
    expect(dockerfile).toContain(
      "stat -c '%U:%G %a' /home/node/.config/openclaw | grep -qx 'node:node 700'",
    );
  });
});
