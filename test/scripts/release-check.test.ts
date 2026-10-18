import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  checkPackedTargetBootstrap as checkTarget,
  createPackedTarballInstallArgs as installArgs,
  prepareReleaseCheckLocalPackageTarballs as prepareTarballs,
  RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV,
  resolvePackedBundledChannelEntrySmokeCommand as resolveSmokeCommand,
  resolveReleaseCheckLocalPackageTarballs as resolveTarballs,
  writePackedTarballInstallManifest as writeInstallManifest,
  writePackedBundledPluginActivationConfig as writeActivationConfig,
} from "../../scripts/release-check.ts";
import { createCommandTest, type CommandFixture } from "../helpers/command-fixture.js";

const it = createCommandTest();
const workerMissing = "Worker deploy artifact dist/worker/github-exec-launcher.mjs is missing.";
const packing = "Packing OpenClaw package";
const badLinker = "ERR_PNPM_BUNDLED_DEPENDENCIES_WITHOUT_HOISTED";
const readText = (...parts: string[]) => readFileSync(join(...parts), "utf8");
function expectExit(
  result: { error?: unknown; status: number | null; stderr: string },
  status: number,
  includes: string[] = [],
  excludes: string[] = [],
) {
  expect(result).toMatchObject({ error: undefined, status });
  for (const text of includes) {
    expect(result.stderr).toContain(text);
  }
  for (const text of excludes) {
    expect(result.stderr).not.toContain(text);
  }
}
function writeTarballs(root: string, names: string[], version: string) {
  const files = names.map((name) => `openclaw-${name}-${version}.tgz`);
  writeFiles(root, Object.fromEntries(files.map((file) => [file, "fixture"])));
  return files.map((file) => join(root, file));
}
const workerContractPath = "src/shared/worker-bundle-hash.ts";
function writeFiles(root: string, files: Record<string, string>) {
  for (const [name, contents] of Object.entries(files)) {
    const destination = join(root, name);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, contents);
  }
}

const declareWorker = (name: string, value: string) =>
  `export const WORKER_BUNDLE_${name} = ${value};\n`;
const legacyContract =
  declareWorker("ENTRY_PATH", '"worker.mjs"') +
  declareWorker("RSYNC_RECEIVER_PATH", '"workspace-rsync-receiver.mjs"');
const launcherContract =
  legacyContract + declareWorker("GITHUB_EXEC_LAUNCHER_PATH", '"github-exec-launcher.mjs"');
const legacyArtifacts = ["worker.mjs", "workspace-rsync-receiver.mjs"];
const currentArtifacts = [
  "github-exec-launcher.mjs",
  "service-child-group-anchor.mjs",
  "service-child-relay.mjs",
  ...legacyArtifacts,
];
const currentContract = declareWorker("ARTIFACT_PATHS", JSON.stringify(currentArtifacts));
const packageManifest = { name: "openclaw", version: "2026.9.1", files: ["dist"] };
const nodeArgs = (toolingRoot: string) =>
  process.versions.bun
    ? []
    : [...resolveVitestNodeArgs(), "--import", join(toolingRoot, "scripts/tsx.mjs")];
const nodeEnv = (root: string) => ({
  ...process.env,
  TSX_TSCONFIG_PATH: join(root, "tsconfig.json"),
});

function createPackedTargetFixture(command: CommandFixture) {
  const root = command.createTempDir("openclaw-release-check-target-");
  const packageJson = JSON.stringify(packageManifest);
  const packedRoot = join(root, "package");
  const packedFiles = {
    "package.json": packageJson,
    "dist/entry.js": 'import "./cli/run-main.js";',
    "dist/cli/run-main.js": "export {};",
    "dist/run-gateway.js": "const GATEWAY_AUTH_MODES = []; function addGatewayRunCommand() {}",
  };
  writeFiles(packedRoot, packedFiles);
  mkdirSync(join(root, "scripts/lib"), { recursive: true });
  writeFiles(root, {
    "package.json": packageJson,
    "src/worker/worker-deploy-entry.ts": "export {};\n",
  });
  mkdirSync(join(root, "src/shared"), { recursive: true });
  return { root, packedRoot, packedFiles };
}

