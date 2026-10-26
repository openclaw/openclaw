import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import {
  GATEWAY_CRASH_LOOP_BREAKER_REASON as BREAKER,
  completeGatewayBootLifecycle,
  formatGatewayCrashLoopManualChannelStartHint,
  inspectGatewayCrashLoopBreakerAsync,
  readGatewayLastInstallationReplacementAsync,
  readGatewayLastShutdownAsync,
  beginGatewayBootLifecycle,
  recordGatewayCrashLoopRecovery,
  repairGatewayMaintenanceStartupFailures,
} from "./gateway-boot-lifecycle.js";
import { GATEWAY_CRASH_LOOP_RECOVERED_REASON as RECOVERED } from "./gateway-boot-lifecycle.kernel.js";
import { gatewayBootOperations } from "./gateway-boot-lifecycle.worker.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

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

describe("gateway crash-loop breaker", () => {
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
        expectDecision(first.decision, priorCrashes, {
          shouldWriteStabilityBundle: priorCrashes === 3,
        });
        await lifecycle.complete(firstId, "clean_stop", 5_000);
        const next = await lifecycle.begin(6_000);
        const nextId = next.id;
        expect(nextId).toBeDefined();
        expect(nextId).not.toBe(firstId);
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
        expect(
          gatewayBootOperations["gatewayBoot.begin"](nowMs, {
            open: () => state,
            stateOptions: () => ({ path: state.path, env: lifecycle.env }),
          }),
        ).toMatchObject({
          id: undefined,
          decision: { tripped: true, uncleanBoots: 3, shouldWriteStabilityBundle: true },
        });
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

  it("prunes boot rows older than retention when recording a new boot", async () => {
    const db = createLifecycleDb();
    const nowMs = 2 * GATEWAY_BOOT_LIFECYCLE_RETENTION_MS;

    insertBootRows(db, [
      bootRow("old", nowMs - GATEWAY_BOOT_LIFECYCLE_RETENTION_MS - 1),
      bootRow("kept", nowMs - GATEWAY_BOOT_LIFECYCLE_RETENTION_MS),
    ]);

    await db.begin(nowMs);

    const rows = readBootRows(db).map((row) => row.boot_id);

    expect(rows).toHaveLength(2);
    expect(rows).toContain("kept");
    expect(rows).not.toContain("old");
  });
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
