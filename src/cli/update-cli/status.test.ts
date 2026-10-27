import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as configModule from "../../config/config.js";
import { recordDeferredPluginMigrations as recordMigrations } from "../../infra/deferred-plugin-migrations.js";
import {
  completeGatewayBootLifecycle,
  beginGatewayBootLifecycle,
} from "../../infra/gateway-boot-lifecycle.js";
import {
  createSessionSqliteMigrationRun as createMigration,
  updateMigrationManifestTarget as updateMigration,
  writeSessionSqliteMigrationManifest as writeMigration,
} from "../../infra/session-sqlite-migration-manifest.js";
import * as updateCheck from "../../infra/update-check.js";
import * as immutableInspection from "../../infra/update-immutable-inspection.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  createUpdateRun,
  findActiveUpdateRun,
  finishUpdateRun,
  getUpdateRun,
  listUpdateRuns,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import { ABANDONED_UPDATE_RUN_MS } from "../../infra/update-run-timeouts.js";
import {
  closeOpenClawStateDatabaseAsync as closeState,
  closeOpenClawStateDatabaseForTest as closeStateForTest,
  openOpenClawStateDatabase as openState,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath as statePathFor } from "../../state/openclaw-state-db.paths.js";
import { claimOpenClawStateOwnership } from "../../state/openclaw-state-ownership-operations.js";
import { updateStatusCommand as updateStatus } from "./status.js";
import { registerUpdateStatusWarningTests } from "./status.warnings.test-support.js";

const runtime = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  writeJson: vi.fn(),
  exit: vi.fn(),
}));

const service = vi.hoisted(() => ({
  readCommand: vi.fn(),
  resolveNodeRuntimeInfo: vi.fn(),
  audit: vi.fn(),
}));
const callGateway = vi.hoisted(() => vi.fn());
vi.mock("../../gateway/call.js", () => ({ callGateway }));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: service.readCommand }),
}));
vi.mock("../../daemon/service-audit.js", () => ({
  auditGatewayServiceConfig: service.audit,
}));
vi.mock("../../daemon/runtime-paths.js", () => ({
  resolveNodeRuntimeInfo: service.resolveNodeRuntimeInfo,
}));
vi.mock("../../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/paths.js")>()),
  isDefaultInstallIdentity: () => true,
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: runtime,
}));
vi.mock("../../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check.js")>()),
  checkUpdateStatus: async () => ({
    root: "/fixture/openclaw",
    installKind: "package",
    packageManager: "npm",
    registry: { latestVersion: "2026.9.2" },
  }),
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveUpdateRoot: async () => "/fixture/openclaw",
}));

const tempDirs = createTempDirTracker();
const outputText = () => runtime.log.mock.calls.flat().join("\n");
const jsonResult = () => runtime.writeJson.mock.lastCall?.[0];
function expectOutput(...included: string[]) {
  included.forEach((part) => expect(outputText()).toContain(part));
}
function mockImmutable(
  immutable: NonNullable<Awaited<ReturnType<typeof updateCheck.checkUpdateStatus>>["immutable"]>,
  latestVersion?: string,
) {
  vi.spyOn(updateCheck, "checkUpdateStatus").mockResolvedValue({
    root: immutable.currentPath,
    installKind: "immutable",
    packageManager: "unknown",
    immutable,
    ...(latestVersion ? { registry: { latestVersion } } : {}),
  });
}
async function textStatus() {
  await updateStatus({});
  return outputText();
}
async function jsonStatus() {
  await updateStatus({ json: true });
  return jsonResult();
}

