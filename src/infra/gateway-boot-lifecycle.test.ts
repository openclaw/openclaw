import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as crashCause from "../daemon/gateway-crash-cause.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { readConfigMachineStateAsync } from "../state/config-machine-state-async.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  GATEWAY_CRASH_LOOP_BREAKER_REASON as BREAKER,
  completeGatewayBootLifecycle,
  completeGatewayAgentRestartRecovery,
  reportPreviousGatewayCrash,
  formatGatewayCrashLoopManualChannelStartHint,
  inspectGatewayCrashLoopBreakerAsync,
  readGatewayLastInstallationReplacementAsync,
  readGatewayLastShutdownAsync,
  readGatewayRecentCrashesAsync,
  beginGatewayBootLifecycle,
  recordGatewayCrashLoopRecovery,
  repairGatewayMaintenanceStartupFailures,
} from "./gateway-boot-lifecycle.js";
import { GATEWAY_CRASH_LOOP_RECOVERED_REASON as RECOVERED } from "./gateway-boot-lifecycle.kernel.js";
import { gatewayBootOperations } from "./gateway-boot-lifecycle.worker.js";
import type { GatewayCrashState } from "./gateway-crash.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";
import { TAILSCALE_BACKEND_AUTH_REQUIRED_REASON } from "./tailscale-backend-auth-required-error.js";

type GatewayBootLifecycleTestDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_boot_lifecycle">;
type GatewayBootLifecycleOutcome = Parameters<typeof completeGatewayBootLifecycle>[1]["outcome"];
type BootRow = {
  bootId: string;
  startedAtMs: number;
  completedAtMs?: number | null;
  outcome?: GatewayBootLifecycleOutcome | null;
  startupReason?: string | null;
  reason?: string | null;
};
const bootRow = (
  bootId: string,
  startedAtMs: number,
  details: Omit<BootRow, "bootId" | "startedAtMs"> = {},
): BootRow => ({ bootId, startedAtMs, ...details });

const GATEWAY_BOOT_LOOP_WINDOW_MS = 5 * 60_000;
const GATEWAY_BOOT_LIFECYCLE_RETENTION_MS = 24 * 60 * 60_000;

type Decision = Awaited<ReturnType<typeof inspectGatewayCrashLoopBreakerAsync>>;
function expectDecision(decision: Decision, uncleanBoots: number, extra: Partial<Decision> = {}) {
  expect(decision).toMatchObject({ tripped: uncleanBoots >= 3, uncleanBoots, ...extra });
}

const tempDirs = createTempDirTracker();

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  tempDirs.cleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

