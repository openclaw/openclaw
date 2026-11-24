import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as bundledHealthChecks from "../flows/bundled-health-checks.js";
import { CORE_HEALTH_CHECKS } from "../flows/doctor-core-checks.js";
import { clearHealthChecksForTest, registerHealthCheck } from "../flows/health-check-registry.js";
import type { HealthCheckContext } from "../flows/health-checks.js";
import { recordDeferredPluginMigrations } from "../infra/deferred-plugin-migrations.js";
import * as diskSpace from "../infra/disk-space.js";
import { resolveExistingSqliteFileUri } from "../infra/node-sqlite.js";
import * as snapshotSource from "../infra/sqlite-snapshot-source.js";
import { clearLoadInstalledPluginIndexInstallRecordsCache } from "../plugins/installed-plugin-index-record-cache.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { captureEnv } from "../test-utils/env.js";
import type { DoctorLintCliOptions } from "./doctor-lint-options.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import {
  createDoctorLintSemanticIndex,
  snapshotDoctorLintSqliteFamily,
} from "./doctor-lint.test-support.js";
import { createTestConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  actualOpenNodeSqliteDatabase: vi.fn(),
  actualPrepareSqliteReadOnlyLocation: vi.fn(),
  actualReadConfigFileSnapshot: vi.fn(),
  actualResolveDoctorContributionHealthChecks: vi.fn(),
  buildGatewayProbeConnectionDetails: vi.fn(),
  callGateway: vi.fn(),
  openNodeSqliteDatabase: vi.fn(),
  prepareSqliteReadOnlyLocation: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveDoctorContributionHealthChecks: vi.fn(),
  progressEvents: [] as string[],
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  mocks.actualReadConfigFileSnapshot.mockImplementation(actual.readConfigFileSnapshot);
  return {
    ...actual,
    readConfigFileSnapshot: mocks.readConfigFileSnapshot,
    readConfigFileSnapshotWithPluginMetadata: async () => ({
      snapshot: await mocks.readConfigFileSnapshot({ observe: false }),
    }),
  };
});
vi.mock("../cli/progress.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/progress.js")>();
  return {
    ...actual,
    createCliProgress: (options: Parameters<typeof actual.createCliProgress>[0]) => {
      mocks.progressEvents.push(`create enabled=${String(options.enabled)}`);
      const progress = actual.createCliProgress(options);
      return {
        ...progress,
        setLabel: (label: string) => {
          mocks.progressEvents.push(`label ${label}`);
          progress.setLabel(label);
        },
        done: () => {
          mocks.progressEvents.push("done");
          progress.done();
        },
      };
    },
  };
});
vi.mock("../infra/sqlite-snapshot-source.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-snapshot-source.js")>();
  mocks.actualPrepareSqliteReadOnlyLocation.mockImplementation(
    actual.prepareSqliteReadOnlyLocation,
  );
  mocks.prepareSqliteReadOnlyLocation.mockImplementation(actual.prepareSqliteReadOnlyLocation);
  return {
    ...actual,
    prepareSqliteReadOnlyLocation: mocks.prepareSqliteReadOnlyLocation,
  };
});
vi.mock("../infra/node-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/node-sqlite.js")>();
  mocks.actualOpenNodeSqliteDatabase.mockImplementation(actual.openNodeSqliteDatabase);
  mocks.openNodeSqliteDatabase.mockImplementation(mocks.actualOpenNodeSqliteDatabase);
  return {
    ...actual,
    openNodeSqliteDatabase: mocks.openNodeSqliteDatabase,
  };
});
vi.mock("../flows/doctor-health-contributions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../flows/doctor-health-contributions.js")>();
  mocks.actualResolveDoctorContributionHealthChecks.mockImplementation(
    actual.resolveDoctorContributionHealthChecks,
  );
  return {
    ...actual,
    resolveDoctorContributionHealthChecks: mocks.resolveDoctorContributionHealthChecks,
  };
});
vi.mock("../gateway/call.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/call.js")>();
  return {
    ...actual,
    buildGatewayProbeConnectionDetails: mocks.buildGatewayProbeConnectionDetails,
    callGateway: mocks.callGateway,
  };
});
const runtime = createTestRuntime();

const CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID = "crabbox/cloud-worker-profiles";
const MEMORY_CHECK_ID = "memory-core/managed-local-embedding-setup";
const semanticConfig = {
  gateway: { mode: "local" },
  memory: { search: { provider: "local", fallback: "none" } },
} satisfies OpenClawConfig;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stdout: MockInstance<typeof process.stdout.write>;
const outputText = () => stdout.mock.calls.map(([line]) => String(line)).join("");
const outputReport = () => JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
const mockConfig = (config: OpenClawConfig = {}) =>
  mocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot(config));

async function expectFailedCheck(
  checkId: string,
  finding: Record<string, unknown>,
  options: DoctorLintCliOptions = {},
) {
  expect(await runDoctorLintCli(runtime, { json: true, onlyIds: [checkId], ...options })).toBe(1);
  const report = outputReport();
  expect(report).toMatchObject({
    ok: false,
    checksRun: options.onlyIds?.length ?? 1,
    findings: [{ checkId, ...finding }],
  });
  return report;
}
const originalIsTTY = process.stdout.isTTY;
const originalEnv = captureEnv([
  "HOME",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE",
]);

async function seedSemanticState(config: OpenClawConfig, sourceConfig = config) {
  const rootDir = tempDirs.make("openclaw-doctor-lint-");
  const stateDir = path.join(rootDir, "operator-state");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(sourceConfig)}\n`);
  const env = {
    ...process.env,
    HOME: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  };
  await seedInstalledPluginIndex({}, { config, env, stateDir, workspaceDir: rootDir });
  const databasePath = resolveOpenClawStateSqlitePath(env);
  await closeOpenClawStateDatabaseByPathAsync(databasePath);
  createDoctorLintSemanticIndex(stateDir);
  Object.assign(process.env, {
    HOME: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
  });
  mocks.readConfigFileSnapshot.mockImplementation(mocks.actualReadConfigFileSnapshot);
  return { stateDir, configPath, env, databasePath };
}

function useDirectChecks() {
  vi.spyOn(bundledHealthChecks, "registerBundledHealthChecks").mockImplementation(() => []);
  vi.spyOn(bundledHealthChecks, "resolveBundledHealthCheckPluginStateMode").mockReturnValue(
    "direct",
  );
}

describe("runDoctorLintCli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readConfigFileSnapshot.mockReset();
    mocks.resolveDoctorContributionHealthChecks
      .mockReset()
      .mockImplementation(mocks.actualResolveDoctorContributionHealthChecks);
    mocks.buildGatewayProbeConnectionDetails.mockReset().mockResolvedValue({
      url: "ws://127.0.0.1:18789",
    });
    mocks.callGateway.mockReset().mockResolvedValue({ degradedSecretOwners: [] });
    mocks.openNodeSqliteDatabase.mockImplementation(mocks.actualOpenNodeSqliteDatabase);
    mocks.prepareSqliteReadOnlyLocation.mockReset();
    mocks.prepareSqliteReadOnlyLocation.mockImplementation(
      mocks.actualPrepareSqliteReadOnlyLocation,
    );
    clearHealthChecksForTest();
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    originalEnv.restore();
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: originalIsTTY });
  });

  it.each([
    { label: "--only JSON", selection: "only", json: true },
    { label: "--only human text", selection: "only", json: false },
    { label: "--all JSON", selection: "all", json: true },
    { label: "--all human text", selection: "all", json: false },
    { label: "default JSON", selection: "default", json: true },
    { label: "default human text", selection: "default", json: false },
  ] as const)("keeps Gateway-owned secret degradation observable through $label", async (entry) => {
    const gatewayCheck = CORE_HEALTH_CHECKS.find(
      (check) => check.id === "core/doctor/gateway-health",
    );
    expect(gatewayCheck).toBeDefined();
    mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([gatewayCheck]);
    useDirectChecks();
    mockConfig({
      gateway: { mode: "local", auth: { mode: "token", token: "SYNTHETIC_GATEWAY_SECRET" } },
    });
    mocks.callGateway.mockResolvedValue({
      secretEgressProxy: {
        state: "degraded",
        caExpiresAt: "2036-09-01T00:00:00.000Z",
        failedCertificates: 1,
        message: "Check OpenSSL, then retry the request.",
      },
      degradedSecretOwners: [
        {
          ownerKind: "account",
          ownerId: "discord:ops",
          state: "unavailable",
          paths: ["channels.discord.accounts.ops.token"],
          reason:
            "secret reference was not found (env:default:PRIVATE_REF_ID=SYNTHETIC_OWNER_SECRET)",
        },
      ],
    });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: !entry.json });
    const exitCode = await runDoctorLintCli(runtime, {
      ...(entry.json ? { json: true } : {}),
      ...(entry.selection === "only"
        ? { onlyIds: ["core/doctor/gateway-health"] }
        : entry.selection === "all"
          ? { includeAllChecks: true }
          : {}),
    });
    const output = outputText();

    if (entry.selection === "default") {
      expect(exitCode).toBe(0);
      if (entry.json) {
        expect(JSON.parse(output)).toMatchObject({
          checksRun: 1,
          checksSkipped: 1,
          findings: [],
        });
      } else {
        expect(output).toContain("0 finding(s)");
        expect(output).toContain("  no findings\n");
      }
      expect(mocks.buildGatewayProbeConnectionDetails).not.toHaveBeenCalled();
      expect(mocks.callGateway).not.toHaveBeenCalled();
      return;
    }

    expect(exitCode).toBe(1);
    expect(output).toContain("core/doctor/gateway-health");
    expect(output).toContain("cold account:discord:ops");
    expect(output).toContain("Secret egress proxy: Check OpenSSL, then retry the request.");
    expect(output).toContain("channels.discord.accounts.ops.token");
    expect(output).toContain("openclaw secrets reload");
    expect(output).not.toContain("SYNTHETIC_GATEWAY_SECRET");
    expect(output).not.toContain("SYNTHETIC_OWNER_SECRET");
    expect(output).not.toContain("PRIVATE_REF_ID");
    expect(mocks.callGateway).toHaveBeenCalledOnce();
    if (entry.json) {
      expect(JSON.parse(output)).toMatchObject({
        ok: false,
        checksRun: entry.selection === "only" ? 1 : 2,
        findings: [
          {
            checkId: "core/doctor/gateway-health",
            severity: "warning",
            path: "channels.discord.accounts.ops.token",
            target: "account:discord:ops",
          },
          {
            checkId: "core/doctor/gateway-health",
            severity: "warning",
            path: "secrets.egressProxy.enabled",
            target: "capability:secret-egress-proxy",
          },
        ],
      });
    } else {
      expect(output).toContain("[warning] core/doctor/gateway-health");
    }
  });

  it.each(["warning", "error"] as const)(
    "keeps every database store in JSON when findings are filtered at %s",
    async (severityMin) => {
      const databaseStores = [
        { family: "state", observed: "sqlite", mismatch: false },
        { family: "agent", observed: "unknown", mismatch: null },
      ];
      mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
        {
          id: "core/doctor/database-engine",
          kind: "core",
          description: "Database diagnostics",
          detect: async () =>
            databaseStores.map((details, index) => ({
              checkId: "core/doctor/database-engine",
              severity: index === 0 ? "info" : "warning",
              message: details.family,
              details,
            })),
        },
      ]);
      useDirectChecks();
      mockConfig();
      await runDoctorLintCli(runtime, {
        json: true,
        severityMin,
        onlyIds: ["core/doctor/database-engine"],
      });
      const output = JSON.parse(outputText());
      expect(output.databaseStores).toHaveLength(databaseStores.length);
      expect(output.databaseStores).toEqual(expect.arrayContaining(databaseStores));
      expect(output.findings).toEqual(
        severityMin === "warning" ? [expect.objectContaining({ details: databaseStores[1] })] : [],
      );
    },
  );

  it("shares one captured config across registration and checks without freezing the source", async () => {
    const config = { agents: { entries: { main: { name: "original" } } } };
    mockConfig(config);
    const detect = vi.fn(async (ctx: HealthCheckContext) => {
      expect(captureRuntimeConfig(ctx.cfg)).toBe(ctx.cfg);
      return [];
    });
    registerHealthCheck({
      id: "test/captured-config",
      kind: "plugin",
      description: "Checks the read-only config capture",
      detect,
    });
    const registration = vi.spyOn(bundledHealthChecks, "registerBundledHealthChecks");
    expect(await runDoctorLintCli(runtime, { json: true, onlyIds: ["test/captured-config"] })).toBe(
      0,
    );
    expect(detect).toHaveBeenCalledOnce();
    const captured = detect.mock.calls[0]?.[0].cfg;
    expect(captured).toEqual(config);
    expect(captured).not.toBe(config);
    expect(registration.mock.calls[0]?.[0].cfg).toBe(captured);
    config.agents.entries.main.name = "changed";
    expect(captured?.agents?.entries?.main?.name).toBe("original");
  });

  it("does not expose deep mode to extension health check context", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot({}));
    const detect = vi.fn(async (_ctx: unknown) => []);
    registerHealthCheck({
      id: "test/deep-context",
      kind: "plugin",
      description: "test extension context",
      detect,
    });

    await runDoctorLintCli(runtime, {
      deep: true,
      onlyIds: ["test/deep-context"],
    });

    expect(detect).toHaveBeenCalledWith(expect.objectContaining({ mode: "lint" }));
    expect(detect.mock.calls[0]?.[0]).not.toHaveProperty("deep");
    expect(detect.mock.calls[0]?.[0]).not.toHaveProperty("lintConfigSnapshot");
  });

  it("rejects unknown --only health check ids instead of reporting a false-clean run", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue(createTestConfigSnapshot({}));

    const outputSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const exitCode = await runDoctorLintCli(runtime, {
        json: true,
        onlyIds: ["core/doctor/not-a-check"],
      });

      expect(exitCode).toBe(1);
      const payload = JSON.parse(String(outputSpy.mock.calls.at(-1)?.[0]));
      expect(payload).toMatchObject({
        ok: false,
        checksRun: 0,
        findings: [
          {
            checkId: "core/doctor/lint-selection",
            severity: "error",
            path: "core/doctor/not-a-check",
          },
        ],
      });
    } finally {
      outputSpy.mockRestore();
    }
  });

  it("reports disabled Codex plugin routes through doctor lint", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue(
      createTestConfigSnapshot({
        plugins: { entries: { codex: { enabled: false } } },
        agents: { defaults: { model: { primary: "gpt-5.5" } } },
      }),
    );
    const exitCode = await runDoctorLintCli(runtime, {
      json: true,
      onlyIds: ["core/doctor/codex-session-routes"],
    });

    expect(exitCode).toBe(1);
    const payload = outputReport();
    expect(payload).toMatchObject({
      ok: false,
      checksRun: 1,
      findings: [
        {
          checkId: "core/doctor/codex-session-routes",
          severity: "warning",
          path: "agents.defaults.model.primary",
          target: "openai/gpt-5.5",
        },
      ],
    });
    expect(payload.findings[0].message).toContain("Codex plugin is disabled by config");
    // Explicit plugins.entries.codex.enabled=false blocks auto-repair, so the
    // hint names the manual action instead of promising doctor --fix.
    expect(payload.findings[0].fixHint).toContain("Enable plugins.entries.codex");
  });

  it("reports an actionable Crabbox profile finding before dispatch", async () => {
    const binary = "/nonexistent/path/to/crabbox";
    mockConfig({
      gateway: { mode: "local", port: 19_001 },
      cloudWorkers: {
        profiles: {
          aws: {
            provider: "crabbox",
            install: "bundle",
            settings: { provider: "aws", class: "standard", binary },
          },
        },
      },
    });
    for (let run = 0; run < 2; run++) {
      await expectFailedCheck(CRABBOX_CLOUD_WORKER_PROFILE_CHECK_ID, {
        severity: "warning",
        path: binary,
        target: "aws",
      });
    }
    const payload = outputReport();
    expect(payload.findings[0].message).toContain('profile "aws"');
    expect(payload.findings[0].fixHint).toContain("cloudWorkers.profiles.aws.settings.binary");
  });

  it.each([false, true])(
    "runs post-plugin readiness on an isolated snapshot without plugin gates (inline inspections: %s)",
    async (includeOptionalInspections) => {
      const config = {
        ...semanticConfig,
        agents: { defaults: { model: { primary: "openai/gpt-5.5" } } },
      } satisfies OpenClawConfig;
      const sourceConfig = { ...config, legacyPluginState: { directory: "retained-input" } };
      const { env, databasePath, configPath } = await seedSemanticState(config, sourceConfig);
      await recordDeferredPluginMigrations({
        env,
        pending: [
          {
            pluginId: "fixture-plugin",
            reason: "The configured plugin is unavailable.",
            command: "openclaw doctor --fix",
            configPaths: [["legacyPluginState"]],
            validationExcludedPaths: [["legacyPluginState"]],
          },
        ],
      });
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      clearLoadInstalledPluginIndexInstallRecordsCache();
      const before = snapshotDoctorLintSqliteFamily(databasePath);
      const fork = vi.spyOn(snapshotSource, "forkSqlitePrivateSnapshot");
      mocks.openNodeSqliteDatabase.mockClear();
      const sourceOpenStacks: string[] = [];
      mocks.openNodeSqliteDatabase.mockImplementation((...args: unknown[]) => {
        if (args[0] === databasePath || args[0] === resolveExistingSqliteFileUri(databasePath)) {
          sourceOpenStacks.push(new Error("source database opened").stack ?? "");
        }
        return mocks.actualOpenNodeSqliteDatabase(...args);
      });
      process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE = "1";
      const inspectOptionalDiagnostic = vi.fn(async () => [
        {
          checkId: "core/doctor/deferred-inspection",
          severity: "error" as const,
          message: "Optional inspection needs attention.",
        },
      ]);
      mocks.resolveDoctorContributionHealthChecks.mockResolvedValue([
        ...CORE_HEALTH_CHECKS.filter((check) => check.id === "core/doctor/security"),
        {
          id: "core/doctor/deferred-inspection",
          kind: "core",
          description: "Synthetic optional diagnostic",
          updateWork: { kind: "inspection", scope: "run" },
          detect: inspectOptionalDiagnostic,
        },
      ]);

      await expect(
        runDoctorLintCli(runtime, {
          json: true,
          severityMin: "error",
          includeAllChecks: includeOptionalInspections,
        }),
      ).resolves.toBe(0);
      const report = outputReport();
      // The semantic index needs llama.cpp, but plugin-owned checks never gate an update.
      expect(report).toMatchObject({ ok: true, findings: [] });
      expect(inspectOptionalDiagnostic).toHaveBeenCalledTimes(includeOptionalInspections ? 1 : 0);
      const inspectionWarnings = (report.warnings ?? []).filter(
        (finding: { checkId: string }) => finding.checkId === "core/doctor/deferred-inspection",
      );
      expect(inspectionWarnings).toEqual(
        includeOptionalInspections
          ? [
              expect.objectContaining({
                severity: "warning",
                message: "Optional inspection needs attention.",
              }),
            ]
          : [],
      );
      expect(mocks.prepareSqliteReadOnlyLocation).not.toHaveBeenCalled();
      expect(fork).toHaveBeenCalledOnce();
      expect(fork.mock.calls[0]?.[0]).not.toBe(databasePath);
      expect(sourceOpenStacks).toEqual([]);
      expect(snapshotDoctorLintSqliteFamily(databasePath)).toEqual(before);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual(sourceConfig);
    },
  );

  it.each([false, true])("checks the operator disk volume in mixed lint: %s", async (mixed) => {
    const { stateDir, databasePath } = await seedSemanticState({
      gateway: { mode: "local" },
    });
    const before = snapshotDoctorLintSqliteFamily(databasePath);
    vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
      targetPath,
      checkedPath: targetPath,
      availableBytes: targetPath === stateDir ? 50 * 1024 ** 2 : 10 * 1024 ** 3,
      totalBytes: 20 * 1024 ** 3,
    }));

    const diskCheckId = "core/doctor/disk-space";
    await expectFailedCheck(
      diskCheckId,
      { severity: "error", path: stateDir },
      { severityMin: "error", onlyIds: mixed ? [diskCheckId, MEMORY_CHECK_ID] : [diskCheckId] },
    );
    expect(snapshotDoctorLintSqliteFamily(databasePath)).toEqual(before);
  });

  it("fails closed when a semantic index needs plugin state that cannot be prepared", async () => {
    const { databasePath: pluginDatabasePath } = await seedSemanticState(semanticConfig);
    mocks.prepareSqliteReadOnlyLocation.mockImplementation((...args: unknown[]) => {
      if (args[0] === pluginDatabasePath) {
        throw new Error("shared state did not stabilize");
      }
      return mocks.actualPrepareSqliteReadOnlyLocation(...args);
    });

    await expectFailedCheck(
      MEMORY_CHECK_ID,
      {
        severity: "error",
        target: "memory-core",
        requirement: "memory-index-inspection",
        message: expect.stringContaining("shared state did not stabilize"),
      },
      { severityMin: "error" },
    );
    expect(mocks.readConfigFileSnapshot).not.toHaveBeenCalled();
    expect(mocks.prepareSqliteReadOnlyLocation).toHaveBeenCalledWith(pluginDatabasePath, {
      preserveSourceArtifacts: true,
      shared: false,
    });
  });

  it("rejects registered checks that claim reserved core doctor ids", async () => {
    mockConfig();
    registerHealthCheck({
      id: "core/doctor/not-yet-owned",
      kind: "core",
      description: "reserved core-kind lint check",
      async detect() {
        return [];
      },
    });

    await expect(runDoctorLintCli(runtime, { json: true })).rejects.toThrow(
      "health check already registered: core/doctor/not-yet-owned",
    );
  });

  describe("progress on an interactive stderr", () => {
    const originalStderrIsTTY = process.stderr.isTTY;
    let stderr: MockInstance<typeof process.stderr.write>;
    const stderrText = () => stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
    const labels = () =>
      mocks.progressEvents
        .filter((event) => event.startsWith("label "))
        .map((event) => event.slice("label ".length));
    const setStderrTTY = (value: boolean) =>
      Object.defineProperty(process.stderr, "isTTY", { configurable: true, value });

    beforeEach(() => {
      mocks.progressEvents.length = 0;
      stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    });
    afterEach(() => {
      setStderrTTY(originalStderrIsTTY);
    });

    function registerPendingCheck(id: string) {
      let release: () => void = () => {};
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      registerHealthCheck({
        id,
        kind: "plugin",
        description: "waits until the test releases it",
        detect: async () => {
          await pending;
          return [];
        },
      });
      return () => release();
    }

    it("shows the pending check on one spinner line and erases it before the report", async () => {
      mockConfig();
      setStderrTTY(true);
      const release = registerPendingCheck("test/pending-check");

      const run = runDoctorLintCli(runtime, { onlyIds: ["test/pending-check"] });
      await vi.waitFor(() =>
        expect(stderrText()).toContain("Doctor lint: check 1/1 (0%) test/pending-check"),
      );
      expect(mocks.progressEvents[0]).toBe("create enabled=true");
      expect(labels()).toEqual([
        "Doctor lint: preparing state snapshot",
        "Doctor lint: loading config and checks",
        "Doctor lint: check 1/1 (0%) test/pending-check",
      ]);
      expect(stdout).not.toHaveBeenCalled();

      release();
      expect(await run).toBe(0);
      expect(mocks.progressEvents.at(-1)).toBe("done");
      expect(JSON.parse(outputText())).toMatchObject({ ok: true, checksRun: 1, findings: [] });
    });

    it("shows preparation while the config snapshot is still loading", async () => {
      let resolveSnapshot: () => void = () => {};
      mocks.readConfigFileSnapshot.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveSnapshot = () => resolve(createTestConfigSnapshot({}));
          }),
      );
      setStderrTTY(true);
      registerHealthCheck({
        id: "test/after-preparation",
        kind: "plugin",
        description: "runs after preparation",
        detect: async () => [],
      });

      const run = runDoctorLintCli(runtime, { onlyIds: ["test/after-preparation"] });
      await vi.waitFor(() =>
        expect(labels().at(-1)).toBe("Doctor lint: loading config and checks"),
      );
      expect(labels().some((label) => label.includes(" check "))).toBe(false);

      resolveSnapshot();
      expect(await run).toBe(0);
      expect(labels()).toContain("Doctor lint: check 1/1 (0%) test/after-preparation");
      expect(JSON.parse(outputText())).toMatchObject({ ok: true, checksRun: 1 });
    });

    it("writes no progress when stderr is not a terminal", async () => {
      mockConfig();
      setStderrTTY(false);
      registerHealthCheck({
        id: "test/piped",
        kind: "plugin",
        description: "piped run",
        detect: async () => [],
      });

      expect(await runDoctorLintCli(runtime, { onlyIds: ["test/piped"] })).toBe(0);
      expect(stderrText()).not.toContain("Doctor lint:");
      expect(JSON.parse(outputText())).toMatchObject({ ok: true, checksRun: 1 });
    });

    it("writes no progress for an explicit --json", async () => {
      mockConfig();
      setStderrTTY(true);
      registerHealthCheck({
        id: "test/explicit-json",
        kind: "plugin",
        description: "explicit json run",
        detect: async () => [],
      });

      expect(await runDoctorLintCli(runtime, { json: true, onlyIds: ["test/explicit-json"] })).toBe(
        0,
      );
      expect(mocks.progressEvents[0]).toBe("create enabled=false");
      expect(stderrText()).not.toContain("Doctor lint:");
      expect(JSON.parse(outputText())).toMatchObject({ ok: true, checksRun: 1 });
    });

    it("writes no progress during an update Doctor lint pass", async () => {
      mockConfig();
      setStderrTTY(true);
      process.env.OPENCLAW_UPDATE_POST_CORE_CONVERGENCE = "1";
      registerHealthCheck({
        id: "test/update-pass",
        kind: "plugin",
        description: "update pass",
        detect: async () => [],
      });

      await runDoctorLintCli(runtime, { onlyIds: ["test/update-pass"] });
      expect(mocks.progressEvents[0]).toBe("create enabled=false");
      expect(stderrText()).not.toContain("Doctor lint:");
    });

    it("stops the spinner when a check throws", async () => {
      // Only the spinner's frame interval is faked, so the run's own I/O keeps real time.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      try {
        mockConfig();
        setStderrTTY(true);
        let fail: () => void = () => {};
        const failing = new Promise<void>((resolve) => {
          fail = resolve;
        });
        registerHealthCheck({
          id: "test/throws",
          kind: "plugin",
          description: "throws while the spinner runs",
          detect: async () => {
            await failing;
            throw new Error("boom");
          },
        });

        const run = runDoctorLintCli(runtime, { onlyIds: ["test/throws"] });
        await vi.waitFor(() => expect(labels().at(-1)).toContain("test/throws"));
        const writesBeforeFrames = stderr.mock.calls.length;
        vi.advanceTimersByTime(500);
        expect(stderr.mock.calls.length).toBeGreaterThan(writesBeforeFrames);

        fail();
        expect(await run).toBe(1);
        expect(mocks.progressEvents.at(-1)).toBe("done");
        expect(JSON.parse(outputText())).toMatchObject({
          ok: false,
          findings: [expect.objectContaining({ checkId: "test/throws", severity: "error" })],
        });
        const writesAfterRun = stderr.mock.calls.length;
        vi.advanceTimersByTime(500);
        expect(stderr.mock.calls.length).toBe(writesAfterRun);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("rejects invalid severity thresholds", async () => {
    await expect(runDoctorLintCli(runtime, { severityMin: "warnng" })).rejects.toThrow(
      "Invalid --severity-min value",
    );
  });
});