beforeEach(() => {
  vi.clearAllMocks();
  callGateway.mockReset().mockRejectedValue(new Error("Gateway unavailable"));
  service.readCommand.mockResolvedValue(null);
  service.audit.mockResolvedValue({ ok: true, issues: [] });
  const stateDir = tempDirs.make("openclaw-update-status-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
});

it.each([
  { json: true, remote: false },
  { json: false, remote: false },
  { json: true, remote: true },
])("local replacement (JSON: $json, remote: $remote)", async ({ json, remote }) => {
  const reason = "gateway.installation_replaced: on-disk 2026.9.5 differs from running 2026.9.4";
  const completedAtMs = Date.UTC(2026, 8, 19, 12);
  const bootId = (await beginGatewayBootLifecycle(process.env, completedAtMs - 1_000)).id;
  await completeGatewayBootLifecycle(
    bootId,
    { outcome: "planned_restart", reason },
    process.env,
    completedAtMs,
  );
  if (remote) {
    vi.spyOn(configModule, "readSourceConfigBestEffort").mockResolvedValue({
      gateway: { mode: "remote" },
    });
  }

  await updateStatus({ json });

  if (remote) {
    expect(jsonResult()).not.toHaveProperty("lastGatewayInstallationReplacement");
  } else if (json) {
    expect(jsonResult()).toMatchObject({
      lastGatewayInstallationReplacement: { reason, completedAtMs },
    });
  } else {
    expectOutput(
      "Previous Gateway installation replacement",
      new Date(completedAtMs).toISOString(),
      reason,
    );
  }
});

it.each([
  { json: false, failure: null },
  { json: true, failure: "read" },
  { json: true, failure: "audit" },
])("service facts (JSON: $json, failure: $failure)", async ({ json, failure }) => {
  const drift = [{ message: "Service.KillMode: missing; installer expects mixed." }];
  service.readCommand.mockResolvedValue({ programArguments: ["/fixture/gateway"] });
  service.audit.mockResolvedValue({ ok: true, issues: [], definitionDrift: drift });
  if (failure === "read") {
    service.readCommand.mockRejectedValue(new Error("Service manager unavailable"));
  } else if (failure === "audit") {
    service.audit.mockResolvedValue({
      ok: true,
      issues: [],
      definitionDriftError: "Service definition inspection failed: unit unreadable",
    });
  }

  await updateStatus({ json });

  if (failure) {
    expect(jsonResult()).toMatchObject({
      availability: expect.any(Object),
      serviceDefinition: {
        drift: [],
        warnings: [expect.stringContaining("inspection failed")],
      },
    });
  } else {
    expectOutput(drift[0]!.message);
  }
});

it.each([false, true])("immutable coverage, not package updates (JSON: %s)", async (json) => {
  const immutable = {
    root: "/opt/openclaw",
    currentSha: "a".repeat(40),
    currentPath: `/opt/openclaw/releases/${"a".repeat(40)}`,
    prepared: {
      sha: "b".repeat(40),
      path: `/opt/openclaw/releases/${"b".repeat(40)}`,
      buildDigest: "c".repeat(64),
      preparedAtMs: 123,
    },
  };
  mockImmutable(immutable, "99.0.0");
  const coverage: immutableInspection.ImmutableUpdateCoverage = {
    target: {
      sha: immutable.prepared.sha,
      preparation: "prepared",
      schemaVersions: { state: 20, agent: 25 },
    },
    unsupportedReasons: [
      "Immutable activation does not support the agent schema crossing 24 → 25.",
    ],
    warnings: [],
  };
  vi.spyOn(immutableInspection, "inspectImmutableUpdateCoverage").mockResolvedValue(coverage);

  await updateStatus({ json });
  if (json) {
    expect(jsonResult()).toMatchObject({ immutableCoverage: coverage });
    return;
  }
  expectOutput(
    "immutable (/opt/openclaw)",
    "aaaaaaaaaaaa",
    "prepared bbbbbbbbbbbb",
    "activation unavailable",
    "agent schema crossing 24 → 25",
  );
  expect(outputText()).not.toContain("npm update");
});

it.each([
  { outcome: "succeeded", label: "accepted", pending: true, verified: true },
  { outcome: "rolled-back", label: "restored", pending: false, verified: true },
  { outcome: "succeeded", label: "accepted", pending: false, verified: false },
] as const)(
  "reports immutable $label history separately from pending recovery",
  async ({ outcome, label, pending, verified }) => {
    const immutable = {
      root: "/opt/example",
      currentSha: "a".repeat(40),
      currentPath: "/opt/example/current",
      activationEnabled: true,
      activation: pending
        ? {
            operationId: "11111111-1111-4111-8111-111111111111",
            phase: "verifying" as const,
            previousSha: "a".repeat(40),
            candidateSha: "b".repeat(40),
            failure: "candidate-verification-pending",
            recoveryCommand: "/usr/bin/node /opt/example.control/recovery.mjs",
          }
        : undefined,
      lastActivation: {
        operationId: "22222222-2222-4222-8222-222222222222",
        outcome,
        selectedSha: "a".repeat(40),
        verifiedAtMs: 1000,
        gateway: verified
          ? {
              pid: 4242,
              bootId: "fixture-boot",
              version: "2026.10.1",
              buildId: "fixture-build",
            }
          : undefined,
      },
    };
    mockImmutable(immutable);
    await textStatus();
    expectOutput(label, "Last immutable activation", "verified");
    if (verified) {
      expectOutput("fixture-build", "PID 4242", "fixture-boot");
    } else {
      expect(outputText()).not.toContain("Last verified Gateway");
    }
    if (pending) {
      expectOutput(
        "pending recovery · verifying",
        "candidate-verification-pending",
        "/usr/bin/node /opt/example.control/recovery.mjs",
      );
    }
    expect(await jsonStatus()).toMatchObject({ update: { immutable } });
  },
);

it.each([true, false])("shows the Gateway's recorded trust refusal (JSON: %s)", async (json) => {
  const issue = {
    channel: "feishu",
    accountId: "default",
    kind: "runtime",
    message:
      'Plugin "feishu" loaded from "/fixture/plugins-local/feishu/index.js"; installSource="path". Install the official npm package or ClawHub listing.',
    fix: "resolve the reported channel error, then restart the channel",
  };
  callGateway.mockResolvedValue({ statusIssues: [issue] });

  await updateStatus({ json, timeout: "2" });

  expect(callGateway).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      method: "channels.status",
      params: { probe: false, timeoutMs: 2_000 },
      timeoutMs: 2_000,
      sharedStateMode: "read-only",
    }),
  );
  if (json) {
    expect(jsonResult().channelIssues).toEqual([issue]);
  } else {
    expectOutput(`Channel feishu default: ${issue.message}`, issue.fix);
  }
});

