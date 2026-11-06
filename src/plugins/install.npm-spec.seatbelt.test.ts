import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerEnv } from "../infra/runtime-worker-url.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { resolveTestNodeExecPath } from "../test-utils/node-process.js";
import type { InstallPluginResult } from "./install.js";
import { startStaticRegistry, type RegistryPackage } from "./test-helpers/npm-registry-fixtures.js";

const tempDirs = createTempDirTracker();
const servers: http.Server[] = [];
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const pluginName = "openclaw-seatbelt-fixture";
const nativeName = "@openclaw-seatbelt/tool";
const platformName = "@openclaw-seatbelt/tool-platform";
const installerUrl = new URL("./install.ts", import.meta.url);

type DenialObservation = {
  path: string;
  access: string;
  execution: string;
  sha256: string;
  mode: number;
};
type InstallObservation = {
  result: InstallPluginResult;
  messages: string[];
  stages: DenialObservation[];
  runtime: {
    executable: string;
    version: string;
    platform: string;
    arch: string;
    installerSha256: string;
  };
};

const denialControlSource = `
  async function observeDenial(file) {
    const stat = await fs.stat(file);
    assert(stat.isFile() && (stat.mode & 0o111) !== 0);
    const sha256 = crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
    await assert.rejects(fs.access(file, constants.X_OK), { code: 'EPERM' });
    const execution = spawnSync(file, [], { encoding: 'utf8', timeout: 5000 });
    assert.equal(execution.error?.code, 'EPERM');
    assert(!execution.stdout?.includes('seatbelt-native-control'));
    return { path: file, access: 'EPERM', execution: execution.error.code, sha256, mode: stat.mode & 0o7777 };
  }
`;

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  tempDirs.cleanup();
});

function digest(bytes: Buffer | string) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

// Include binary bytes, permission bits, and link targets without following links.
async function snapshotTree(root: string) {
  const entries: Record<string, { mode: number; kind: string; content?: string }> = {};
  async function visit(relative: string): Promise<void> {
    const absolute = path.join(root, relative);
    const stat = await fs.lstat(absolute);
    const mode = stat.mode & 0o7777;
    if (stat.isSymbolicLink()) {
      entries[relative] = { mode, kind: "link", content: await fs.readlink(absolute) };
    } else if (stat.isFile()) {
      entries[relative] = { mode, kind: "file", content: digest(await fs.readFile(absolute)) };
    } else {
      assert(stat.isDirectory(), `Unexpected fixture file kind: ${absolute}`);
      entries[relative] = { mode, kind: "directory" };
      for (const name of (await fs.readdir(absolute)).toSorted()) {
        await visit(path.join(relative, name));
      }
    }
  }
  await visit("");
  return entries;
}

