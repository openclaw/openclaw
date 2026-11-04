import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { registerMemoryCoreDoctorChecks } from "../../../extensions/memory-core/doctor-health-api.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { runDoctorLintCliInProcess } from "../../commands/doctor-lint-runner.js";
import { UPDATE_POST_CORE_CONVERGENCE_ENV } from "../../commands/doctor/shared/update-phase.js";
import * as config from "../../config/config.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import {
  clearHealthChecksForTest,
  getHealthCheck,
  registerHealthCheck,
} from "../../flows/health-check-registry.js";
import { createRetainedPackageSwap } from "../../infra/package-update-swap.test-support.js";
import { prepareSqliteReadOnlyCopyInProcess } from "../../infra/sqlite-readonly-location.js";
import { defaultRuntime } from "../../runtime.js";
import { createCommandResult } from "../../test-utils/npm-spec-install-test-helpers.js";
import { useStateDatabaseTempDirs } from "../../test-utils/state-database-temp-dirs.js";
import { VERSION } from "../../version.js";
import { finishParams, updateResult } from "./update-command-maintenance-fixtures.test-support.js";
import { createPostCorePluginUpdateResult } from "./update-command-plugins-internals.js";
import { finishUpdate } from "./update-command-post-update.js";

const mocks = vi.hoisted(() => ({
  command: vi.fn<typeof import("../../process/exec.js").runUtf8CommandWithTimeout>(),
  restart: vi.fn<typeof import("./update-command-service.js").maybeRestartService>(),
}));
vi.mock("../../process/exec.js", async (original) => ({
  ...(await original<typeof import("../../process/exec.js")>()),
  runUtf8CommandWithTimeout: mocks.command,
  runExec: async () => ({ stdout: "", stderr: "" }),
}));
vi.mock("../../flows/bundled-health-checks.js", async (original) => ({
  ...(await original<typeof import("../../flows/bundled-health-checks.js")>()),
  // Register the real plugin check with a fixed external provider outcome below.
  registerBundledHealthChecks: () => [],
  resolveBundledHealthCheckPluginStateMode: () => "direct",
}));
vi.mock("../../infra/deferred-plugin-migrations.js", async (original) => ({
  ...(await original<typeof import("../../infra/deferred-plugin-migrations.js")>()),
  readDeferredPluginMigrationsAsync: async () => [],
}));
vi.mock("./update-command-post-core.js", async (original) => ({
  ...(await original<typeof import("./update-command-post-core.js")>()),
  continuePostCoreUpdateInFreshProcess: async () => ({
    resumed: true,
    pluginUpdate: createPostCorePluginUpdateResult({ status: "ok" }),
  }),
}));
vi.mock("../../daemon/service.js", async (original) => ({
  ...(await original<typeof import("../../daemon/service.js")>()),
  readGatewayServiceState: async () => ({
    installed: true,
    loadState: { status: "loaded" },
    env: process.env,
    command: { programArguments: [process.execPath, "/fixture/dist/index.js", "gateway"] },
  }),
}));
vi.mock("./update-command-service.js", async (original) => ({
  ...(await original<typeof import("./update-command-service.js")>()),
  maybeRestartService: mocks.restart,
}));
vi.mock("./update-command-service-revalidation.js", async (original) => ({
  ...(await original<typeof import("./update-command-service-revalidation.js")>()),
  revalidateManagedGatewayServiceAfterUpdate: async ({ root }: { root: string }) => ({
    kind: "owned",
    root,
    fingerprint: "memory-inspection-fixture",
    refreshDefinition: false,
  }),
}));
vi.mock("./update-command-result.js", async (original) => ({
  ...(await original<typeof import("./update-command-result.js")>()),
  writeControlPlaneUpdateRestartSentinelBestEffort: async () => undefined,
}));
vi.mock("./progress.js", async (original) => ({
  ...(await original<typeof import("./progress.js")>()),
  prepareResult: async () => () => {},
}));