it.each([true, false])(
  "preserves diagnostics when SQLite history is unsafe (JSON: %s)",
  async (json) => {
    const sqliteVersion = "3.51.2";
    const recorded = createUpdateRun({ trigger: "cli" });
    await closeState();
    closeStateForTest();
    const workerThreads = process.getBuiltinModule("node:worker_threads");
    const admissionKey = "openclaw.sqliteNativeRuntimeAdmission";
    const inheritedAdmission = workerThreads.getEnvironmentData(admissionKey);
    onTestFinished(() => workerThreads.setEnvironmentData(admissionKey, inheritedAdmission));
    // Module resets retain worker admission; force this fixture to observe its unsafe library.
    workerThreads.setEnvironmentData(admissionKey, undefined);
    vi.resetModules();
    const sqlitePrototype: {
      prepare: (this: DatabaseSync, sql: string) => ReturnType<DatabaseSync["prepare"]>;
    } = DatabaseSync.prototype;
    const realPrepare = sqlitePrototype.prepare;
    const prepare = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      return realPrepare.call(this, sql.replaceAll("sqlite_version()", `'${sqliteVersion}'`));
    });
    const freshGuard = await import("../../infra/runtime-guard.js");
    vi.spyOn(freshGuard, "detectRuntime").mockResolvedValue({
      kind: "node",
      version: process.versions.node,
      execPath: "/fixture/node",
      pathEnv: "/fixture",
      hasNodeSqlite: true,
      sqliteVersion,
      sqliteProbe: {
        available: true,
        version: sqliteVersion,
        text: true,
        blob: true,
        json: true,
      },
    });
    const command = await import("./status.js");
    const ledger = await import("../../infra/update-run-ledger.js");
    const readOwner = await import("../../state/openclaw-state-db-readonly.js");
    const workerRead = vi.spyOn(readOwner, "executeExistingOpenClawStateRead");
    let nativeFailure: unknown;
    expect(() => {
      try {
        ledger.findActiveUpdateRun();
      } catch (error) {
        nativeFailure = error;
        throw error;
      }
    }).toThrow("SQLite support is unavailable or unsafe");
    // The host SQLite spy cannot cross threads; deliver the same runtime refusal
    // through the async read owner without replacing status or diagnostic logic.
    workerRead.mockRejectedValue(nativeFailure);
    await expect(command.updateStatusCommand({ json })).resolves.toBeUndefined();
    if (json) {
      const result = jsonResult();
      expect(result).toHaveProperty("availability");
      expect(result).toMatchObject({
        runStatusError: expect.any(String),
        runtimeFindings: [
          {
            severity: "error",
            message: expect.stringContaining("SQLite 3.51.2"),
            fixHint: expect.stringContaining("nvm install 26"),
          },
        ],
      });
      expect([result?.activeRun, result?.lastRun]).toEqual([undefined, undefined]);
      expect(result).not.toHaveProperty("abandonedRun");
    } else {
      expectOutput(
        "OpenClaw update status",
        "Update run status unavailable:",
        "SQLite 3.51.2",
        "nvm install 26",
      );
    }
    workerRead.mockRestore();
    prepare.mockRestore();
    expect(ledger.getUpdateRun(recorded.runId)).toEqual(recorded);
  },
);