function createLifecycleDb() {
  const stateDir = tempDirs.make("openclaw-gateway-boot-");
  const env = { OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
  const { db } = openOpenClawStateDatabase({ env });
  const kysely = getNodeSqliteKysely<GatewayBootLifecycleTestDatabase>(db);
  return {
    env,
    db,
    kysely,
    begin: (now: number) => beginGatewayBootLifecycle(env, now),
    complete: (
      id: string | undefined,
      outcome: GatewayBootLifecycleOutcome,
      now: number,
      details: Omit<Parameters<typeof completeGatewayBootLifecycle>[1], "outcome"> = {},
    ) => completeGatewayBootLifecycle(id, { outcome, ...details }, env, now),
    inspect: (now: number) => inspectGatewayCrashLoopBreakerAsync(env, now),
  };
}

function insertBootRows(
  params: ReturnType<typeof createLifecycleDb>,
  rows: ReadonlyArray<BootRow>,
): void {
  executeSqliteQuerySync(
    params.db,
    params.kysely.insertInto("gateway_boot_lifecycle").values(
      rows.map((row) => ({
        boot_id: row.bootId,
        pid: 1,
        started_at_ms: row.startedAtMs,
        completed_at_ms: row.completedAtMs ?? null,
        outcome: row.outcome ?? null,
        startup_reason: row.startupReason ?? null,
        reason: row.reason ?? null,
      })),
    ),
  );
}

function readBootRows(lifecycle: ReturnType<typeof createLifecycleDb>) {
  return executeSqliteQuerySync(
    lifecycle.db,
    lifecycle.kysely.selectFrom("gateway_boot_lifecycle").selectAll().orderBy("started_at_ms"),
  ).rows;
}

const completedBoot = (
  id: string,
  start: number,
  end: number,
  outcome: GatewayBootLifecycleOutcome,
  details: Pick<BootRow, "reason" | "startupReason"> = {},
) => bootRow(id, start, { completedAtMs: end, outcome, ...details });

it("retains exact pending crash intervals per physical agent until its recovery completes", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    for (const agentId of ["main", "constructor"]) {
      openOpenClawAgentDatabase({ agentId });
    }
    await beginGatewayBootLifecycle(process.env, 100);
    const crash = await beginGatewayBootLifecycle(process.env, 200);
    expect(crash.restartResumeWindows).toEqual({
      main: [{ startedAt: 100, endedAt: 200 }],
      constructor: [{ startedAt: 100, endedAt: 200 }],
    });
    expect(crash.previousCrash).toMatchObject({ startedAtMs: 100, detectedAtMs: 200 });
    const consecutive = await beginGatewayBootLifecycle(process.env, 300);
    expect(consecutive.restartResumeWindows?.main).toEqual([{ startedAt: 100, endedAt: 300 }]);
    // A late acknowledgement cannot discard the newer crash interval.
    await completeGatewayAgentRestartRecovery("main", 200);
    await completeGatewayBootLifecycle(consecutive.id, { outcome: "clean_stop" }, process.env, 350);
    expect((await beginGatewayBootLifecycle(process.env, 400)).previousCrash).toBeUndefined();
    const separated = await beginGatewayBootLifecycle(process.env, 500);
    expect(separated.restartResumeWindows?.main).toEqual([
      { startedAt: 100, endedAt: 300 },
      { startedAt: 400, endedAt: 500 },
    ]);
    expect(separated.previousCrash).toMatchObject({ startedAtMs: 400, detectedAtMs: 500 });
    await completeGatewayAgentRestartRecovery("main", 500);
    await completeGatewayBootLifecycle(separated.id, { outcome: "clean_stop" }, process.env, 550);
    const afterRetention = await beginGatewayBootLifecycle(process.env, 100_000_000);
    expect(afterRetention.restartResumeWindows).toEqual({
      constructor: [
        { startedAt: 100, endedAt: 300 },
        { startedAt: 400, endedAt: 500 },
      ],
    });
    expect(afterRetention.previousCrash).toBeUndefined();
    expect(
      (await readConfigMachineStateAsync<GatewayCrashState>("gateway.crashes"))?.recent,
    ).toHaveLength(3);
    await completeGatewayAgentRestartRecovery("constructor", 500);
    await completeGatewayBootLifecycle(
      afterRetention.id,
      { outcome: "clean_stop" },
      process.env,
      100_000_001,
    );
    expect(
      (await beginGatewayBootLifecycle(process.env, 100_000_002)).restartResumeWindows,
    ).toBeUndefined();
  }));