function writeWorkerArtifacts(packedRoot: string, artifacts: string[]) {
  writeFiles(
    packedRoot,
    Object.fromEntries(artifacts.map((name) => [`dist/worker/${name}`, "export {};"])),
  );
}

describe("release-check", () => {
  it.each([
    ["mts", ["--import", "tsx", "scripts/test-built-bundled-channel-entry-smoke.mts"]],
    ["mjs", ["scripts/test-built-bundled-channel-entry-smoke.mjs"]],
  ])("runs the frozen target's bundled channel smoke (%s)", (extension, args) => {
    expect(
      resolveSmokeCommand(
        (path) => path.endsWith(`test-built-bundled-channel-entry-smoke.${extension}`),
        "/runtime/node",
      ),
    ).toEqual({ command: "/runtime/node", args });
  });

  it("fails closed when the target provides no bundled channel smoke entrypoint", () => {
    expect(() => resolveSmokeCommand(() => false)).toThrow(
      "release-check: target does not provide scripts/test-built-bundled-channel-entry-smoke.mts or .mjs",
    );
  });

  it("loads sparse tooling and rejects a missing worker artifact", async ({ command }) => {
    const diagnostics = command.enableDiagnostics("release-check-target");
    await command.lifetime.run(async () => {
      const { root, packedRoot } = createPackedTargetFixture(command);
      const toolingRoot = join(root, "tooling");
      const workflow = parse(readText(".github/workflows/openclaw-npm-preflight.yml"));
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
      expectExit(tracked, 0);
      const trackedPaths = tracked.stdout.split("\0").filter(Boolean);
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
      for (const relativePath of trackedPaths.filter(
        (file) => !file.includes("/") || requiredPaths.has(file),
      )) {
        const destination = join(toolingRoot, relativePath);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(relativePath, destination);
      }
      symlinkSync(resolve("node_modules"), join(toolingRoot, "node_modules"), "junction");
      mkdirSync(join(root, "extensions"));
      writeFiles(root, {
        "scripts/fixtures/packed-plugin-sdk-type-smoke.ts": "stale target fixture",
        "scripts/fixtures/packed-plugin-sdk-setup-consumer.ts": "stale target setup consumer",
      });
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
      const runtimeArgs = nodeArgs(toolingRoot);
      const fixtureEnv = nodeEnv(toolingRoot);
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
        { cwd: root, encoding: "utf8", env: fixtureEnv },
      );
      expectExit(probe, 0);
      const { execArgv, ...smokeProject } = JSON.parse(probe.stdout);
      if (!process.versions.bun) {
        expect(execArgv, "CLI fixtures inherit the Node shutdown policy").toContain(
          "--no-concurrent-sparkplug",
        );
      }
      const fixtures = join(toolingRoot, "scripts/fixtures");
      expect(smokeProject).toEqual({
        fixture: readText(fixtures, "packed-plugin-sdk-type-smoke.ts"),
        setupConsumer: readText(fixtures, "packed-plugin-sdk-setup-consumer.ts"),
      });

      copyFileSync("appcast.xml", join(root, "appcast.xml"));
      writeFileSync(join(root, workerContractPath), launcherContract);
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
      expectExit(result, 1, [workerMissing], [packing]);
    });
  });

  it("packs isolated bundled source through its owner before inspection", async ({ command }) => {
    await command.lifetime.run(async () => {
      const { root, packedFiles } = createPackedTargetFixture(command);
      const runtime = { name: "fixture-runtime", version: "1.0.0" };
      const rootManifest: { packageManager: string } = JSON.parse(readText("package.json"));
      const packageJson = JSON.stringify({
        ...packageManifest,
        packageManager: rootManifest.packageManager,
        dependencies: { [runtime.name]: runtime.version },
        bundleDependencies: [runtime.name],
        scripts: {
          "update:compat:check":
            "node -e \"require('node:fs').writeFileSync('compat-checked', 'yes')\"",
        },
      });
      const changelog =
        "# Changelog\n\n## 2026.9.1\n\n- Preserve the complete prepared package source.\n";
      const inventoryUrl = pathToFileURL(resolve("scripts/lib/package-dist-inventory.ts")).href;
      writeFiles(root, {
        ...packedFiles,
        "package.json": packageJson,
        "dist/index.js": "export {};",
        "dist/control-ui/index.html": "<html></html>",
        "dist/control-ui/assets/app.js.br": "prepared Brotli fixture",
        "pnpm-workspace.yaml": "nodeLinker: isolated\nverifyDepsBeforeRun: false\n",
        "CHANGELOG.md": changelog,
        "node_modules/fixture-runtime/package.json": JSON.stringify(runtime),
        "scripts/write-package-dist-inventory.ts": `import(${JSON.stringify(inventoryUrl)}).then(({ writePackageDistInventoryForPublish }) => writePackageDistInventoryForPublish(process.cwd()));\n`,
        [workerContractPath]: launcherContract,
      });
      expect(parse(readText("pnpm-workspace.yaml"))).toMatchObject({
        nodeLinker: "isolated",
        verifyDepsBeforeRun: false,
      });
      copyFileSync("appcast.xml", join(root, "appcast.xml"));
      mkdirSync(join(root, "extensions"));
      symlinkSync(
        dirname(fileURLToPath(import.meta.resolve("tsx/package.json"))),
        join(root, "node_modules/tsx"),
        "junction",
      );
      writeWorkerArtifacts(root, legacyArtifacts);
      const args = [...nodeArgs(process.cwd()), resolve("scripts/release-check.ts")];
      const runReleaseCheck = () =>
        command.run(process.execPath, args, { cwd: root, env: nodeEnv(process.cwd()) });
      const unprepared = await runReleaseCheck();
      expectExit(unprepared, 1, ["missing prepared Control UI .gz asset"], [packing]);

      writeFileSync(join(root, "dist/control-ui/assets/app.js.gz"), "prepared gzip fixture");
      const result = await runReleaseCheck();
      expectExit(result, 1, [packing, workerMissing], [badLinker]);
      // Live npm updater coverage is not a packaging gate.
      expect({
        compatChecked: existsSync(join(root, "compat-checked")),
        packageJson: readText(root, "package.json"),
        changelog: readText(root, "CHANGELOG.md"),
        inventory: existsSync(join(root, "dist/postinstall-inventory.json")),
      }).toEqual({ compatChecked: false, packageJson, changelog, inventory: true });
    });
  });

  it("checks target worker and gateway contracts against prepared output", async ({ command }) => {
    const diagnostics = command.enableDiagnostics("release-check-contracts");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const cases: Array<[string, string, string[], string?, ("missing" | "present")?]> = [
        ["legacy two-file contract", legacyContract, legacyArtifacts],
        [
          "current array overrides obsolete paths",
          currentContract + declareWorker("OBSOLETE_PATH", '"../obsolete.mjs"'),
          currentArtifacts,
        ],
        ["legacy missing launcher", launcherContract, legacyArtifacts, workerMissing],
        ["legacy launcher", launcherContract, ["github-exec-launcher.mjs", ...legacyArtifacts]],
        ...["service-child-group-anchor.mjs", "service-child-relay.mjs"].map(
          (missing): [string, string, string[], string] => [
            `current array requires ${missing}`,
            currentContract,
            currentArtifacts.filter((artifact) => artifact !== missing),
            `Worker deploy artifact dist/worker/${missing} is missing.`,
          ],
        ),
        [
          "locator requires metadata",
          legacyContract,
          legacyArtifacts,
          "could not read gateway run chunk metadata",
          "missing",
        ],
        ["locator resolves metadata", legacyContract, legacyArtifacts, undefined, "present"],
      ];
      for (const [name, workerContract, artifacts, expected, locator] of cases) {
        diagnostics.stage(name);
        // Separate targets keep module caches from reusing another frozen release's declarations.
        const { root, packedRoot, packedFiles } = createPackedTargetFixture(command);
        writeWorkerArtifacts(packedRoot, artifacts);
        writeFileSync(join(root, workerContractPath), workerContract);
        if (locator) {
          writeFiles(root, {
            "scripts/lib/gateway-run-chunk-metadata.mts":
              "export const GATEWAY_RUN_CHUNK_METADATA_VERSION = 1;",
          });
        }
        if (locator === "present") {
          const sha256 = createHash("sha256")
            .update(packedFiles["dist/run-gateway.js"])
            .digest("hex");
          writeFiles(packedRoot, {
            "dist/cli/gateway-run-chunk.json": JSON.stringify({
              version: 1,
              chunks: [{ fileName: "run-gateway.js", sha256 }],
            }),
          });
        }
        errors.mockClear();
        if (expected) {
          await expect(checkTarget(root, packedRoot), name).rejects.toThrow();
          expect(errors.mock.calls.flat().join("\n"), name).toContain(expected);
        } else {
          await expect(checkTarget(root, packedRoot), name).resolves.toBeUndefined();
          expect(errors, name).not.toHaveBeenCalled();
        }
      }
      const invalidPaths: Array<[string, string]> = [
        ['""', "must be a non-empty path string."],
        ['"../worker/main.mjs"', "must be a normalized relative path within dist/worker."],
      ];
      const invalidContracts: Array<[string, string]> = [
        ...["ENTRY_PATH", "ARTIFACT_PATHS"].flatMap((name) =>
          invalidPaths.map(([value, error]): [string, string] => [
            declareWorker(name, name === "ENTRY_PATH" ? value : `["worker.mjs", ${value}]`),
            `release-check: target worker artifact WORKER_BUNDLE_${name}${name === "ENTRY_PATH" ? "" : "[1]"} ${error}`,
          ]),
        ),
        ...["undefined", "[]"].map((value): [string, string] => [
          legacyContract + declareWorker("ARTIFACT_PATHS", value),
          "release-check: target WORKER_BUNDLE_ARTIFACT_PATHS must be a non-empty array.",
        ]),
        [
          "export const OTHER_PATH = 1;\n",
          "release-check: target worker producer is missing WORKER_BUNDLE_*_PATH declarations.",
        ],
      ];
      for (const [index, [source, expected]] of invalidContracts.entries()) {
        diagnostics.stage(`invalid-worker-contract-${index}`);
        const { root, packedRoot } = createPackedTargetFixture(command);
        writeFileSync(join(root, workerContractPath), source);
        await expect(checkTarget(root, packedRoot), source).rejects.toThrow(expected);
      }

      // Shared hash helpers alone do not impose a worker contract on historical targets.
      diagnostics.stage("target-without-worker-producer");
      const { root, packedRoot } = createPackedTargetFixture(command);
      writeFileSync(join(root, workerContractPath), declareWorker("ARTIFACT_PATHS", "[]"));
      rmSync(join(root, "src/worker/worker-deploy-entry.ts"));
      errors.mockClear();
      await expect(checkTarget(root, packedRoot)).resolves.toBeUndefined();
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("installs the prepared tarball with its real package lifecycle", () => {
    const prefix = "/tmp/prefix";
    expect(installArgs(prefix)).toEqual(["install", "--prefix", prefix, "--no-audit", "--no-fund"]);
  });

  it.for([true, false])("resolves core tarballs (AI=%s)", (requiresAi, { command }) => {
    const root = command.createTempDir("openclaw-release-check-tarball-test-");
    const names = requiresAi
      ? ["ai", "gateway-client", "gateway-protocol"]
      : ["gateway-protocol", "gateway-client"];
    const written = writeTarballs(root, names, requiresAi ? "2026.6.33" : "2026.7.2");
    writeFileSync(join(root, "SHA256SUMS"), "fixture");
    expect(resolveTarballs(root, requiresAi ? undefined : false)).toEqual(
      requiresAi ? written : written.toReversed(),
    );
    expect(resolveTarballs(undefined)).toEqual([]);
  });

  it("writes a gateway-only project when the root does not require AI", ({ command }) => {
    const root = command.createTempDir("openclaw-release-check-install-test-");
    writeInstallManifest(
      root,
      "/tmp/openclaw.tgz",
      ["/tmp/openclaw-gateway-client.tgz", "/tmp/openclaw-gateway-protocol.tgz"],
      false,
    );
    const manifest: {
      dependencies?: Record<string, string>;
      private?: boolean;
    } = JSON.parse(readText(root, "package.json"));
    expect(manifest).toMatchObject({ private: true });
    expect(manifest.dependencies).toEqual({
      "@openclaw/gateway-client": "file:///tmp/openclaw-gateway-client.tgz",
      "@openclaw/gateway-protocol": "file:///tmp/openclaw-gateway-protocol.tgz",
      openclaw: "file:///tmp/openclaw.tgz",
    });
  });

  it("packs the local AI workspace when no prepared tarball is supplied", ({ command }) => {
    const root = command.createTempDir("openclaw-release-check-ai-pack-test-");
    const tarballs = prepareTarballs({
      tmpRoot: root,
      packLocalAi: (packDestination) => {
        const filename = "openclaw-ai-2026.7.1-beta.3.tgz";
        writeFileSync(join(packDestination, filename), "fixture");
        return [{ filename }];
      },
    });
    expect(tarballs).toEqual([join(root, "ai-pack", "openclaw-ai-2026.7.1-beta.3.tgz")]);
  });

  it("prefers prepared core package tarballs over packing the AI workspace", ({ command }) => {
    const root = command.createTempDir("openclaw-release-check-ai-pack-test-");
    const preparedDir = join(root, "prepared");
    const prepared = writeTarballs(
      preparedDir,
      ["ai", "gateway-client", "gateway-protocol"],
      "2026.7.1-beta.3",
    );
    const resolved = prepareTarballs({
      tmpRoot: root,
      tarballDir: preparedDir,
      packLocalAi: () => {
        throw new Error("workspace pack should not run");
      },
    });
    expect(resolved).toEqual(prepared);
  });

  it("rejects a packed install without the local AI tarball", ({ command }) => {
    const root = command.createTempDir("openclaw-release-check-install-test-");
    for (const tarballs of [[], ["/tmp/openclaw-ai-one.tgz", "/tmp/openclaw-ai-two.tgz"]]) {
      expect(() => writeInstallManifest(root, "/tmp/openclaw.tgz", tarballs)).toThrow(
        "requires exactly one @openclaw/ai tarball",
      );
    }
  });

  it("rejects missing, incomplete, or ambiguous tarball directories", ({ command }) => {
    const root = command.createTempDir("openclaw-release-check-tarball-test-");
    expect(() => resolveTarballs(join(root, "missing"))).toThrow(
      RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR_ENV,
    );
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(() => resolveTarballs(empty)).toThrow("must contain exactly one @openclaw/ai tarball");
    writeFileSync(join(empty, "one.tgz"), "fixture");
    writeFileSync(join(empty, "two.tgz"), "fixture");
    expect(() => resolveTarballs(empty)).toThrow("contains an unsupported package tarball");
  });

  it("seeds packaged activation smoke with an included channel plugin", ({ command }) => {
    const homeDir = command.createTempDir("openclaw-release-check-test-");
    writeActivationConfig(homeDir);
    const config: {
      channels?: Record<string, unknown>;
      plugins?: { entries?: Record<string, unknown> };
    } = JSON.parse(readText(homeDir, ".openclaw", "openclaw.json"));

    const pluginEntries = config.plugins?.entries;
    expect(pluginEntries).toBeDefined();
    const channels = Object.keys(config.channels ?? {});
    expect(channels.length).toBeGreaterThan(0);
    const excluded = collectRootPackageExcludedExtensionDirs();
    const artifacts = listBundledPluginPackArtifacts();
    for (const channel of channels) {
      expect(pluginEntries).toHaveProperty(channel);
      expect(excluded.has(channel)).toBe(false);
      const manifest: { channels: string[] } = JSON.parse(
        readText("extensions", channel, "openclaw.plugin.json"),
      );
      expect(manifest.channels).toContain(channel);
      expect(artifacts).toContain(`dist/extensions/${channel}/openclaw.plugin.json`);
    }
  });
});
