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
const currentArtifacts = ["github-exec-launcher.mjs", ...legacyArtifacts];
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

function runReleaseCheck(
  command: CommandFixture,
  root: string,
  toolingRoot: string,
  args: string[] = [],
) {
  return command.run(process.execPath, [...nodeArgs(toolingRoot), ...args], {
    cwd: root,
    env: nodeEnv(toolingRoot),
  });
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
      writeFiles(root, {
        "reject-npm-inventory.cjs": `const childProcess = require("node:child_process");
const original = childProcess.execFileSync;
childProcess.execFileSync = function (...args) {
  if (Array.isArray(args[1]) && args[1].includes("pack") && args[1].includes("--dry-run")) {
    throw new Error("Prepared tarball inspection must not launch npm pack");
  }
  return Reflect.apply(original, this, args);
};
require("node:module").syncBuiltinESMExports();
`,
      });
      diagnostics.stage("sparse-import-probe");
      const probe = await runReleaseCheck(command, root, toolingRoot, [
        "--input-type=module",
        "--eval",
        `import { readFileSync } from "node:fs";
const { createPackedPluginSdkTypescriptSmokeProject } = await import(${JSON.stringify(moduleUrl)});
createPackedPluginSdkTypescriptSmokeProject({ consumerDir: "consumer", packageSpec: "file:fixture.tgz" });
console.log(JSON.stringify({
  execArgv: process.execArgv,
  fixture: readFileSync("consumer/src/index.ts", "utf8"),
  setupConsumer: readFileSync("consumer/src/packed-plugin-sdk-setup-consumer.ts", "utf8")
}));`,
      ]);
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
      diagnostics.stage("legacy three-file contract requires the launcher");
      const result = await runReleaseCheck(command, root, toolingRoot, [
        ...(process.versions.bun ? [] : ["--require", npmInventoryGuard]),
        join(toolingRoot, "scripts/release-check.ts"),
        "--tarball",
        tarball,
      ]);
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
      copyFileSync("appcast.xml", join(root, "appcast.xml"));
      mkdirSync(join(root, "extensions"));
      symlinkSync(
        dirname(fileURLToPath(import.meta.resolve("tsx/package.json"))),
        join(root, "node_modules/tsx"),
        "junction",
      );
      writeWorkerArtifacts(root, legacyArtifacts);
      const run = () =>
        runReleaseCheck(command, root, process.cwd(), [resolve("scripts/release-check.ts")]);
      const unprepared = await run();
      expectExit(unprepared, 1, ["missing prepared Control UI .gz asset"], [packing]);

      writeFileSync(join(root, "dist/control-ui/assets/app.js.gz"), "prepared gzip fixture");
      const result = await run();
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
        [
          "current array overrides obsolete paths",
          currentContract + declareWorker("OBSOLETE_PATH", '"../obsolete.mjs"'),
          currentArtifacts,
        ],
        [
          "current array requires every declared artifact",
          currentContract,
          currentArtifacts.slice(1),
          workerMissing,
        ],
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
      const invalidContracts: Array<[string, string]> = [
        [
          declareWorker("ENTRY_PATH", '""'),
          "release-check: target worker artifact WORKER_BUNDLE_ENTRY_PATH must be a non-empty path string.",
        ],
        [
          declareWorker("ARTIFACT_PATHS", '["../worker/main.mjs"]'),
          "release-check: target worker artifact WORKER_BUNDLE_ARTIFACT_PATHS[0] must be a normalized relative path within dist/worker.",
        ],
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
    expect(JSON.parse(readText(root, "package.json"))).toEqual({
      private: true,
      dependencies: {
        "@openclaw/gateway-client": "file:///tmp/openclaw-gateway-client.tgz",
        "@openclaw/gateway-protocol": "file:///tmp/openclaw-gateway-protocol.tgz",
        openclaw: "file:///tmp/openclaw.tgz",
      },
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
});
