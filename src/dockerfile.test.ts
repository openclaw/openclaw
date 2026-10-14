// Tests Dockerfile metadata and expected install commands.
import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  cp,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUNDLED_PLUGIN_ROOT_DIR } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { isMap, parseAllDocuments } from "yaml";
import { useAutoCleanupTempDirTracker } from "../test/helpers/temp-dir.js";
import { assertArtifactTreeReadable } from "./shared/artifact-permissions.js";
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

  it.runIf(process.platform !== "win32").each([
    { bundledPluginDir: "extensions", fileMode: 0o664, directoryMode: 0o775 },
    { bundledPluginDir: "bundled-plugins", fileMode: 0o600, directoryMode: 0o700 },
  ])(
    "assembles public runtime payload with $bundledPluginDir and source mode $fileMode",
    async ({ bundledPluginDir, fileMode, directoryMode }) => {
      const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
      const stages = new Map(
        [...dockerfile.matchAll(/^FROM (\S+) AS (\S+)\n([\s\S]*?)(?=^FROM |(?![\s\S]))/gm)].map(
          ([, parent, name, body]) => [name, { parent, body }],
        ),
      );
      const production = stages.get("production-deps");
      expect(production?.parent).toBe("dependency-inputs");
      expect(stages.get("build")?.parent).toBe(production?.parent);
      const inputs = stages.get("dependency-inputs");
      expect(inputs?.parent).toBe("${OPENCLAW_NODE_BOOKWORM_IMAGE}");
      expect(inputs?.body).not.toMatch(/pnpm install|COPY \. \./);
      expect(production?.body).toContain("pnpm install --frozen-lockfile --prod");
      expect(production?.body).not.toMatch(/--ignore-scripts|COPY .*node_modules/);
      expect(dockerfile).not.toContain("pnpm prune");

      const runtimeStage = stages.get("runtime-assets");
      expect(runtimeStage?.parent).toBe("production-deps");
      const runtime = runtimeStage?.body ?? "";
      const buildCopy = runtime.match(/^COPY --from=(\S+) \/app\/ \.\/$/m);
      const buildOutput = stages.get(buildCopy?.[1]);
      expect(buildOutput?.parent).toBe("build");
      const cleanCommand = buildOutput?.body?.match(/^RUN (rm -rf node_modules[^\n]+)/m)?.[1];
      if (!cleanCommand) {
        throw new Error(
          "Runtime assembly must remove development dependencies before copying build output",
        );
      }
      expect(runtime.indexOf("node scripts/prune-docker-plugin-dist.mjs")).toBeGreaterThan(
        runtime.indexOf(buildCopy?.[0] ?? ""),
      );

      const fixture = await realpath(await mkdtemp(join(tmpdir(), "openclaw-docker-deps-")));
      try {
        const app = join(fixture, "app");
        const build = join(fixture, "build");
        const oldFiles = [
          "node_modules/dev-only/index.js",
          "ui/node_modules/dev-only/index.js",
          "packages/ai/node_modules/dev-only/index.js",
          `${bundledPluginDir}/selected/node_modules/dev-only/index.js`,
        ];
        const builtFiles = [
          "packages/ai/dist/index.mjs",
          "packages/ai/dist/launcher.cjs",
          "dist/index.js",
          "dist/control-ui/index.html",
          "dist/control-ui/assets/app.js",
          "dist/extensions/selected/dist/control-ui/index.js",
          "dist/extensions/selected/assets/help.txt",
          "packages/contract/src/index.ts",
          "node-runtime-env.mjs",
          ".runtime-bootstrap/scripts/runtime.mjs",
          "docs/reference/templates/AGENTS.md",
          "skills/demo/SKILL.md",
          "patches/dependency.patch",
          `${bundledPluginDir}/selected/index.js`,
        ];
        const prodFiles = [
          "node_modules/native-addon/addon.node",
          "node_modules/.modules.yaml",
          "node_modules/.pnpm-workspace-state-v1.json",
          "packages/ai/node_modules/runtime-dep/index.js",
          `${bundledPluginDir}/selected/node_modules/runtime-dep/index.js`,
          "pnpm-lock.yaml",
        ];
        for (const [root, files] of [
          [build, [...oldFiles, ...builtFiles]],
          [app, prodFiles],
        ] as const) {
          for (const file of files) {
            await mkdir(dirname(join(root, file)), { recursive: true });
            await writeFile(join(root, file), file);
          }
        }
        await writeFile(join(app, "package.json"), JSON.stringify({ version: "2026.8.1" }));
        const workspaceState = join(app, "node_modules/.pnpm-workspace-state-v1.json");
        await chmod(workspaceState, 0o600);
        const privateSource = join(app, ".npmrc");
        await writeFile(privateSource, "private-install-settings", { mode: 0o600 });
        const privateState = join(fixture, "home/node/.openclaw/config.json");
        await mkdir(dirname(privateState), { recursive: true, mode: 0o700 });
        await writeFile(privateState, "private-runtime-state", { mode: 0o600 });
        await writeFile(join(build, "package.json"), JSON.stringify({ version: "2026.8.1-1" }));
        execFileSync("/bin/sh", ["-eu", "-c", cleanCommand], {
          cwd: build,
          env: { ...process.env, OPENCLAW_BUNDLED_PLUGIN_DIR: bundledPluginDir },
        });
        await mkdir(join(app, "node_modules/@openclaw"), { recursive: true });
        await symlink("../../packages/ai", join(app, "node_modules/@openclaw/ai"));
        const aiManifest = JSON.parse(
          await readFile(join(repoRoot, "packages/ai/package.json"), "utf8"),
        ) as {
          dependencies: Record<string, string>;
        };
        const sdkNames = Object.keys(aiManifest.dependencies);
        const aiDir = join(app, "packages/ai");
        await writeFile(
          join(aiDir, "package.json"),
          JSON.stringify({
            name: "@openclaw/ai",
            main: "./dist/runtime-test.cjs",
            bin: { "runtime-test": "./dist/launcher.cjs" },
            dependencies: aiManifest.dependencies,
          }),
        );
        await writeFile(
          join(build, "packages/ai/dist/runtime-test.cjs"),
          `module.exports = Object.fromEntries(${JSON.stringify(sdkNames)}.map(name => [name, require(name)]));\n`,
        );
        const transitive = join(
          app,
          "node_modules/.pnpm/sdk-transitive@1.0.0/node_modules/sdk-transitive",
        );
        await mkdir(transitive, { recursive: true });
        await writeFile(
          join(transitive, "package.json"),
          JSON.stringify({ name: "sdk-transitive", main: "./index.cjs" }),
        );
        await writeFile(join(transitive, "index.cjs"), 'module.exports = "runtime-transitive";\n');
        for (const name of sdkNames) {
          const importerModules = join(
            app,
            "node_modules/.pnpm",
            `${name.replaceAll("/", "+")}@1.0.0`,
            "node_modules",
          );
          const owner = join(importerModules, name);
          await mkdir(owner, { recursive: true });
          await writeFile(
            join(owner, "package.json"),
            JSON.stringify({
              name,
              main: "./index.cjs",
              dependencies: { "sdk-transitive": "1.0.0" },
            }),
          );
          await writeFile(
            join(owner, "index.cjs"),
            'module.exports = require("sdk-transitive");\n',
          );
          const sdkLink = join(aiDir, "node_modules", name);
          await mkdir(dirname(sdkLink), { recursive: true });
          await symlink(posix.relative(dirname(sdkLink), owner), sdkLink);
          await symlink(
            posix.relative(importerModules, transitive),
            join(importerModules, "sdk-transitive"),
          );
        }
        const aggregateAi = join(app, "node_modules/.pnpm/node_modules/@openclaw/ai");
        await mkdir(dirname(aggregateAi), { recursive: true });
        await symlink(posix.relative(dirname(aggregateAi), aiDir), aggregateAi);
        await cp(build, app, { recursive: true, verbatimSymlinks: true });
        expect((await stat(privateSource)).mode & 0o777).toBe(0o600);
        expect(await readFile(privateSource, "utf8")).toBe("private-install-settings");
        for (const file of oldFiles) {
          await expect(access(join(app, file))).rejects.toThrow();
        }
        for (const file of [...builtFiles, ...prodFiles]) {
          expect(await readFile(join(app, file), "utf8")).toBe(file);
        }
        expect(await readFile(join(app, "node_modules/@openclaw/ai/dist/index.mjs"), "utf8")).toBe(
          "packages/ai/dist/index.mjs",
        );
        expect(JSON.parse(await readFile(join(app, "package.json"), "utf8"))).toEqual({
          version: "2026.8.1-1",
        });
        // Exercise any Docker-owned workspace relocation before the final COPY
        // projection. The former cp -a recipe moved pnpm's importer-relative links
        // to a different depth even though their SDK payloads remained installed.
        const materializeAi = runtime.match(
          /if \[ -L \/app\/node_modules\/@openclaw\/ai \]; then[\s\S]*?;\s*fi/u,
        )?.[0];
        if (materializeAi) {
          execFileSync(
            "/bin/sh",
            ["-eu", "-c", materializeAi.replaceAll("/app/", '"$OPENCLAW_TEST_APP"/')],
            { env: { ...process.env, OPENCLAW_TEST_APP: app } },
          );
        }
        const image = join(fixture, "image");
        await mkdir(image);
        const finalStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
        const copies = [
          ...finalStage.matchAll(
            /^COPY --from=runtime-assets --chown=node:node \/app\/(\S+) (\S+)$/gmu,
          ),
        ];
        for (const [, source, target] of copies) {
          if (!source || !target) {
            throw new Error("Docker runtime COPY must have a source and destination");
          }
          const sourcePath = source.replace("${OPENCLAW_BUNDLED_PLUGIN_DIR}", bundledPluginDir);
          const targetPath = target.replace("${OPENCLAW_BUNDLED_PLUGIN_DIR}", bundledPluginDir);
          try {
            await access(join(app, sourcePath));
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
              continue;
            }
            throw error;
          }
          await cp(
            join(app, sourcePath),
            join(image, targetPath === "." ? basename(sourcePath) : targetPath),
            {
              recursive: true,
              verbatimSymlinks: true,
              filter: () => true,
            },
          );
        }
        const launcher = join(image, "scripts/runtime.mjs");
        const declaredLauncher = join(image, "packages/ai/dist/launcher.cjs");
        // Docker COPY retains dependency hardlinks, unlike Node cp used by this fixture.
        const linkedLauncher = join(image, "packages/ai/dist/launcher-alias.cjs");
        await link(declaredLauncher, linkedLauncher);
        const launcherOwner = await stat(declaredLauncher);
        const entries = [
          image,
          ...(await readdir(image, { recursive: true })).map((file) => join(image, file)),
        ];
        const ownedEntries = [];
        for (const file of entries) {
          const entry = await lstat(file);
          if ((entry.isFile() || entry.isDirectory()) && (await realpath(file)) === file) {
            ownedEntries.push({ file, directory: entry.isDirectory() });
          }
        }
        // Execute the Docker-owned writer against the actual final COPY projection,
        // not an independently maintained payload list or helper-only imitation.
        const normalizeImage = finalStage.match(
          /node --input-type=module -e '([^']*normalize(?:GeneratedArtifactTree|ImageArtifactPermissions)[^']*)'/u,
        )?.[1];
        const normalize = () => {
          if (normalizeImage) {
            execFileSync(
              resolveTestNodeExecPath(),
              [
                "--input-type=module",
                "-e",
                normalizeImage
                  .replace(
                    "/permission-proof/src/shared/artifact-permissions.ts",
                    pathToFileURL(join(repoRoot, "src/shared/artifact-permissions.ts")).href,
                  )
                  .replace(
                    "/permission-proof/scripts/check-artifact-permissions.mts",
                    pathToFileURL(join(repoRoot, "scripts/check-artifact-permissions.mts")).href,
                  ),
              ],
              { cwd: image },
            );
          }
        };
        for (const generation of ["cold", "warm"]) {
          await unlink(linkedLauncher);
          await link(declaredLauncher, linkedLauncher);
          for (const { file, directory } of ownedEntries) {
            await chmod(file, file === image ? 0o755 : directory ? directoryMode : fileMode);
          }
          await chmod(launcher, fileMode | 0o100);
          normalize();
          // This source-owned document is copied unchanged by the real image recipe;
          // fail on its retained mode rather than an artificial work-directory mode.
          expect((await stat(join(image, "docs/reference/templates/AGENTS.md"))).mode & 0o777).toBe(
            0o644,
          );
          for (const { file, directory } of ownedEntries) {
            expect((await stat(file)).mode & 0o7777, `${generation}: ${file}`).toBe(
              directory || file === launcher || file === declaredLauncher ? 0o755 : 0o644,
            );
          }
          for (const file of [declaredLauncher, linkedLauncher]) {
            expect(await stat(file)).toMatchObject({
              nlink: 1,
              uid: launcherOwner.uid,
              gid: launcherOwner.gid,
            });
          }
          expect(await readFile(linkedLauncher, "utf8")).toBe("packages/ai/dist/launcher.cjs");
          expect(() =>
            assertArtifactTreeReadable(image, {
              allowLinksWithin: image,
              executableFiles: ["scripts/runtime.mjs", "packages/ai/dist/launcher.cjs"],
              readFiles: true,
            }),
          ).not.toThrow();
        }
        const alias = join(image, "private-alias");
        for (const kind of ["symlink", "hardlink"]) {
          if (kind === "symlink") {
            await symlink(privateState, alias);
          } else {
            await link(privateState, alias);
          }
          await chmod(image, 0o700);
          expect(normalize, kind).toThrow(/closure|exclusively owned/u);
          expect((await stat(image)).mode & 0o777).toBe(0o700);
          expect((await stat(privateState)).mode & 0o777).toBe(0o600);
          await unlink(alias);
        }
        normalize();
        await expect(access(join(image, ".npmrc"))).rejects.toThrow();
        for (const [file, bytes] of [
          [privateSource, "private-install-settings"],
          [privateState, "private-runtime-state"],
        ] as const) {
          expect(await readFile(file, "utf8")).toBe(bytes);
          expect((await stat(file)).mode & 0o777).toBe(0o600);
        }
        expect((await stat(dirname(privateState))).mode & 0o777).toBe(0o700);
        expect((await stat(workspaceState)).mode & 0o777).toBe(0o600);
        for (const file of builtFiles.filter((entry) => !entry.startsWith(".runtime-bootstrap/"))) {
          expect(await readFile(join(image, file), "utf8")).toBe(file);
        }
        expect(await readFile(launcher, "utf8")).toBe(".runtime-bootstrap/scripts/runtime.mjs");
        const requireFromImage = createRequire(join(image, "package.json"));
        expect(requireFromImage("@openclaw/ai")).toEqual(
          Object.fromEntries(sdkNames.map((name) => [name, "runtime-transitive"])),
        );
        expect(await realpath(join(image, "node_modules/@openclaw/ai"))).toBe(
          await realpath(join(image, "node_modules/.pnpm/node_modules/@openclaw/ai")),
        );
        expect(() =>
          assertArtifactTreeReadable(join(image, "node_modules"), {
            allowLinksWithin: image,
            readFiles: true,
          }),
        ).not.toThrow();
      } finally {
        await rm(fixture, { recursive: true, force: true });
      }
    },
  );

  it("keeps the final proof identity inside ordinary rootless UID/GID mappings", async () => {
    const dockerfile = collapseDockerContinuations(await readFile(dockerfilePath, "utf8"));
    const acceptance = dockerfile.indexOf(" --root /app --image --read-files");
    expect(acceptance).toBeGreaterThan(-1);
    const user = [...dockerfile.slice(0, acceptance).matchAll(/^USER (.+)$/gmu)].at(-1)?.[1];
    const identity = user?.match(/^(\d+):(\d+)$/u);
    expect(identity, "read-only acceptance must use an unrelated numeric identity").toBeDefined();
    // Rootless engines commonly map container root plus 65,536 subordinate IDs.
    // The controlled release matrix separately exercises OpenShift-style high IDs.
    for (const value of identity?.slice(1) ?? []) {
      const id = Number(value);
      expect(id).toBeGreaterThan(0);
      expect(id).not.toBe(1000);
      expect(id).toBeLessThan(65_536);
    }
  });

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
