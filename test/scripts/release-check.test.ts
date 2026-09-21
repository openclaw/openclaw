// Release Check tests cover release check script behavior.
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { create } from "tar";
import { describe, expect } from "vitest";
import { parse } from "yaml";
import {
  collectRootPackageExcludedExtensionDirs,
  listBundledPluginPackArtifacts,
} from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { resolveVitestNodeArgs } from "../../scripts/lib/vitest-process-env.mts";
import {
  createPackedTarballInstallArgs,
  prepareReleaseCheckLocalPackageTarballs,
  RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV,
  resolvePackedBundledChannelEntrySmokeCommand,
  resolveReleaseCheckLocalPackageTarballs,
  writePackedTarballInstallManifest,
  writePackedBundledPluginActivationConfig,
} from "../../scripts/release-check.ts";
import { createCommandTest } from "../helpers/command-fixture.js";

const it = createCommandTest();

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

  it("loads sparse release tooling and checks the target worker contract", async ({ command }) => {
    const diagnostics = command.enableDiagnostics("release-check-target");
    await command.lifetime.run(async () => {
      const root = command.createTempDir("openclaw-release-check-target-");
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
      mkdirSync(join(root, "scripts", "lib"), { recursive: true });
      mkdirSync(join(root, "extensions"));
      const packageJson = JSON.stringify({
        name: "openclaw",
        version: "2026.9.1",
        files: ["dist"],
      });
      writeFileSync(join(root, "package.json"), packageJson);
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
      const runtimeArgs = process.versions.bun
        ? []
        : [...resolveVitestNodeArgs(), "--import", join(toolingRoot, "scripts/tsx.mjs")];
      const fixtureEnv = {
        ...process.env,
        TSX_TSCONFIG_PATH: join(toolingRoot, "tsconfig.json"),
        // npm runs its notifier separately from the offline tarball inspection.
        npm_config_update_notifier: "false",
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
      mkdirSync(join(root, "src/shared"), { recursive: true });
      mkdirSync(join(root, "src/worker"), { recursive: true });
      writeFileSync(join(root, "src/worker/worker-deploy-entry.ts"), "export {};\n");
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
      const tarball = join(root, "target.tgz");
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
      const cases = [
        {
          name: "legacy two-file worker contract",
          workerContract: legacyWorkerContract,
          artifacts: legacyArtifacts,
          declaresLocator: false,
          includesLocator: false,
          expected: "release-check: packed dist/plugin-sdk directory not found.",
        },
        {
          name: "current array overrides obsolete individual paths",
          workerContract:
            currentWorkerContract +
            'export const WORKER_BUNDLE_OBSOLETE_PATH = "../obsolete.mjs";\n',
          artifacts: currentArtifacts,
          declaresLocator: false,
          includesLocator: false,
          expected: "release-check: packed dist/plugin-sdk directory not found.",
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
          expected: "release-check: packed dist/plugin-sdk directory not found.",
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
          expected: "release-check: packed dist/plugin-sdk directory not found.",
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
        const packedWorkerRoot = join(packedRoot, "dist/worker");
        rmSync(packedWorkerRoot, { recursive: true, force: true });
        mkdirSync(packedWorkerRoot);
        for (const artifact of artifacts) {
          writeFileSync(join(packedWorkerRoot, artifact), "export {};");
        }
        const locatorSource = join(root, "scripts/lib/gateway-run-chunk-metadata.mts");
        if (declaresLocator) {
          writeFileSync(locatorSource, "export const GATEWAY_RUN_CHUNK_METADATA_VERSION = 1;");
        } else {
          rmSync(locatorSource, { force: true });
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
        } else {
          rmSync(join(packedRoot, "dist/cli/gateway-run-chunk.json"), { force: true });
        }
        create({ cwd: root, file: tarball, gzip: true, sync: true }, ["package"]);
        writeFileSync(join(root, "src/shared/worker-bundle-hash.ts"), workerContract);
        const result = await command.run(
          process.execPath,
          [...runtimeArgs, join(toolingRoot, "scripts/release-check.ts"), "--tarball", tarball],
          {
            cwd: root,
            encoding: "utf8",
            env: fixtureEnv,
          },
        );
        expect(result.error, name).toBeUndefined();
        expect(result.status, name).toBe(1);
        // Valid target-specific artifacts reach the SDK check; this fixture omits SDK output.
        expect(result.stderr, name).toContain(expected);
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
        writeFileSync(join(root, "src/shared/worker-bundle-hash.ts"), source);
        const result = await command.run(
          process.execPath,
          [...runtimeArgs, join(toolingRoot, "scripts/release-check.ts"), "--tarball", tarball],
          {
            cwd: root,
            encoding: "utf8",
            env: fixtureEnv,
          },
        );
        expect(result.error, "invalid worker contract").toBeUndefined();
        expect(result.status, source).toBe(1);
        expect(result.stderr, source).toContain(expected);
      }

      // Shared worker helpers predate the deploy producer and cannot define the
      // package contract for those historical frozen targets.
      diagnostics.stage("target-without-worker-producer");
      writeFileSync(
        join(root, "src/shared/worker-bundle-hash.ts"),
        "export const WORKER_BUNDLE_ARTIFACT_PATHS = [];\n",
      );
      rmSync(join(root, "src/worker/worker-deploy-entry.ts"));
      rmSync(join(packedRoot, "dist/worker"), { recursive: true, force: true });
      const noWorkerTarball = join(root, "target-without-workers.tgz");
      create({ cwd: root, file: noWorkerTarball, gzip: true, sync: true }, ["package"]);
      const noWorkerResult = await command.run(
        process.execPath,
        [
          ...runtimeArgs,
          join(toolingRoot, "scripts/release-check.ts"),
          "--tarball",
          noWorkerTarball,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: fixtureEnv,
        },
      );
      expect(noWorkerResult.error, "target without a worker producer").toBeUndefined();
      expect(noWorkerResult.status).toBe(1);
      expect(noWorkerResult.stderr).toContain(
        "release-check: packed dist/plugin-sdk directory not found.",
      );
      expect(noWorkerResult.stderr).not.toContain("Worker deploy artifact");
      diagnostics.stage("assertions-complete");
    });
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