describe("gateway crash-loop breaker", () => {
  it("records an unclean run once, retaining its identity after receipt pruning and clean handoffs", async () => {
    const lifecycle = createLifecycleDb();
    const first = await lifecycle.begin(1_000);
    const restartAt = GATEWAY_BOOT_LIFECYCLE_RETENTION_MS + 2_000;
    const next = await beginGatewayBootLifecycle(lifecycle.env, restartAt, {
      pid: process.pid,
      heartbeatAt: 60_000,
    });
    const warn = vi.fn();
    if (next.previousCrash) {
      await reportPreviousGatewayCrash(next.previousCrash, { warn }, lifecycle.env);
    }
    const readCrashes = async () =>
      (
        await readConfigMachineStateAsync<GatewayCrashState>("gateway.crashes", {
          env: lifecycle.env,
        })
      )?.recent ?? [];
    expect(await readCrashes()).toEqual([
      expect.objectContaining({
        bootId: first.id,
        pid: process.pid,
        startedAtMs: 1_000,
        detectedAtMs: restartAt,
        lastHeartbeatAtMs: 60_000,
        version: expect.any(String),
        runtime: expect.any(String),
      }),
    ]);
    expect(readBootRows(lifecycle).map((row) => row.boot_id)).not.toContain(first.id);
    await lifecycle.complete(next.id, "clean_stop", restartAt + 1);
    const handoff = await lifecycle.begin(restartAt + 2);
    expect(handoff.previousCrash).toBeUndefined();
    await lifecycle.complete(handoff.id, "planned_restart", restartAt + 3);
    expect((await lifecycle.begin(restartAt + 4)).previousCrash).toBeUndefined();
    expect(await readCrashes()).toHaveLength(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("previous Gateway run ended unexpectedly: cause unknown"),
    );
  });

  it.each(["clean_stop", "planned_restart"] as const)(
    "does not record a crash for %s",
    async (outcome) => {
      const lifecycle = createLifecycleDb();
      const boot = await lifecycle.begin(1_000);
      await lifecycle.complete(boot.id, outcome, 2_000);
      expect((await lifecycle.begin(3_000)).previousCrash).toBeUndefined();
      const state = await readConfigMachineStateAsync<GatewayCrashState>("gateway.crashes", {
        env: lifecycle.env,
      });
      expect(state?.recent ?? []).toEqual([]);
    },
  );

  it("bounds crash history and enriches only the named completed failure", async () => {
    const lifecycle = createLifecycleDb();
    let boot = await lifecycle.begin(1_000);
    const oldest = boot.id;
    for (let index = 1; index <= 11; index++) {
      await lifecycle.complete(boot.id, "startup_failed", 1_000 + index * 2 - 1, {
        reason: "startup failed",
      });
      boot = await lifecycle.begin(1_000 + index * 2);
    }
    const crashes = await readGatewayRecentCrashesAsync(lifecycle.env);
    expect(crashes).toHaveLength(10);
    expect(crashes.some((crash) => crash.bootId === oldest)).toBe(false);
    expect(crashes[0]).toMatchObject({ reason: "startup failed", detectedAtMs: 1_022 });
    const current = crashes[0]!;
    vi.spyOn(crashCause, "readGatewayCrashCause").mockResolvedValue({
      signal: "SIGSEGV",
      uptimeMs: 1,
    });
    const warn = vi.fn();
    await reportPreviousGatewayCrash(current, { warn }, lifecycle.env);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("signal SIGSEGV"));
    const updated = await readGatewayRecentCrashesAsync(lifecycle.env);
    expect(updated[0]).toMatchObject({ bootId: current.bootId, signal: "SIGSEGV", uptimeMs: 1 });
    expect(updated.slice(1)).toEqual(crashes.slice(1));
    await reportPreviousGatewayCrash({ ...current, bootId: "missing" }, { warn }, lifecycle.env);
    expect(await readGatewayRecentCrashesAsync(lifecycle.env)).toEqual(updated);
  });

  it.each([2, 3])(
    "starts from %i prior crashes and observes completion without main-thread SQL",
    async (priorCrashes) => {
      const lifecycle = createLifecycleDb();
      insertBootRows(
        lifecycle,
        Array.from({ length: priorCrashes }, (_, index) =>
          bootRow(`prior-${index}`, 1_000 + index),
        ),
      );
      const sql = observeHostDataSql();
      try {
        const first = await lifecycle.begin(4_000);
        const firstId = first.id;
        expect(firstId).toBeDefined();
        expect(first.restartResumeWindow).toEqual({
          startedAt: 1_000 + priorCrashes - 1,
          endedAt: 4_000,
        });
        expectDecision(first.decision, priorCrashes, {
          shouldWriteStabilityBundle: priorCrashes === 3,
        });
        await lifecycle.complete(firstId, "clean_stop", 5_000);
        const next = await lifecycle.begin(6_000);
        const nextId = next.id;
        expect(nextId).toBeDefined();
        expect(nextId).not.toBe(firstId);
        expect(next.restartResumeWindow).toBeUndefined();
        expectDecision(next.decision, priorCrashes, {
          shouldWriteStabilityBundle: false,
        });
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(
        readBootRows(lifecycle)
          .filter((row) => row.started_at_ms >= 4_000)
          .map((row) => row.startup_reason),
      ).toEqual([priorCrashes === 3 ? BREAKER : null, null]);
    },
  );

  it("offers recovery after a forced stop, but not a successfully settled predecessor", async () => {
    const lifecycle = createLifecycleDb();
    let now = 1_000;
    let boot = await lifecycle.begin(now);
    expect(boot.restartResumeWindow).toBeUndefined();
    for (const outcome of [
      "planned_restart",
      "clean_stop",
      "safe_mode_stable",
      "startup_failure_repaired",
      "startup_failed",
      "forced_stop",
    ] as const) {
      await lifecycle.complete(boot.id, outcome, now + 1);
      const next = await lifecycle.begin(now + 2);
      expect(next.restartResumeWindow).toEqual(
        outcome === "forced_stop" ? { startedAt: now, endedAt: now + 2 } : undefined,
      );
      now += 2;
      boot = next;
    }
  });

  it("keeps a safe-mode split in its original incarnation without grouping real restarts by PID", async () => {
    const lifecycle = createLifecycleDb();
    insertBootRows(lifecycle, [bootRow("a", 1), bootRow("b", 2), bootRow("c", 3)]);
    const safe = await lifecycle.begin(4_000);
    const recoveredAt = 4_000 + GATEWAY_BOOT_LOOP_WINDOW_MS + 1;
    const recovered = await recordGatewayCrashLoopRecovery(safe.id, lifecycle.env, recoveredAt);
    expect(recovered).toBeDefined();
    const restarted = await lifecycle.begin(recoveredAt + 1);
    expect(restarted.restartResumeWindow).toEqual({ startedAt: 4_000, endedAt: recoveredAt + 1 });
    // This new incarnation shares process.pid, but is not another safe-mode split.
    expect((await lifecycle.begin(recoveredAt + 2)).restartResumeWindow).toEqual({
      startedAt: recoveredAt + 1,
      endedAt: recoveredAt + 2,
    });
  });

  it.skipIf(typeof DatabaseSync.prototype.setAuthorizer !== "function")(
    "retains the crash-loop decision and rolls back pruning when recording the boot fails",
    () => {
      const lifecycle = createLifecycleDb();
      const nowMs = 2 * GATEWAY_BOOT_LIFECYCLE_RETENTION_MS;
      insertBootRows(lifecycle, [
        bootRow("expired", 1),
        bootRow("prior-a", nowMs - 3),
        bootRow("prior-b", nowMs - 2),
        bootRow("prior-c", nowMs - 1),
      ]);
      const state = openOpenClawStateDatabase({ env: lifecycle.env });
      const database = requireNativeSqliteDatabase(state.db);
      database.setAuthorizer((action, table) =>
        action === constants.SQLITE_INSERT && table === "gateway_boot_lifecycle"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      try {
        const failed = gatewayBootOperations["gatewayBoot.begin"](
          { nowMs, metadata: {} },
          {
            open: () => state,
            stateOptions: () => ({ path: state.path, env: lifecycle.env }),
          },
        );
        expect(failed).toMatchObject({
          id: undefined,
          decision: { tripped: true, uncleanBoots: 3, shouldWriteStabilityBundle: true },
        });
        expect(failed).not.toHaveProperty("restartResumeWindow");
      } finally {
        database.setAuthorizer(null);
      }
      expect(
        readBootRows(lifecycle)
          .map(({ boot_id }) => boot_id)
          .toSorted(),
      ).toEqual(["expired", "prior-a", "prior-b", "prior-c"]);
    },
  );

  it.each(["completed", "interrupted"] as const)(
    "preserves %s shutdown accounting after database retirement",
    async (shutdown) => {
      const lifecycle = createLifecycleDb();
      insertBootRows(lifecycle, [bootRow("prior-crash-a", 1_000), bootRow("prior-crash-b", 2_000)]);
      const bootId = (await lifecycle.begin(3_000)).id;
      const prepare = vi.spyOn(lifecycle.db, "prepare");
      const exec = vi.spyOn(lifecycle.db, "exec");
      try {
        if (shutdown === "completed") {
          await lifecycle.complete(bootId, "clean_stop", 4_000, { reason: "stop (SIGTERM)" });
        }
        expect(prepare).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
        await closeOpenClawStateDatabaseAsync();
      } finally {
        prepare.mockRestore();
        exec.mockRestore();
      }

      expect(await readGatewayLastShutdownAsync(lifecycle.env)).toEqual(
        shutdown === "completed" ? { reason: "stop (SIGTERM)", completedAtMs: 4_000 } : undefined,
      );
      expectDecision(await lifecycle.inspect(4_001), shutdown === "interrupted" ? 3 : 2);
    },
  );

  it("projects the latest real shutdown and replacement without treating recovery or live boots as stops", async () => {
    const lifecycle = createLifecycleDb();
    expect(await readGatewayLastShutdownAsync(lifecycle.env)).toBeUndefined();
    expect(await readGatewayLastInstallationReplacementAsync(lifecycle.env)).toBeUndefined();
    const reason = "gateway.installation_replaced: on-disk 2026.9.5 differs from running 2026.9.4";
    const replacedBoot = (await lifecycle.begin(1_000)).id;
    await lifecycle.complete(replacedBoot, "planned_restart", 2_000, { reason });
    const successor = (await lifecycle.begin(3_000)).id;
    insertBootRows(lifecycle, [
      completedBoot("older-stop", 1_500, 1_900, "planned_restart", { reason: "restart (SIGUSR2)" }),
      completedBoot("recovery", 3_001, 4_000, "safe_mode_stable"),
      bootRow("running", 4_001),
    ]);
    expect(await readGatewayLastShutdownAsync(lifecycle.env)).toEqual({
      reason,
      completedAtMs: 2_000,
    });
    expect(await readGatewayLastInstallationReplacementAsync(lifecycle.env)).toEqual({
      reason,
      completedAtMs: 2_000,
    });
    await lifecycle.complete(successor, "clean_stop", 5_000, { reason: "stop (SIGTERM)" });
    expect(await readGatewayLastInstallationReplacementAsync(lifecycle.env)).toBeUndefined();
    expectDecision(await lifecycle.inspect(5_001), 1);
  });

  it.each(["SIGTERM", "SIGINT"])(
    "warns about repeated %s stops across process lifetimes",
    async (signal) => {
      const lifecycle = createLifecycleDb();
      const warn = vi.fn();
      setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
      loggingState.rawConsole = { log: warn, info: warn, warn, error: warn };
      const reason = `stop (${signal})`;
      const nowMs = 1_000_000;
      insertBootRows(lifecycle, [
        completedBoot("expired", 1, nowMs - 300_001, "clean_stop", { reason }),
        completedBoot("previous", 2, nowMs - 100_000, "clean_stop", { reason }),
      ]);
      const secondBoot = (await lifecycle.begin(nowMs - 1_000)).id;
      await lifecycle.complete(secondBoot, "clean_stop", nowMs, { reason });
      expect(warn).not.toHaveBeenCalled();
      const thirdBoot = (await lifecycle.begin(nowMs + 1_000)).id;
      await lifecycle.complete(thirdBoot, "clean_stop", nowMs + 2_000, { reason });
      expect(warn.mock.calls.flat().join("\n")).toContain(
        `stopped after ${signal} 3 times in 5 min: another supervisor may be managing this Gateway`,
      );
      expect((await lifecycle.inspect(nowMs + 2_000)).tripped).toBe(false);
    },
  );

  it("keeps a completed Tailscale authentication prerequisite visible without counting it as a crash", async () => {
    const lifecycle = createLifecycleDb();
    const nowMs = 1_000_000;
    const prerequisiteBootId = await lifecycle.begin(nowMs - 3);
    await lifecycle.complete(prerequisiteBootId.id, "startup_failed", nowMs - 2, {
      startupReason: TAILSCALE_BACKEND_AUTH_REQUIRED_REASON,
      reason: "gateway.tailscale_authentication_required: NeedsLogin",
    });
    for (const [startedAtMs, completedAtMs, reason] of [
      [nowMs - 1, nowMs, "EADDRINUSE"],
      [nowMs, nowMs + 1, "gateway startup cleanup failed"],
    ] as const) {
      const bootId = await lifecycle.begin(startedAtMs);
      await lifecycle.complete(bootId.id, "startup_failed", completedAtMs, { reason });
    }
    expectDecision(await lifecycle.inspect(nowMs + 2), 2);
    expect(readBootRows(lifecycle)).toContainEqual(
      expect.objectContaining({
        boot_id: prerequisiteBootId.id,
        completed_at_ms: nowMs - 2,
        outcome: "startup_failed",
        startup_reason: TAILSCALE_BACKEND_AUTH_REQUIRED_REASON,
        reason: "gateway.tailscale_authentication_required: NeedsLogin",
      }),
    );
    const bootId = await lifecycle.begin(nowMs + 2);
    await lifecycle.complete(bootId.id, "startup_failed", nowMs + 3, {
      reason: "unknown startup error",
    });
    expectDecision(await lifecycle.inspect(nowMs + 4), 3);
  });

  it("keeps an unfinished boot in breaker accounting even when its startup reason is known", async () => {
    const lifecycle = createLifecycleDb();
    const nowMs = 1_000_000;
    insertBootRows(lifecycle, [
      bootRow("unfinished-auth-prerequisite", nowMs - 3, {
        startupReason: TAILSCALE_BACKEND_AUTH_REQUIRED_REASON,
      }),
    ]);
    for (const [startedAtMs, completedAtMs, reason] of [
      [nowMs - 2, nowMs - 1, "EADDRINUSE"],
      [nowMs - 1, nowMs, "gateway startup cleanup failed"],
    ] as const) {
      const bootId = await lifecycle.begin(startedAtMs);
      await lifecycle.complete(bootId.id, "startup_failed", completedAtMs, { reason });
    }
    expectDecision(await lifecycle.inspect(nowMs + 1), 3);
  });

  it.each([
    ["Kubernetes", { KUBERNETES_SERVICE_HOST: "10.96.0.1", KUBERNETES_SERVICE_PORT: "443" }],
    ["external supervisor", { OPENCLAW_SUPERVISOR_MODE: "external" }],
  ] as const)(
    "records repeated SIGTERM stops without a competing-supervisor warning under %s",
    async (owner, platformEnv) => {
      const lifecycle = createLifecycleDb();
      Object.assign(lifecycle.env, platformEnv);
      const lines: string[] = [];
      const capture = (...args: unknown[]) => lines.push(args.map(String).join(" "));
      setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });
      loggingState.rawConsole = { log: capture, info: capture, warn: capture, error: capture };
      const reason = "stop (SIGTERM)";
      const nowMs = 1_000_000;
      insertBootRows(lifecycle, [
        completedBoot("first-pod", 1, nowMs - 200_000, "clean_stop", { reason }),
        completedBoot("second-pod", 2, nowMs - 100_000, "clean_stop", { reason }),
      ]);
      const bootId = (await lifecycle.begin(nowMs - 1_000)).id;
      await lifecycle.complete(bootId, "clean_stop", nowMs, { reason });
      const output = lines.join("\n");
      expect(output).toContain(
        `stopped after SIGTERM 3 times in 5 min (${owner} manages this Gateway)`,
      );
      expect(output).not.toContain("another supervisor");
      expect(output).not.toContain('"level":"warn"');
    },
  );

  it.each([
    [
      "startup_failed",
      "gateway.maintenance_required",
      "Legacy workspace setup state requires migration",
    ],
    ["forced_stop", undefined, "gateway.stop_shutdown_timeout"],
  ] as const)("excludes %s (%s) from crash accounting", async (outcome, startupReason, reason) => {
    const lifecycle = createLifecycleDb();
    const nowMs = 1_000_000;
    for (let index = 0; index < 3; index++) {
      const bootId = (await lifecycle.begin(nowMs + index)).id;
      await lifecycle.complete(bootId, outcome, nowMs + index + 1, { startupReason, reason });
    }
    expectDecision(await lifecycle.inspect(nowMs + 4), 0);
  });

  it("recovers after completed stopped-daemon failures but retains genuine crash protection", async () => {
    const lifecycle = createLifecycleDb();
    const nowMs = 1_000_000;
    expectDecision(await lifecycle.inspect(nowMs), 0, { recovered: false });
    const safeModeBootId = "safe-mode-boot";
    insertBootRows(lifecycle, [
      bootRow(safeModeBootId, nowMs - GATEWAY_BOOT_LOOP_WINDOW_MS - 1, {
        startupReason: BREAKER,
      }),
    ]);
    for (let index = 0; index < 3; index++) {
      const bootId = `stopped-daemon-${index}`;
      insertBootRows(lifecycle, [bootRow(bootId, nowMs + index)]);
      await lifecycle.complete(bootId, "startup_failed", nowMs + index + 1, {
        startupReason: "gateway.tailscale_backend_stopped",
        reason: "Tailscale is stopped",
      });
    }
    const recovered = await lifecycle.inspect(nowMs + 4);
    expectDecision(recovered, 0, {
      recovered: true,
      recoveryPausedUntilMs: undefined,
    });
    const recoveredBootId = await recordGatewayCrashLoopRecovery(
      safeModeBootId,
      lifecycle.env,
      nowMs + 5,
    );
    expect(recoveredBootId).toBeDefined();
    expect(
      readBootRows(lifecycle)
        .filter(({ startup_reason }) => startup_reason === BREAKER || startup_reason === RECOVERED)
        .map(({ boot_id, completed_at_ms, outcome, startup_reason }) => [
          boot_id,
          completed_at_ms,
          outcome,
          startup_reason,
        ]),
    ).toEqual([
      [safeModeBootId, nowMs + 5, "safe_mode_stable", BREAKER],
      [recoveredBootId, null, null, RECOVERED],
    ]);
    expectDecision(await lifecycle.inspect(nowMs + 5), 1, { recovered: false });
    await lifecycle.complete(recoveredBootId, "clean_stop", nowMs + 6);
    expectDecision(await lifecycle.inspect(nowMs + 7), 0, { recovered: false });
    insertBootRows(lifecycle, [
      bootRow("unclean-dependency", nowMs - 10, {
        startupReason: "gateway.tailscale_backend_stopped",
      }),
      bootRow("unclean-channel", nowMs - 9),
      completedBoot(
        "unknown-failure",
        nowMs - GATEWAY_BOOT_LOOP_WINDOW_MS - 60_000,
        nowMs - 7,
        "startup_failed",
      ),
      completedBoot("new-breaker-marker", nowMs + 7, nowMs + 8, "safe_mode_stable", {
        startupReason: BREAKER,
      }),
    ]);
    const tripped = await lifecycle.inspect(nowMs + 9);
    expectDecision(tripped, 3, {
      recoveryPausedUntilMs: nowMs - 7 + GATEWAY_BOOT_LOOP_WINDOW_MS + 1,
    });
  });

  it("repairs maintenance history without clearing real startup crashes", async () => {
    const lifecycle = createLifecycleDb();
    const nowMs = 1_000_000;
    insertBootRows(lifecycle, [
      ...["gateway.maintenance_required", "gateway.agent_media_migration_required"].map(
        (startupReason, index) =>
          completedBoot(`maintenance-${index}`, nowMs - 2, nowMs - 1, "startup_failed", {
            startupReason,
          }),
      ),
      completedBoot("unrelated", nowMs - 1, nowMs, "startup_failed", { reason: "EADDRINUSE" }),
    ]);
    expect(repairGatewayMaintenanceStartupFailures(lifecycle.env)).toBe(2);
    expect(repairGatewayMaintenanceStartupFailures(lifecycle.env)).toBe(0);
    expectDecision(await lifecycle.inspect(nowMs + 1), 1);
    const rows = readBootRows(lifecycle)
      .map(({ boot_id, outcome }) => ({ boot_id, outcome }))
      .toSorted((a, b) => a.boot_id.localeCompare(b.boot_id));
    expect(rows).toEqual([
      { boot_id: "maintenance-0", outcome: "startup_failure_repaired" },
      { boot_id: "maintenance-1", outcome: "startup_failure_repaired" },
      { boot_id: "unrelated", outcome: "startup_failed" },
    ]);
  });

  it.each([false, true])(
    "captures the latest boot before pruning (recent boot: %s)",
    async (recent) => {
      const db = createLifecycleDb();
      const nowMs = 2 * GATEWAY_BOOT_LIFECYCLE_RETENTION_MS;

      insertBootRows(db, [
        bootRow("old", nowMs - GATEWAY_BOOT_LIFECYCLE_RETENTION_MS - 1),
        ...(recent ? [bootRow("kept", nowMs - GATEWAY_BOOT_LIFECYCLE_RETENTION_MS)] : []),
      ]);

      expect((await db.begin(nowMs)).restartResumeWindow).toEqual({
        startedAt: nowMs - GATEWAY_BOOT_LIFECYCLE_RETENTION_MS - (recent ? 0 : 1),
        endedAt: nowMs,
      });

      const rows = readBootRows(db).map((row) => row.boot_id);

      expect(rows).toHaveLength(recent ? 2 : 1);
      expect(rows.includes("kept")).toBe(recent);
      expect(rows).not.toContain("old");
    },
  );
});

describe("formatGatewayCrashLoopManualChannelStartHint", () => {
  it("uses a placeholder when no channel is known", () => {
    expect(formatGatewayCrashLoopManualChannelStartHint()).toContain(
      `--params '{"channel":"<id>"}'`,
    );
  });

  it("names the channel being suppressed", () => {
    expect(formatGatewayCrashLoopManualChannelStartHint({ channelId: "telegram" })).toContain(
      `--params '{"channel":"telegram"}'`,
    );
  });

  it.each([
    { name: "named profile", profile: "work", container: "", command: "openclaw --profile work" },
    {
      name: "container and profile",
      profile: "work",
      container: "demo",
      command: "openclaw --container demo",
    },
  ])("targets the active gateway for $name", ({ profile, container, command }) => {
    vi.stubEnv("OPENCLAW_PROFILE", profile);
    vi.stubEnv("OPENCLAW_CONTAINER_HINT", container);

    expect(
      formatGatewayCrashLoopManualChannelStartHint({ channelId: "telegram", accountId: "work" }),
    ).toBe(
      `Start a channel manually with: ${command} gateway call channels.start --params '{"channel":"telegram","accountId":"work"}'`,
    );
  });
});