it.each([
  { version: "24.22.1", state: "admitted" },
  { version: "26.0.0", state: "unsupported" },
])("reports $state service Node $version", async ({ version, state }) => {
  vi.stubGlobal("process", {
    ...process,
    versions: { ...process.versions, node: "26.12.1" },
  });
  service.readCommand.mockResolvedValue({
    programArguments: ["/fixture/node", "openclaw.mjs", "gateway"],
  });
  service.resolveNodeRuntimeInfo.mockResolvedValue({
    status: state === "unsupported" ? "unsupported" : "supported",
    version,
    sqliteVersion: state === "unsupported" ? "3.50.2" : "3.53.0",
    nodeSharedSqlite: false,
  });
  if (state === "unsupported") {
    await updateStatus({ json: true });
    expect(jsonResult()).toMatchObject({
      runtimeFindings: [
        {
          source: "gateway-service",
          message: expect.stringContaining(version),
          requirement: expect.stringContaining(">=24.22.1 <25, or >=26.12.1"),
          fixHint: expect.stringContaining("https://openclaw.ai/install.sh"),
        },
      ],
    });
  }
  await updateStatus({});
  if (state === "admitted") {
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("nvm install 26"));
  } else {
    expectOutput(version, "npm", "nvm install 26");
  }
});

afterEach(async () => {
  await closeState();
  closeStateForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  tempDirs.cleanup();
});

registerUpdateStatusWarningTests(() => outputText());

