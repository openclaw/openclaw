// Release Check tests cover release check script behavior.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { create } from "tar";
import { describe, expect, vi } from "vitest";
import { parse } from "yaml";
import {
  collectRootPackageExcludedExtensionDirs,
  listBundledPluginPackArtifacts,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import {
  checkPackedTargetBootstrap,
  createPackedTarballInstallArgs,
  prepareReleaseCheckLocalPackageTarballs,
  RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV,
  resolvePackedBundledChannelEntrySmokeCommand,
  resolveReleaseCheckLocalPackageTarballs,
  writePackedTarballInstallManifest,
  writePackedBundledPluginActivationConfig,
} from "../../scripts/release-check.ts";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";

const it = createCommandTest();

const legacyWorkerContract =
  'export const WORKER_BUNDLE_ENTRY_PATH = "worker.mjs";\n' +
  'export const WORKER_BUNDLE_RSYNC_RECEIVER_PATH = "workspace-rsync-receiver.mjs";\n';
const launcherWorkerContract =
  legacyWorkerContract +
  'export const WORKER_BUNDLE_GITHUB_EXEC_LAUNCHER_PATH = "github-exec-launcher.mjs";\n';
const currentWorkerContract =
  'export const WORKER_BUNDLE_ARTIFACT_PATHS = ["github-exec-launcher.mjs", "service-child-group-anchor.mjs", "service-child-relay.mjs", "worker.mjs", "workspace-rsync-receiver.mjs"];\n';
const legacyArtifacts = ["worker.mjs", "workspace-rsync-receiver.mjs"];
const currentArtifacts = [
  "github-exec-launcher.mjs",
  "service-child-group-anchor.mjs",
  "service-child-relay.mjs",
  "worker.mjs",
  "workspace-rsync-receiver.mjs",
];

function createPackedTargetFixture(command: CommandFixture) {
  const root = command.createTempDir("openclaw-release-check-target-");
  const packageJson = JSON.stringify({ name: "openclaw", version: "2026.9.1", files: ["dist"] });
  const packedRoot = join(root, "package");
  const packedFiles = {
    "package.json": packageJson,
    "dist/entry.js": 'import "./cli/run-main.js";',
    "dist/cli/run-main.js": "export {};",
    "dist/run-gateway.js": "const GATEWAY_AUTH_MODES = []; function addGatewayRunCommand() {}",
  };
  for (const [relativePath, source] of Object.entries(packedFiles)) {
    const destination = join(packedRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, source);
  }
  mkdirSync(join(root, "scripts/lib"), { recursive: true });
  mkdirSync(join(root, "src/shared"), { recursive: true });
  mkdirSync(join(root, "src/worker"), { recursive: true });
  writeFileSync(join(root, "package.json"), packageJson);
  writeFileSync(join(root, "src/worker/worker-deploy-entry.ts"), "export {};\n");
  return { root, packedRoot, packedFiles };
}

function writeWorkerArtifacts(packedRoot: string, artifacts: string[]) {
  const workerRoot = join(packedRoot, "dist/worker");
  mkdirSync(workerRoot, { recursive: true });
  for (const artifact of artifacts) {
    writeFileSync(join(workerRoot, artifact), "export {};");
  }
}

function requirePluginEntries(config: { plugins?: { entries?: Record<string, unknown> } }) {
  if (!config.plugins?.entries) {
    throw new Error("Expected plugin entries in packaged activation config");
  }
  return config.plugins.entries;
}

describe("release-check", () => {
  it("runs the current TypeScript bundled channel smoke when the target provides it", () => {
    expect(
      resolvePackedBundledChannelEntrySmokeCommand(
        (path) => path.endsWith("test-built-bundled-channel-entry-smoke.mts"),
        "/runtime/node",
      ),
    ).toEqual({
      command: "/runtime/node",
      args: ["--import", "tsx", "scripts/test-built-bundled-channel-entry-smoke.mts"],
    });
  });

  it("runs the frozen JavaScript bundled channel smoke when that is the target contract", () => {
    expect(
      resolvePackedBundledChannelEntrySmokeCommand(
        (path) => path.endsWith("test-built-bundled-channel-entry-smoke.mjs"),
        "/runtime/node",
      ),
    ).toEqual({
      command: "/runtime/node",
      args: ["scripts/test-built-bundled-channel-entry-smoke.mjs"],
    });
  });

  it("fails closed when the target provides no bundled channel smoke entrypoint", () => {
    expect(() => resolvePackedBundledChannelEntrySmokeCommand(() => false)).toThrow(
      "release-check: target does not provide scripts/test-built-bundled-channel-entry-smoke.mts or .mjs",
    );
  });

  it("loads sparse release tooling and rejects a tarball missing a target worker artifact", async ({
    command,
  }) => {
    const diagnostics = command.enableDiagnostics("release-check-target");
    await command.lifetime.run(async () => {
      const { root, packedRoot } = createPackedTargetFixture(command);
      const toolingRoot = join(root, "tooling");
      const workflow = parse(readFileSync(".github/workflows/openclaw-npm-preflight.yml", "utf8"));
      const checkout = workflow.jobs.check_contents_npm.steps.find(
        (step: { name?: string }) => step.name === "Checkout trusted Plugin SDK API tooling",
      );
      const sparseRoots = checkout.with["sparse-checkout"].trim().split(/\s+/u) as string[];
      diagnostics.stage("sparse-inventory");
      const tracked = await command.run(
        "git",
        ["ls-files", "-z", "--", ":(top,glob)*", ...sparseRoots],
        { maxBuffer: 10 * 1024 * 1024 },
      );
      expect(tracked.error, "sparse tooling file inventory").toBeUndefined();
      expect(tracked.status, tracked.stderr).toBe(0);
      const trackedPaths = tracked.stdout.split("\0").filter(Boolean);
      diagnostics.stage("runtime-import-closure");
      // Preserve the workflow's sparse boundary without copying the whole source tree.
      const requiredPaths = new Set([
        ...collectRuntimeImportClosure(process.cwd(), [
          "scripts/release-check.ts",
          "scripts/tsx.mjs",
          ...(process.versions.bun ? ["src/plugins/sdk-alias.ts"] : []),
        ]),
        "scripts/fixtures/packed-plugin-sdk-type-smoke.ts",
        "scripts/fixtures/packed-plugin-sdk-setup-consumer.ts",
        "scripts/fixtures/packed-plugin-sdk-progress-consumer.ts",
        ...(process.versions.bun
          ? ["scripts/lib/plugin-sdk-private-local-only-subpaths.json"]
          : []),
      ]);
      expect(requiredPaths.has("scripts/package-openclaw-for-docker.mts")).toBe(false);
      expect(requiredPaths.has("scripts/openclaw-prepack.ts")).toBe(false);
      const sparsePaths = new Set(trackedPaths);
      expect(
        [...requiredPaths].filter((file) => !sparsePaths.has(file)),
        "release tooling dependencies must belong to the workflow sparse checkout",
      ).toEqual([]);
      diagnostics.stage("sparse-copy");
      for (const relativePath of trackedPaths.filter(
        (file) => !file.includes("/") || requiredPaths.has(file),
      )) {
        const destination = join(toolingRoot, relativePath);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(relativePath, destination);
      }
      symlinkSync(resolve("node_modules"), join(toolingRoot, "node_modules"), "junction");
      mkdirSync(join(root, "extensions"));
      mkdirSync(join(root, "scripts", "fixtures"), { recursive: true });
      writeFileSync(
        join(root, "scripts/fixtures/packed-plugin-sdk-type-smoke.ts"),
        "stale target fixture",
      );
      writeFileSync(
        join(root, "scripts/fixtures/packed-plugin-sdk-setup-consumer.ts"),
        "stale target setup consumer",
      );
      const moduleUrl = pathToFileURL(join(toolingRoot, "scripts/release-check.ts")).href;
      const npmInventoryGuard = join(root, "reject-npm-inventory.cjs");
      writeFileSync(
        npmInventoryGuard,
        `const childProcess = require("node:child_process");
const original = childProcess.execFileSync;
childProcess.execFileSync = function (...args) {
  if (Array.isArray(args[1]) && args[1].includes("pack") && args[1].includes("--dry-run")) {
    throw new Error("Prepared tarball inspection must not launch npm pack");
  }
  return Reflect.apply(original, this, args);
};
require("node:module").syncBuiltinESMExports();
`,
      );
      const runtimeArgs = process.versions.bun
        ? []
        : [...resolveVitestNodeArgs(), "--import", join(toolingRoot, "scripts/tsx.mjs")];
      const fixtureEnv = {
        ...process.env,
        TSX_TSCONFIG_PATH: join(toolingRoot, "tsconfig.json"),
      };
      diagnostics.stage("sparse-import-probe");
      const probe = await command.run(
        process.execPath,
        [
          ...runtimeArgs,
          "--input-type=module",
          "--eval",
          `import { readFileSync } from "node:fs";\n` +
            `const { createPackedPluginSdkTypescriptSmokeProject } = await import(${JSON.stringify(moduleUrl)});\n` +
            `createPackedPluginSdkTypescriptSmokeProject({ consumerDir: "consumer", packageSpec: "file:fixture.tgz" });\n` +
            `console.log(JSON.stringify({\n` +
            `  execArgv: process.execArgv,\n` +
            `  fixture: readFileSync("consumer/src/index.ts", "utf8"),\n` +
            `  setupConsumer: readFileSync("consumer/src/packed-plugin-sdk-setup-consumer.ts", "utf8")\n` +
            `}));`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: fixtureEnv,
        },
      );
      expect(probe.error, "sparse release tooling import").toBeUndefined();
      expect(probe.status, probe.stderr).toBe(0);
      const { execArgv, ...smokeProject } = JSON.parse(probe.stdout);
      if (!process.versions.bun) {
        expect(execArgv, "CLI fixtures inherit the Node shutdown policy").toContain(
          "--no-concurrent-sparkplug",
        );
      }
      expect(smokeProject).toEqual({
        fixture: readFileSync(
          join(toolingRoot, "scripts/fixtures/packed-plugin-sdk-type-smoke.ts"),
          "utf8",
        ),
        setupConsumer: readFileSync(
          join(toolingRoot, "scripts/fixtures/packed-plugin-sdk-setup-consumer.ts"),
          "utf8",
        ),
      });

      diagnostics.stage("packed-fixture-setup");
      copyFileSync("appcast.xml", join(root, "appcast.xml"));
      writeFileSync(join(root, "src/shared/worker-bundle-hash.ts"), launcherWorkerContract);
      writeWorkerArtifacts(packedRoot, legacyArtifacts);
      const tarball = join(root, "target.tgz");
      create({ cwd: root, file: tarball, gzip: true, sync: true }, ["package"]);
      if (!process.versions.bun) {
        runtimeArgs.unshift("--require", npmInventoryGuard);
      }
      diagnostics.stage("legacy three-file contract requires the launcher");
      const result = await command.run(
        process.execPath,
        [...runtimeArgs, join(toolingRoot, "scripts/release-check.ts"), "--tarball", tarball],
        { cwd: root, encoding: "utf8", env: fixtureEnv },
      );
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Worker deploy artifact dist/worker/github-exec-launcher.mjs is missing.",
      );
      expect(result.stderr).not.toContain("Packing OpenClaw package");
      diagnostics.stage("assertions-complete");
    });
  });

  it("packs an isolated bundled source through the canonical owner before inspecting it", async ({
    command,
  }) => {
    await command.lifetime.run(async () => {
      const { root, packedFiles } = createPackedTargetFixture(command);
      const packageJson = JSON.stringify({
        name: "openclaw",
        version: "2026.9.1",
        packageManager: JSON.parse(readFileSync("package.json", "utf8")).packageManager,
        files: ["dist"],
        dependencies: { "fixture-runtime": "1.0.0" },
        bundleDependencies: ["fixture-runtime"],
        scripts: {
          "update:compat:check":
            "node -e \"require('node:fs').writeFileSync('compat-checked', 'yes')\"",
        },
      });
      for (const [relativePath, contents] of Object.entries({
        ...packedFiles,
        "dist/index.js": "export {};",
        "dist/control-ui/index.html": "<html></html>",
        "dist/control-ui/assets/app.js.br": "prepared Brotli fixture",
      })) {
        if (relativePath === "package.json") {
          continue;
        }
        const destination = join(root, relativePath);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, contents);
      }
      writeFileSync(join(root, "package.json"), packageJson);
      // Match the prepared source: scripts must not reconcile its existing install.
      expect(parse(readFileSync("pnpm-workspace.yaml", "utf8"))).toMatchObject({
        nodeLinker: "isolated",
        verifyDepsBeforeRun: false,
      });
      writeFileSync(
        join(root, "pnpm-workspace.yaml"),
        "nodeLinker: isolated\nverifyDepsBeforeRun: false\n",
      );
      const changelog =
        "# Changelog\n\n## 2026.9.1\n\n- Preserve the prepared bundled runtime package and source files.\n";
      writeFileSync(join(root, "CHANGELOG.md"), changelog);
      copyFileSync("appcast.xml", join(root, "appcast.xml"));
      mkdirSync(join(root, "extensions"));
      mkdirSync(join(root, "node_modules/fixture-runtime"), { recursive: true });
      writeFileSync(
        join(root, "node_modules/fixture-runtime/package.json"),
        JSON.stringify({ name: "fixture-runtime", version: "1.0.0" }),
      );
      symlinkSync(
        dirname(fileURLToPath(import.meta.resolve("tsx/package.json"))),
        join(root, "node_modules/tsx"),
        "junction",
      );
      const inventoryUrl = pathToFileURL(resolve("scripts/lib/package-dist-inventory.ts")).href;
      writeFileSync(
        join(root, "scripts/write-package-dist-inventory.ts"),
        `import(${JSON.stringify(inventoryUrl)}).then(({ writePackageDistInventoryForPublish }) => writePackageDistInventoryForPublish(process.cwd()));\n`,
      );
      writeFileSync(join(root, "src/shared/worker-bundle-hash.ts"), launcherWorkerContract);
      writeWorkerArtifacts(root, legacyArtifacts);
      const runtimeArgs = process.versions.bun
        ? []
        : [...resolveVitestNodeArgs(), "--import", resolve("scripts/tsx.mjs")];
      const runReleaseCheck = () =>
        command.run(process.execPath, [...runtimeArgs, resolve("scripts/release-check.ts")], {
          cwd: root,
          env: { ...process.env, TSX_TSCONFIG_PATH: resolve("tsconfig.json") },
        });
      const unprepared = await runReleaseCheck();
      expect(unprepared.error).toBeUndefined();
      expect(unprepared.status).toBe(1);
      expect(unprepared.stderr).toContain("missing prepared Control UI .gz asset");
      expect(unprepared.stderr).not.toContain("Packing OpenClaw package");

      writeFileSync(join(root, "dist/control-ui/assets/app.js.gz"), "prepared gzip fixture");
      const result = await runReleaseCheck();
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Packing OpenClaw package");
      expect(result.stderr).toContain(
        "Worker deploy artifact dist/worker/github-exec-launcher.mjs is missing.",
      );
      expect(result.stderr).not.toContain("ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED");
      expect(readFileSync(join(root, "compat-checked"), "utf8")).toBe("yes");
      expect(readFileSync(join(root, "package.json"), "utf8")).toBe(packageJson);
      expect(readFileSync(join(root, "CHANGELOG.md"), "utf8")).toBe(changelog);
      expect(existsSync(join(root, "dist/postinstall-inventory.json"))).toBe(true);
    });
  });

  it("checks target worker and gateway contracts against prepared output", async ({ command }) => {
    const diagnostics = command.enableDiagnostics("release-check-contracts");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cases = [
        {
          name: "legacy two-file worker contract",
          workerContract: legacyWorkerContract,
          artifacts: legacyArtifacts,
          declaresLocator: false,
          includesLocator: false,
          expected: undefined,
        },
        {
          name: "current array overrides obsolete individual paths",
          workerContract:
            currentWorkerContract +
            'export const WORKER_BUNDLE_OBSOLETE_PATH = "../obsolete.mjs";\n',
          artifacts: currentArtifacts,
          declaresLocator: false,
          includesLocator: false,
          expected: undefined,
        },
        {
          name: "legacy three-file contract requires the launcher",
          workerContract: launcherWorkerContract,
          artifacts: legacyArtifacts,
          declaresLocator: false,
          includesLocator: false,
          expected: "Worker deploy artifact dist/worker/github-exec-launcher.mjs is missing.",
        },
        {
          name: "legacy three-file worker contract",
          workerContract: launcherWorkerContract,
          artifacts: ["github-exec-launcher.mjs", ...legacyArtifacts],
          declaresLocator: false,
          includesLocator: false,
          expected: undefined,
        },
        ...["service-child-group-anchor.mjs", "service-child-relay.mjs"].map((missingArtifact) => ({
          name: `current array requires ${missingArtifact}`,
          workerContract: currentWorkerContract,
          artifacts: currentArtifacts.filter((artifact) => artifact !== missingArtifact),
          declaresLocator: false,
          includesLocator: false,
          expected: `Worker deploy artifact dist/worker/${missingArtifact} is missing.`,
        })),
        {
          name: "target locator declaration requires packed metadata",
          workerContract: legacyWorkerContract,
          artifacts: legacyArtifacts,
          declaresLocator: true,
          includesLocator: false,
          expected: "could not read gateway run chunk metadata",
        },
        {
          name: "target locator resolves packed metadata",
          workerContract: legacyWorkerContract,
          artifacts: legacyArtifacts,
          declaresLocator: true,
          includesLocator: true,
          expected: undefined,
        },
      ];
      for (const {
        name,
        workerContract,
        artifacts,
        declaresLocator,
        includesLocator,
        expected,
      } of cases) {
        diagnostics.stage(name);
        // Separate targets keep module caches from reusing another frozen release's declarations.
        const { root, packedRoot, packedFiles } = createPackedTargetFixture(command);
        writeWorkerArtifacts(packedRoot, artifacts);
        writeFileSync(join(root, "src/shared/worker-bundle-hash.ts"), workerContract);
        if (declaresLocator) {
          writeFileSync(
            join(root, "scripts/lib/gateway-run-chunk-metadata.mts"),
            "export const GATEWAY_RUN_CHUNK_METADATA_VERSION = 1;",
          );
        }
        if (includesLocator) {
          writeFileSync(
            join(packedRoot, "dist/cli/gateway-run-chunk.json"),
            JSON.stringify({
              version: 1,
              chunks: [
                {
                  fileName: "run-gateway.js",
                  sha256: createHash("sha256")
                    .update(packedFiles["dist/run-gateway.js"])
                    .digest("hex"),
                },
              ],
            }),
          );
        }
        errors.mockClear();
        if (expected) {
          await expect(checkPackedTargetBootstrap(root, packedRoot), name).rejects.toThrow();
          expect(errors.mock.calls.flat().join("\n"), name).toContain(expected);
        } else {
          await expect(checkPackedTargetBootstrap(root, packedRoot), name).resolves.toBeUndefined();
          expect(errors, name).not.toHaveBeenCalled();
        }
      }
      const invalidContracts = [
        {
          source: 'export const WORKER_BUNDLE_ENTRY_PATH = "";\n',
          expected:
            "release-check: target worker artifact WORKER_BUNDLE_ENTRY_PATH must be a non-empty path string.",
        },
        {
          source: 'export const WORKER_BUNDLE_ENTRY_PATH = "../worker/main.mjs";\n',
          expected:
            "release-check: target worker artifact WORKER_BUNDLE_ENTRY_PATH must be a normalized relative path within dist/worker.",
        },
        ...["undefined", "[]"].map((value) => ({
          source: legacyWorkerContract + `export const WORKER_BUNDLE_ARTIFACT_PATHS = ${value};\n`,
          expected: "release-check: target WORKER_BUNDLE_ARTIFACT_PATHS must be a non-empty array.",
        })),
        {
          source: 'export const WORKER_BUNDLE_ARTIFACT_PATHS = ["worker.mjs", ""];\n',
          expected:
            "release-check: target worker artifact WORKER_BUNDLE_ARTIFACT_PATHS[1] must be a non-empty path string.",
        },
        {
          source:
            'export const WORKER_BUNDLE_ARTIFACT_PATHS = ["worker.mjs", "../worker/main.mjs"];\n',
          expected:
            "release-check: target worker artifact WORKER_BUNDLE_ARTIFACT_PATHS[1] must be a normalized relative path within dist/worker.",
        },
        {
          source: "export const OTHER_PATH = 1;\n",
          expected:
            "release-check: target worker producer is missing WORKER_BUNDLE_*_PATH declarations.",
        },
      ];
      for (const [index, { source, expected }] of invalidContracts.entries()) {
        diagnostics.stage(`invalid-worker-contract-${index}`);
        const { root, packedRoot } = createPackedTargetFixture(command);
        writeFileSync(join(root, "src/shared/worker-bundle-hash.ts"), source);
        await expect(checkPackedTargetBootstrap(root, packedRoot), source).rejects.toThrow(
          expected,
        );
      }

      // Shared hash helpers alone do not impose a worker contract on historical targets.
      diagnostics.stage("target-without-worker-producer");
      const { root, packedRoot } = createPackedTargetFixture(command);
      writeFileSync(
        join(root, "src/shared/worker-bundle-hash.ts"),
        "export const WORKER_BUNDLE_ARTIFACT_PATHS = [];\n",
      );
      rmSync(join(root, "src/worker/worker-deploy-entry.ts"));
      errors.mockClear();
      await expect(checkPackedTargetBootstrap(root, packedRoot)).resolves.toBeUndefined();
      expect(errors).not.toHaveBeenCalled();
      diagnostics.stage("assertions-complete");
    } finally {
      errors.mockRestore();
    }
  });

  it("installs the prepared tarball with its real package lifecycle", () => {
    expect(createPackedTarballInstallArgs("/tmp/prefix")).toEqual([
      "install",
      "--prefix",
      "/tmp/prefix",
      "--no-audit",
      "--no-fund",
    ]);
  });

  it("resolves prepacked publishable core package tarballs", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-tarball-test-"));
    try {
      writeFileSync(join(root, "openclaw-ai-2026.6.33.tgz"), "fixture");
      writeFileSync(join(root, "openclaw-gateway-client-2026.6.33.tgz"), "fixture");
      writeFileSync(join(root, "openclaw-gateway-protocol-2026.6.33.tgz"), "fixture");
      writeFileSync(join(root, "SHA256SUMS"), "fixture");
      expect(resolveReleaseCheckLocalPackageTarballs(root)).toEqual([
        join(root, "openclaw-ai-2026.6.33.tgz"),
        join(root, "openclaw-gateway-client-2026.6.33.tgz"),
        join(root, "openclaw-gateway-protocol-2026.6.33.tgz"),
      ]);
      expect(resolveReleaseCheckLocalPackageTarballs(undefined)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts gateway core packages when the root does not require AI", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-tarball-test-"));
    try {
      const gatewayTarball = join(root, "openclaw-gateway-protocol-2026.7.2.tgz");
      const gatewayClientTarball = join(root, "openclaw-gateway-client-2026.7.2.tgz");
      writeFileSync(gatewayTarball, "fixture");
      writeFileSync(gatewayClientTarball, "fixture");
      expect(resolveReleaseCheckLocalPackageTarballs(root, false)).toEqual([
        gatewayClientTarball,
        gatewayTarball,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes an explicit local project for unpublished core package tarballs", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-install-test-"));
    try {
      writePackedTarballInstallManifest(root, "/tmp/openclaw.tgz", [
        "/tmp/openclaw-ai.tgz",
        "/tmp/openclaw-gateway-client.tgz",
        "/tmp/openclaw-gateway-protocol.tgz",
      ]);
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
        private?: boolean;
      };
      expect(manifest.private).toBe(true);
      expect(manifest.dependencies).toEqual({
        "@openclaw/ai": "file:///tmp/openclaw-ai.tgz",
        "@openclaw/gateway-client": "file:///tmp/openclaw-gateway-client.tgz",
        "@openclaw/gateway-protocol": "file:///tmp/openclaw-gateway-protocol.tgz",
        openclaw: "file:///tmp/openclaw.tgz",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a gateway-packages-only local project when the root does not require AI", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-install-test-"));
    try {
      writePackedTarballInstallManifest(
        root,
        "/tmp/openclaw.tgz",
        ["/tmp/openclaw-gateway-client.tgz", "/tmp/openclaw-gateway-protocol.tgz"],
        false,
      );
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      };
      expect(manifest.dependencies).toEqual({
        "@openclaw/gateway-client": "file:///tmp/openclaw-gateway-client.tgz",
        "@openclaw/gateway-protocol": "file:///tmp/openclaw-gateway-protocol.tgz",
        openclaw: "file:///tmp/openclaw.tgz",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("packs the local AI workspace when no prepared tarball is supplied", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-ai-pack-test-"));
    try {
      const tarballs = prepareReleaseCheckLocalPackageTarballs({
        tmpRoot: root,
        packLocalAi: (packDestination) => {
          const filename = "openclaw-ai-2026.7.1-beta.3.tgz";
          writeFileSync(join(packDestination, filename), "fixture");
          return [{ filename }];
        },
      });
      expect(tarballs).toEqual([join(root, "ai-pack", "openclaw-ai-2026.7.1-beta.3.tgz")]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prefers prepared core package tarballs over packing the AI workspace", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-ai-pack-test-"));
    try {
      const preparedDir = join(root, "prepared");
      mkdirSync(preparedDir);
      const preparedTarball = join(preparedDir, "openclaw-ai-2026.7.1-beta.3.tgz");
      const gatewayProtocolTarball = join(
        preparedDir,
        "openclaw-gateway-protocol-2026.7.1-beta.3.tgz",
      );
      const gatewayClientTarball = join(preparedDir, "openclaw-gateway-client-2026.7.1-beta.3.tgz");
      writeFileSync(preparedTarball, "fixture");
      writeFileSync(gatewayClientTarball, "fixture");
      writeFileSync(gatewayProtocolTarball, "fixture");
      const tarballs = prepareReleaseCheckLocalPackageTarballs({
        tmpRoot: root,
        tarballDir: preparedDir,
        packLocalAi: () => {
          throw new Error("workspace pack should not run");
        },
      });
      expect(tarballs).toEqual([preparedTarball, gatewayClientTarball, gatewayProtocolTarball]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a packed install without the local AI tarball", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-install-test-"));
    try {
      expect(() => writePackedTarballInstallManifest(root, "/tmp/openclaw.tgz", [])).toThrow(
        "requires exactly one @openclaw/ai tarball",
      );
      expect(() =>
        writePackedTarballInstallManifest(root, "/tmp/openclaw.tgz", [
          "/tmp/openclaw-ai-one.tgz",
          "/tmp/openclaw-ai-two.tgz",
        ]),
      ).toThrow("requires exactly one @openclaw/ai tarball");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects missing, incomplete, or ambiguous local package tarball directories", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-release-check-tarball-test-"));
    try {
      expect(() => resolveReleaseCheckLocalPackageTarballs(join(root, "missing"))).toThrow(
        RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV,
      );
      const empty = join(root, "empty");
      mkdirSync(empty);
      expect(() => resolveReleaseCheckLocalPackageTarballs(empty)).toThrow(
        "must contain exactly one @openclaw/ai tarball",
      );
      writeFileSync(join(empty, "one.tgz"), "fixture");
      writeFileSync(join(empty, "two.tgz"), "fixture");
      expect(() => resolveReleaseCheckLocalPackageTarballs(empty)).toThrow(
        "contains an unsupported package tarball",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("seeds packaged activation smoke with an included channel plugin", () => {
    const homeDir = mkdtempSync(join(tmpdir(), "openclaw-release-check-test-"));
    try {
      writePackedBundledPluginActivationConfig(homeDir);
      const config = JSON.parse(
        readFileSync(join(homeDir, ".openclaw", "openclaw.json"), "utf8"),
      ) as {
        channels?: Record<string, unknown>;
        plugins?: { entries?: Record<string, unknown> };
      };

      const pluginEntries = requirePluginEntries(config);
      const channels = Object.keys(config.channels ?? {});
      expect(channels.length).toBeGreaterThan(0);
      const excluded = collectRootPackageExcludedExtensionDirs();
      const artifacts = listBundledPluginPackArtifacts();
      for (const channel of channels) {
        expect(pluginEntries).toHaveProperty(channel);
        expect(excluded.has(channel)).toBe(false);
        const manifest = JSON.parse(
          readFileSync(join("extensions", channel, "openclaw.plugin.json"), "utf8"),
        ) as { channels: string[] };
        expect(manifest.channels).toContain(channel);
        expect(artifacts).toContain(`dist/extensions/${channel}/openclaw.plugin.json`);
      }
    } finally {
      rmSync(homeDir, { recursive: true, force: true });
    }
  });
});