describe.runIf(process.platform === "darwin")("native npm staging under Seatbelt", () => {
  it(
    "updates a complete required native platform package while Seatbelt denies execution in the install stage",
    { timeout: 240_000 },
    async () => {
      const root = tempDirs.make("openclaw-seatbelt-npm-");
      const stateDir = path.join(root, "state");
      const projectsDir = path.join(stateDir, "npm", "projects");
      const controlStage = path.join(projectsDir, ".openclaw-install-stage-control");
      const archivesDir = path.join(root, "archives");
      const sourcesDir = path.join(root, "sources");
      await Promise.all([
        fs.mkdir(controlStage, { recursive: true }),
        fs.mkdir(archivesDir),
        fs.mkdir(sourcesDir),
        fs.writeFile(path.join(root, "user.npmrc"), ""),
        fs.writeFile(path.join(root, "global.npmrc"), ""),
      ]);
      // All state and npm policy/cache inputs belong to this fixture, not the runner user.
      const env = resolveRuntimeWorkerEnv(installerUrl, {
        ...process.env,
        HOME: root,
        OPENCLAW_HOME: root,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
        OPENCLAW_AGENT_DIR: undefined,
        OPENCLAW_NO_RESPAWN: "1",
        NODE_OPTIONS: undefined,
        TSX_DISABLE_CACHE: "1",
        VITEST: undefined,
        NO_COLOR: "1",
        NPM_CONFIG_USERCONFIG: path.join(root, "user.npmrc"),
        NPM_CONFIG_GLOBALCONFIG: path.join(root, "global.npmrc"),
        NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
      });
      const nodeExecutable = resolveTestNodeExecPath();
      for (const key of ["userconfig", "globalconfig", "cache"]) {
        env[`npm_config_${key}`] = env[`NPM_CONFIG_${key.toUpperCase()}`];
      }
      const signal = AbortSignal.timeout(180_000);
      const command = (argv: string[], sandbox = false) =>
        runCommandWithTimeout(
          sandbox ? ["/usr/bin/sandbox-exec", "-f", path.join(root, "stage.sb"), ...argv] : argv,
          {
            env,
            signal,
            cwd: root,
            timeoutMs: 45_000,
            killProcessTree: true,
            requireProcessTreeExtinction: true,
            maxCombinedOutputBytes: 256 * 1024,
            terminateOnOutputLimit: true,
          },
        );
      const succeeded = async (argv: string[], sandbox = false) => {
        const result = await command(argv, sandbox);
        expect(result.code, result.stdout + result.stderr).toBe(0);
        return result.stdout;
      };

      const checkout = (await succeeded(["git", "-C", repoRoot, "rev-parse", "HEAD"])).trim();
      const tree = (await succeeded(["git", "-C", repoRoot, "rev-parse", "HEAD^{tree}"])).trim();
      assert.match(checkout, /^[a-f0-9]{40}$/u);
      const completenessSourceSha256 = digest(
        await fs.readFile(path.join(repoRoot, "src/infra/npm-managed-root.ts")),
      );
      const nativeSource = path.join(root, "tool.c");
      const nativeBinary = path.join(root, "tool");
      await fs.writeFile(
        nativeSource,
        '#include <stdio.h>\nint main(void) { puts("seatbelt-native-control"); return 0; }\n',
      );
      await succeeded(["/usr/bin/xcrun", "clang", nativeSource, "-o", nativeBinary]);
      expect(await succeeded([nativeBinary])).toBe("seatbelt-native-control\n");
      const nativeDigest = digest(await fs.readFile(nativeBinary));
      const stagedBinary = path.join(controlStage, "tool");
      await fs.copyFile(nativeBinary, stagedBinary);
      const stagePattern = `^${projectsDir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}/\\.openclaw-install-stage-[^/]+/`;
      // Only this synthetic installer's temporary stage paths are denied execution.
      // Node, npm, the registry, compiler, and published generations remain outside it.
      await fs.writeFile(
        path.join(root, "stage.sb"),
        `(version 1)\n(allow default)\n(deny process-exec (regex ${JSON.stringify(stagePattern)}))\n`,
      );
      const denialControl = async () => {
        const output = await succeeded(
          [
            nodeExecutable,
            "--input-type=module",
            "-e",
            `import assert from 'node:assert/strict';
           import fs from 'node:fs/promises';
           import { constants } from 'node:fs';
           import { spawnSync } from 'node:child_process';
           import crypto from 'node:crypto';
           ${denialControlSource}
           console.log(JSON.stringify(await observeDenial(process.argv[1])));`,
            stagedBinary,
          ],
          true,
        );
        const observation: DenialObservation = JSON.parse(output);
        expect(observation.sha256).toBe(nativeDigest);
        return observation;
      };
      const beforeDenial = await denialControl();

      const versions = ["1.0.0", "2.0.0", "3.0.0"] as const;
      const pluginVersions: RegistryPackage["versions"] = [];
      const nativeVersions: RegistryPackage["versions"] = [];
      const pack = async (
        packageDir: string,
        packageName: string,
        version: string,
        metadata: RegistryPackage["versions"][number]["metadata"],
      ) => {
        await succeeded([
          "npm",
          "pack",
          "--ignore-scripts",
          "--pack-destination",
          archivesDir,
          packageDir,
        ]);
        const tarballName = `${packageName.replace(/^@/u, "").replaceAll("/", "-")}-${version}.tgz`;
        const archive = await fs.readFile(path.join(archivesDir, tarballName));
        return {
          archive,
          metadata,
          integrity: `sha512-${crypto.createHash("sha512").update(archive).digest("base64")}`,
          tarballName,
          version,
        };
      };
      for (const version of versions) {
        const pluginDir = path.join(sourcesDir, `plugin-${version}`);
        const pluginMetadata = {
          dependencies: { [nativeName]: version },
          optionalDependencies: { [platformName]: `npm:${nativeName}@${version}` },
          openclaw: {
            extensions: ["./dist/index.js"],
            install: { requiredPlatformPackages: [platformName] },
          },
        };
        await fs.mkdir(path.join(pluginDir, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(pluginDir, "package.json"),
          JSON.stringify({ name: pluginName, version, type: "module", ...pluginMetadata }),
        );
        await fs.writeFile(
          path.join(pluginDir, "openclaw.plugin.json"),
          JSON.stringify({ id: pluginName, configSchema: { type: "object" } }),
        );
        await fs.writeFile(path.join(pluginDir, "dist/index.js"), "export {};\n");
        pluginVersions.push(await pack(pluginDir, pluginName, version, pluginMetadata));
        const packageDir = path.join(sourcesDir, `native-${version}`);
        const metadata = {
          dependencies: {},
          os: ["darwin"],
          cpu: [process.arch],
          files: ["vendor", "bin"],
          bin: { tool: "bin/tool.js" },
        };
        await fs.mkdir(path.join(packageDir, "bin"), { recursive: true });
        await fs.writeFile(
          path.join(packageDir, "package.json"),
          JSON.stringify({ name: nativeName, version, ...metadata }),
        );
        await fs.writeFile(
          path.join(packageDir, "bin/tool.js"),
          "#!/usr/bin/env node\nprocess.exit(0);\n",
        );
        // ENOENT forces the old X_OK probe to reach the later regular-file binary.
        await fs.mkdir(path.join(packageDir, "vendor/a-incomplete/bin"), { recursive: true });
        await fs.writeFile(
          path.join(packageDir, "vendor/a-incomplete/bin/README"),
          "the native payload is absent from this target\n",
        );
        if (version !== "3.0.0") {
          const binDir = path.join(packageDir, "vendor", `z-${process.arch}-darwin`, "bin");
          await fs.mkdir(binDir, { recursive: true });
          await fs.copyFile(nativeBinary, path.join(binDir, "tool"));
        }
        nativeVersions.push(await pack(packageDir, nativeName, version, metadata));
      }
      const sourceBefore = await snapshotTree(sourcesDir);
      const archivesBefore = await snapshotTree(archivesDir);
      const registry = await startStaticRegistry(
        [
          { packageName: pluginName, latest: "2.0.0", versions: pluginVersions },
          { packageName: nativeName, latest: "2.0.0", versions: nativeVersions },
        ],
        servers,
      );
      env.NPM_CONFIG_REGISTRY = registry;
      env.npm_config_registry = registry;
      await fs.writeFile(env.OPENCLAW_CONFIG_PATH!, "{}\n");
      const install = async (version: string, sandbox = false): Promise<InstallObservation> => {
        const reportPath = path.join(root, `install-${version}.json`);
        const script = `
          import assert from 'node:assert/strict';
          import fs from 'node:fs/promises';
          import { constants } from 'node:fs';
          import path from 'node:path';
          import crypto from 'node:crypto';
          import { spawnSync } from 'node:child_process';
          import { installPluginFromNpmSpec } from ${JSON.stringify(installerUrl.href)};
          ${denialControlSource}
          const [version, reportPath, sandboxed] = JSON.parse(process.argv[1]);
          const messages = [], stages = [];
          const result = await installPluginFromNpmSpec({
            spec: ${JSON.stringify(pluginName)} + '@' + version,
            npmDir: ${JSON.stringify(path.join(stateDir, "npm"))},
            mode: version === '1.0.0' ? 'install' : 'update',
            expectedPluginId: ${JSON.stringify(pluginName)},
            timeoutMs: 30000,
            logger: { info: (message) => messages.push(message), warn: (message) => messages.push(message) },
            onBeforePluginArtifactCommit: sandboxed ? async ({ stagedArtifactDir }) => {
              // Independent OS control after completeness succeeds; it supplies no install decision.
              const npmRoot = path.resolve(stagedArtifactDir, '../..');
              const packageDir = path.join(npmRoot, 'node_modules', ${JSON.stringify(platformName)});
              const manifest = JSON.parse(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8'));
              assert.equal(manifest.name, ${JSON.stringify(nativeName)});
              assert(manifest.files.includes('vendor'));
              const lock = JSON.parse(await fs.readFile(path.join(npmRoot, 'package-lock.json'), 'utf8'));
              const platform = lock.packages['node_modules/' + ${JSON.stringify(platformName)}];
              assert.equal(platform.optional, true);
              assert(platform.os.includes('darwin') && platform.cpu.includes(process.arch));
              await assert.rejects(fs.stat(path.join(packageDir, 'vendor/a-incomplete/bin/tool')), { code: 'ENOENT' });
              stages.push(await observeDenial(path.join(packageDir, 'vendor', 'z-' + process.arch + '-darwin', 'bin/tool')));
            } : undefined,
          });
          const runtime = {
            executable: await fs.realpath(process.execPath), version: process.version,
            platform: process.platform, arch: process.arch,
            installerSha256: crypto.createHash('sha256').update(await fs.readFile(new URL(${JSON.stringify(installerUrl.href)}))).digest('hex'),
          };
          await fs.writeFile(reportPath, JSON.stringify({ result, messages, stages, runtime }));
        `;
        await succeeded(
          [
            nodeExecutable,
            ...resolveRuntimeWorkerArgv(installerUrl, nodeExecutable).slice(0, -1),
            "--input-type=module",
            "--eval",
            script,
            JSON.stringify([version, reportPath, sandbox]),
          ],
          sandbox,
        );
        return JSON.parse(await fs.readFile(reportPath, "utf8"));
      };
      const initial = await install("1.0.0");
      assert(initial.result.ok, JSON.stringify(initial));
      const original = initial.result;
      expect(original.version).toBe("1.0.0");
      const originalRoot = path.resolve(original.targetDir, "../..");
      const sentinel = path.join(originalRoot, "unrelated-source");
      await fs.writeFile(sentinel, "previous generation must remain intact\n", { mode: 0o640 });
      await fs.symlink("unrelated-source", path.join(originalRoot, "unrelated-link"));
      const originalBefore = await snapshotTree(originalRoot);

      const updated = await install("2.0.0", true);
      assert(updated.result.ok, JSON.stringify(updated));
      const updateOutput = updated.messages.join("\n");
      expect(updateOutput).toContain(`into ${projectsDir}/.openclaw-install-stage-`);
      expect(updateOutput).not.toContain("retrying once with a fresh cache");
      const replacement = updated.result;
      expect(replacement.version).toBe("2.0.0");
      expect(replacement.targetDir).not.toBe(original.targetDir);
      expect(updated.stages).toHaveLength(1);
      const stageObservation = updated.stages[0];
      assert(stageObservation);
      expect(stageObservation.path).toMatch(new RegExp(stagePattern));
      expect(stageObservation.sha256).toBe(nativeDigest);
      expect(updated.runtime.executable).not.toMatch(new RegExp(stagePattern));
      expect(updated.runtime.platform).toBe("darwin");
      expect(updated.runtime.arch).toBe(process.arch);
      // This entry publishes files, without the CLI's separate record-retirement write.
      // No new marker or other file may be silently excluded from the old project.
      expect(await snapshotTree(originalRoot)).toEqual(originalBefore);
      const replacementRoot = path.resolve(replacement.targetDir, "../..");
      const installedNative = path.join(
        replacementRoot,
        "node_modules",
        platformName,
        "vendor",
        `z-${process.arch}-darwin`,
        "bin/tool",
      );
      expect(digest(await fs.readFile(installedNative))).toBe(nativeDigest);
      expect((await fs.stat(installedNative)).mode & 0o111).not.toBe(0);
      const replacementBefore = await snapshotTree(replacementRoot);
      const projectsBefore = (await fs.readdir(projectsDir)).toSorted();
      const failure = await install("3.0.0", true);
      assert(!failure.result.ok, JSON.stringify(failure));
      const failureOutput = failure.messages.join("\n");
      expect(failureOutput.match(/retrying once with a fresh cache/gu)).toHaveLength(1);
      expect(failure.result.error).toContain(
        "npm install reported success but left required current-platform package(s) missing or incomplete",
      );
      expect(failure.stages).toEqual([]);
      expect(await fs.readdir(projectsDir).then((names) => names.toSorted())).toEqual(
        projectsBefore,
      );
      expect(projectsBefore.filter((name) => name.startsWith(".openclaw-install-stage-"))).toEqual([
        path.basename(controlStage),
      ]);
      expect(await snapshotTree(originalRoot)).toEqual(originalBefore);
      expect(await snapshotTree(replacementRoot)).toEqual(replacementBefore);
      expect(await snapshotTree(sourcesDir)).toEqual(sourceBefore);
      expect(await snapshotTree(archivesDir)).toEqual(archivesBefore);
      const afterDenial = await denialControl();
      expect(afterDenial).toEqual(beforeDenial);
      console.info(
        "Seatbelt native npm receipt",
        JSON.stringify({
          checkout,
          tree,
          completenessSourceSha256,
          installerSource: installerUrl.href,
          sourceRuntime: updated.runtime,
          platform: process.platform,
          arch: process.arch,
          runtime: process.version,
          fixtureSha256: nativeDigest,
          stagePattern,
          beforeDenial,
          afterDenial,
          original,
          replacement,
          stagedNative: stageObservation,
          missingPayloadError: failure.result.error,
          freshCacheRetryDiagnostics: failureOutput.match(/retrying once with a fresh cache/gu)
            ?.length,
          preservedOriginalSha256: digest(JSON.stringify(originalBefore)),
          preservedReplacementSha256: digest(JSON.stringify(replacementBefore)),
          fullBasePipeline: "not executed; original X_OK invariant fails in the OS control",
          packagedCli: "not exercised by this source installer fixture",
          latestStableUpgrade: "not exercised by this candidate-only fixture",
        }),
      );
    },
  );
});