it.each([false, true])(
  "prioritizes an active update over availability (finished=%s)",
  async (finished) => {
    vi.spyOn(updateCheck, "checkUpdateStatus").mockResolvedValue({
      root: "/fixture/openclaw",
      installKind: "package",
      packageManager: "npm",
      registry: { latestVersion: "9999.0.0" },
    });
    const run = createUpdateRun({ trigger: "cli" });
    await recordMigrations({
      pending: [
        {
          pluginId: "sample",
          reason: "Plugin upgrade did not complete.",
          command: "openclaw doctor --fix",
        },
      ],
    });
    recordUpdateRunPhase(run.runId, "validating");
    if (finished) {
      finishUpdateRun(run.runId, { status: "succeeded" });
    }
    const output = await textStatus();
    expect(output.includes("available ·")).toBe(finished);
    expect(output.includes("Update available")).toBe(finished);
    expect(output.includes("Let the current update or repair finish")).toBe(!finished);
    if (!finished) {
      expect(output).toContain("in progress · validating");
      expect(output.trim()).toMatch(/Check progress with openclaw update status\.$/);
    }
    expect(await jsonStatus()).toMatchObject({
      availability: { available: true },
    });
  },
);

it.each([true, false])("unreadable migration preserves availability (JSON: %s)", async (json) => {
  await recordMigrations({
    pending: [
      {
        pluginId: "codex",
        reason: "The configured plugin package is missing.",
        command: "openclaw plugins install @openclaw/codex",
      },
    ],
  });
  openState()
    .db.prepare("UPDATE migration_runs SET report_json = ? WHERE id = ?")
    .run("not-json", "deferred-plugin-migration:codex");
  await expect(updateStatus({ json })).resolves.toBeUndefined();
  if (json) {
    const result = jsonResult();
    expect(result).toMatchObject({
      availability: expect.any(Object),
      migrationWarningsError: expect.any(String),
    });
    expect(result).not.toHaveProperty("migrationWarnings");
  } else {
    expectOutput("OpenClaw update status", "Pending migration status unavailable:");
  }
});

it("reports retained session migration warnings without an update ledger", async () => {
  const stateDir = process.env.OPENCLAW_STATE_DIR!;
  const targets = ["main", "other"].map((agentId) => ({
    agentId,
    storePath: path.join(stateDir, "agents", agentId, "sessions", "sessions.json"),
    sqlitePath: path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite"),
  }));
  const warnings = [
    { code: "entry_invalid", message: "Missing sessionId.", sessionKey: "agent:main:invalid" },
    { code: "transcript_malformed", message: "Malformed JSONL.", sessionKey: "agent:other:broken" },
  ];
  const first = createMigration(process.env, targets);
  for (const [index, target] of targets.entries()) {
    updateMigration(first, target, [warnings[index]!], {
      validationBeforeArchive: "passed",
    });
  }
  first.manifest.completedAt = new Date().toISOString();
  writeMigration(first);
  const expectedWarnings = targets.map(
    (target, index) =>
      `${target.storePath}: [${warnings[index]!.code}] ${warnings[index]!.message}`,
  );
  const expectWarnings = async (expected: string[]) => {
    runtime.log.mockClear();
    runtime.writeJson.mockClear();
    const result = await jsonStatus();
    expect(result.migrationWarnings).toEqual(expected);
    expect(result).not.toHaveProperty("lastRun");
  };
  await expectWarnings(expectedWarnings);

  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1_000);
  const retry = createMigration(process.env, [targets[0]!]);
  await expectWarnings(expectedWarnings);
  retry.manifest.completedAt = new Date().toISOString();
  updateMigration(retry, targets[0]!, [], {
    validationBeforeArchive: "passed",
  });
  await expectWarnings(expectedWarnings.slice(1));
});

it("preserves readable history when reconciliation is refused", async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now - 25 * 60 * 60_000);
  const run = createUpdateRun({ trigger: "cli" });
  clock.mockReturnValue(now);
  claimOpenClawStateOwnership("test-supervisor", {
    env: { ...process.env, OPENCLAW_SUPERVISOR_MODE: "external" },
  });
  vi.stubEnv("OPENCLAW_SUPERVISOR_MODE", "");
  await textStatus();
  expectOutput(run.runId, "Update run reconciliation failed:");
  expect(outputText()).not.toContain("Update run status unavailable:");
  expect(getUpdateRun(run.runId)).toEqual(run);
});