const dirs = useStateDatabaseTempDirs();
const snapshots = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  clearHealthChecksForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("finishes a migrated package update with an unavailable inspection warning when snapshot space runs out", async () => {
  const stateDir = dirs.make("update-memory-inspection-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
  vi.stubEnv(UPDATE_POST_CORE_CONVERGENCE_ENV, "1");
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  const cfg = { memory: { search: { provider: "local" as const, fallback: "none" as const } } };
  const snapshot = {
    path: path.join(stateDir, "openclaw.json"),
    exists: true,
    valid: true as const,
    config: asRuntimeConfig(cfg),
    runtimeConfig: asRuntimeConfig(cfg),
    sourceConfig: asResolvedSourceConfig(cfg),
    resolved: asResolvedSourceConfig(cfg),
    parsed: cfg,
    issues: [],
    warnings: [],
    legacyIssues: [],
    raw: JSON.stringify(cfg),
  };
  fs.writeFileSync(snapshot.path, snapshot.raw);
  vi.spyOn(config, "readConfigFileSnapshot").mockResolvedValue(snapshot);
  vi.spyOn(config, "readConfigFileSnapshotWithPluginMetadata").mockResolvedValue({ snapshot });
  const dbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  {
    using db = new DatabaseSync(dbPath);
    db.exec(
      "PRAGMA user_version=25; CREATE TABLE memory_index_meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE history(value TEXT); INSERT INTO history VALUES('retained conversation');",
    );
    db.prepare("INSERT INTO memory_index_meta VALUES(?,?)").run(
      "memory_index_meta_v1",
      JSON.stringify({ model: "embeddinggemma-300m" }),
    );
  }
  const beforeMigration = fs.readFileSync(dbPath);
  const { packageRoot, transaction } = await createRetainedPackageSwap(
    dirs.make("memory-package-swap-"),
    async ({ params }) => {
      fs.writeFileSync(
        path.join(params.stage.packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: VERSION }),
      );
      fs.mkdirSync(path.join(params.stage.packageRoot, "dist"), { recursive: true });
      fs.writeFileSync(
        path.join(params.stage.packageRoot, "dist", "index.js"),
        "// external command fixture\n",
      );
    },
  );
  // Migration has already committed when post-plugin readiness inspects metadata.
  {
    using db = new DatabaseSync(dbPath);
    db.exec(
      "BEGIN; ALTER TABLE history ADD COLUMN migrated INTEGER DEFAULT 1; PRAGMA user_version=27; COMMIT;",
    );
  }
  expect(fs.readFileSync(dbPath)).not.toEqual(beforeMigration);
  const migratedBytes = fs.readFileSync(dbPath);
  const stage = snapshots.make("memory-inspection-destination-");
  const disk = fs.statfsSync(stage);
  const statfs = fs.statfsSync.bind(fs);
  const space = vi
    .spyOn(fs, "statfsSync")
    .mockImplementation((...args) =>
      String(args[0]).startsWith(stage)
        ? Object.assign({}, disk, { bsize: 1, bavail: 1 })
        : statfs(...args),
    );
  // Substitute only the native worker transport; retain real capacity/copy/cleanup policy.
  vi.spyOn(sqliteRuntime, "prepareSqliteReadOnlyLocation").mockImplementation((file) =>
    prepareSqliteReadOnlyCopyInProcess(file, stage),
  );
  registerMemoryCoreDoctorChecks({
    registerHealthCheck: (check) =>
      registerHealthCheck(Object.assign(check, { updateReadiness: "post-plugin" })),
    getHealthCheck,
    memoryCoreActive: true,
    inspectEmbeddingProviderSetup: async () => null,
  });
  mocks.command.mockImplementation(async (argv) => {
    expect(argv).toContain("--lint");
    let stdout = "";
    const capture = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    try {
      const code = await runDoctorLintCliInProcess(defaultRuntime, {
        json: true,
        severityMin: "error",
        onlyIds: ["memory-core/managed-local-embedding-setup"],
      });
      return createCommandResult({ code, stdout });
    } finally {
      capture.mockRestore();
    }
  });
  mocks.restart.mockReset().mockImplementation(async ({ result, onVerified, shouldRestart }) => {
    expect(shouldRestart).toBe(true);
    expect(result.postUpdate?.plugins).toMatchObject({ status: "warning" });
    onVerified?.(Date.now());
    return "ok";
  });
  const final = await finishUpdate(
    finishParams({
      root: packageRoot,
      result: updateResult({ root: packageRoot, after: { version: VERSION } }),
      configSnapshot: snapshot,
      packageTransaction: transaction,
      rollbackBlockedReason: "state-migrated-no-rollback",
      opts: { json: true },
      preManagedServiceStop: { stopped: true, running: true },
    }),
  ).catch((error: unknown) => ({ error }));
  expect(space).toHaveBeenCalled();
  expect(fs.readdirSync(stage)).toEqual([]);
  expect(fs.readFileSync(dbPath)).toEqual(migratedBytes);
  expect(fs.readFileSync(snapshot.path, "utf8")).toBe(snapshot.raw);
  expect(final).toMatchObject({
    status: "ok",
    postUpdate: {
      plugins: {
        status: "warning",
        warnings: expect.arrayContaining([
          expect.objectContaining({ message: expect.stringContaining("could not be verified") }),
        ]),
      },
    },
  });
  expect(mocks.restart).toHaveBeenCalledOnce();
  using db = new DatabaseSync(dbPath, { readOnly: true });
  expect(db.prepare("SELECT value,migrated FROM history").get()).toEqual({
    value: "retained conversation",
    migrated: 1,
  });
});