it.each(["none", "active"])(
  "keeps expired admission history with a later %s run",
  async (laterRun) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now - 25 * 60 * 60_000);
    const legacy = createUpdateRun({ trigger: "cli", before: { version: "2026.9.2" } });
    clock.mockReturnValue(now);
    if (laterRun === "active") {
      await updateStatus({ json: true });
      expect(getUpdateRun(legacy.runId)?.reason).toBe("legacy-driver-expired");
      runtime.writeJson.mockClear();
    }
    let currentRunId = legacy.runId;
    if (laterRun !== "none") {
      clock.mockReturnValue(now + 1);
      currentRunId = createUpdateRun({ trigger: "cli" }).runId;
    }
    const output = await textStatus();
    const expired = getUpdateRun(legacy.runId);
    expect(expired).toMatchObject({
      phase: "finished",
      status: "failed",
      reason: "legacy-driver-expired",
    });
    expect(output).toContain("treated as abandoned after 24 h");
    expect(output.includes("Historical update:")).toBe(laterRun !== "none");
    expect(output.includes("Last recorded update (")).toBe(laterRun !== "active");
    expect(output.includes("run `openclaw update` to retry.")).toBe(laterRun === "none");
    expect(findActiveUpdateRun()?.runId).toBe(laterRun === "active" ? currentRunId : undefined);
    const result = await jsonStatus();
    expect((result.activeRun ?? result.lastRun)?.runId).toBe(currentRunId);
    expect(result.advisories).toEqual([
      {
        runId: legacy.runId,
        reason: "legacy-driver-expired",
        message: expect.stringContaining("treated as abandoned after 24 h"),
      },
    ]);
    expect(getUpdateRun(legacy.runId)).toEqual(expired);
  },
);

it("does not publish partial history when the latest terminal row is unreadable", async () => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const active = createUpdateRun({ trigger: "cli" });
  vi.mocked(Date.now).mockReturnValue(now + 1);
  const latest = createUpdateRun({ trigger: "cli" });
  finishUpdateRun(latest.runId, { status: "succeeded" });
  closeStateForTest();
  {
    using database = new DatabaseSync(statePathFor());
    database
      .prepare("UPDATE update_runs SET origin_json = ? WHERE run_id = ?")
      .run("not-json", latest.runId);
  }
  await updateStatus({ json: true });

  const result = jsonResult();
  expect(result?.runStatusError).toEqual(expect.any(String));
  expect(result).toHaveProperty("availability");
  for (const field of ["activeRun", "lastRun", "staleRun", "abandonedRun"]) {
    expect(result).not.toHaveProperty(field);
  }
  expect(getUpdateRun(active.runId)).toEqual(active);
  expect(() => listUpdateRuns({ limit: 1 })).toThrow();
});

it.each([undefined, "work"])("abandoned history stays read-only (profile=%s)", async (profile) => {
  vi.stubEnv("OPENCLAW_PROFILE", profile);
  const now = Date.now();
  const lastActivity = now - ABANDONED_UPDATE_RUN_MS - 10;
  const driver = readUpdateRunDriver();
  if (!driver) {
    throw new Error("Test process identity is unavailable");
  }
  vi.spyOn(Date, "now").mockReturnValue(lastActivity);
  const created = createUpdateRun({
    trigger: "control-ui",
    before: { version: "2026.9.2" },
    origin: {
      driver: { ...driver, startIdentity: String(Number(driver.startIdentity) + 1) },
    },
  });
  const recorded = recordUpdateRunPhase(created.runId, "staging");
  vi.mocked(Date.now).mockReturnValue(now);
  await updateStatus({});
  expect(getUpdateRun(created.runId)).toEqual(recorded);
  const cli = `openclaw${profile ? " --profile work" : ""}`;
  expectOutput(
    "Abandoned update detected;",
    `Stop the Gateway first (${cli} gateway stop)`,
    `${cli} update repair`,
  );
  expect(outputText()).not.toContain("update in progress:");
  expect(outputText()).not.toContain("update failed:");
});
