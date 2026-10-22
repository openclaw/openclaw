// Gateway boot lifecycle tests cover restart-loop breaker accounting.
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
  GATEWAY_CRASH_LOOP_BREAKER_REASON,
  completeGatewayBootLifecycle,
  formatGatewayCrashLoopManualChannelStartHint,
  inspectGatewayCrashLoopBreakerAsync,
  readGatewayLastInstallationReplacementAsync,
  readGatewayLastShutdownAsync,
  beginGatewayBootLifecycle,
  recordGatewayCrashLoopRecovery,
  repairGatewayMaintenanceStartupFailures,
} from "./gateway-boot-lifecycle.js";
import { GATEWAY_CRASH_LOOP_RECOVERED_REASON } from "./gateway-boot-lifecycle.kernel.js";
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

const GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD = 3;
const GATEWAY_BOOT_LOOP_WINDOW_MS = 5 * 60_000;
const GATEWAY_BOOT_LIFECYCLE_RETENTION_MS = 24 * 60 * 60_000;

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
      let firstId: string | undefined;
      let nextId: string | undefined;
      try {
        const first = await lifecycle.begin(4_000);
        firstId = first.id;
        expect(firstId).toBeDefined();
        expect(first.decision).toMatchObject({
          tripped: priorCrashes === 3,
          uncleanBoots: priorCrashes,
          shouldWriteStabilityBundle: priorCrashes === 3,
        });
        await lifecycle.complete(firstId, "clean_stop", 5_000);
        const next = await lifecycle.begin(6_000);
        nextId = next.id;
        expect(nextId).toBeDefined();
        expect(nextId).not.toBe(firstId);
        expect(next.decision).toMatchObject({
          tripped: priorCrashes === 3,
          uncleanBoots: priorCrashes,
          shouldWriteStabilityBundle: false,
        });
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      expect(
        executeSqliteQuerySync(
          lifecycle.db,
          lifecycle.kysely
            .selectFrom("gateway_boot_lifecycle")
            .select(["boot_id", "started_at_ms", "completed_at_ms", "outcome", "startup_reason"])
            .where("started_at_ms", ">=", 4_000)
            .orderBy("started_at_ms"),
        ).rows.map(({ boot_id, started_at_ms, completed_at_ms, outcome, startup_reason }) => [
          boot_id,
          started_at_ms,
          completed_at_ms,
          outcome,
          startup_reason,
        ]),
      ).toEqual([
        [
          firstId,
          4_000,
          5_000,
          "clean_stop",
          priorCrashes === 3 ? GATEWAY_CRASH_LOOP_BREAKER_REASON : null,
        ],
        [nextId, 6_000, null, null, null],
      ]);
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
        executeSqliteQuerySync(
          lifecycle.db,
          lifecycle.kysely
            .selectFrom("gateway_boot_lifecycle")
            .select("boot_id")
            .orderBy("boot_id"),
        ).rows.map(({ boot_id }) => boot_id),
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
      expect(await lifecycle.inspect(4_001)).toMatchObject({
        tripped: shutdown === "interrupted",
        uncleanBoots: shutdown === "interrupted" ? 3 : 2,
      });
    },
  );

  it("projects replacement history only while it is the latest shutdown", async () => {
    const lifecycle = createLifecycleDb();
    expect(await readGatewayLastInstallationReplacementAsync(lifecycle.env)).toBeUndefined();
    const reason = "gateway.installation_replaced: on-disk 2026.9.5 differs from running 2026.9.4";
    const replacedBoot = (await lifecycle.begin(1_000)).id;
    await lifecycle.complete(replacedBoot, "planned_restart", 2_000, { reason });
    const successor = (await lifecycle.begin(3_000)).id;
    expect(await readGatewayLastInstallationReplacementAsync(lifecycle.env)).toEqual({
      reason,
      completedAtMs: 2_000,
    });
    await lifecycle.complete(successor, "clean_stop", 4_000, { reason: "stop (SIGTERM)" });
    expect(await readGatewayLastInstallationReplacementAsync(lifecycle.env)).toBeUndefined();
    expect(await lifecycle.inspect(4_001)).toMatchObject({ tripped: false, uncleanBoots: 0 });
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
        bootRow("expired", 1, { completedAtMs: nowMs - 300_001, outcome: "clean_stop", reason }),
        bootRow("previous", 2, { completedAtMs: nowMs - 100_000, outcome: "clean_stop", reason }),
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

  it("reads the last shutdown without mistaking recovery segments or live boots for stops", async () => {
    const lifecycle = createLifecycleDb();
    expect(await readGatewayLastShutdownAsync(lifecycle.env)).toBeUndefined();
    const bootId = (await lifecycle.begin(1_000)).id;
    await lifecycle.complete(bootId, "clean_stop", 3_000, { reason: "stop (SIGTERM)" });
    insertBootRows(lifecycle, [
      bootRow("older-stop", 1_500, {
        completedAtMs: 2_000,
        outcome: "planned_restart",
        reason: "restart (SIGUSR2)",
      }),
      bootRow("recovery", 3_001, { completedAtMs: 4_000, outcome: "safe_mode_stable" }),
      bootRow("running", 4_001),
    ]);

    expect(await readGatewayLastShutdownAsync(lifecycle.env)).toEqual({
      reason: "stop (SIGTERM)",
      completedAtMs: 3_000,
    });
  });

  it("trips from the persisted unclean boot count", async () => {
    const db = createLifecycleDb();
    const nowMs = 1_000_000;
    const windowStartMs = nowMs - GATEWAY_BOOT_LOOP_WINDOW_MS;

    insertBootRows(db, [
      bootRow("a", windowStartMs + 1),
      bootRow("b", windowStartMs + 2),
      bootRow("c", windowStartMs - 60_000, {
        completedAtMs: windowStartMs + 3,
        outcome: "startup_failed",
      }),
    ]);

    const decision = await db.inspect(nowMs);

    expect(decision).toMatchObject({
      tripped: true,
      uncleanBoots: GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD,
      shouldWriteStabilityBundle: true,
    });
  });

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
    for (let index = 0; index < GATEWAY_BOOT_LOOP_UNCLEAN_THRESHOLD; index++) {
      const bootId = (await lifecycle.begin(nowMs + index)).id;
      await lifecycle.complete(bootId, outcome, nowMs + index + 1, { startupReason, reason });
    }
    expect(await lifecycle.inspect(nowMs + 4)).toMatchObject({
      tripped: false,
      uncleanBoots: 0,
    });
  });

  it("recovers after completed stopped-daemon failures but retains genuine crash protection", async () => {
    const lifecycle = createLifecycleDb();
    const nowMs = 1_000_000;
    expect(await lifecycle.inspect(nowMs)).toMatchObject({
      tripped: false,
      uncleanBoots: 0,
      recovered: false,
    });
    const safeModeBootId = "safe-mode-boot";
    insertBootRows(lifecycle, [
      bootRow(safeModeBootId, nowMs - GATEWAY_BOOT_LOOP_WINDOW_MS - 1, {
        startupReason: GATEWAY_CRASH_LOOP_BREAKER_REASON,
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
    expect(recovered).toMatchObject({
      tripped: false,
      uncleanBoots: 0,
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
      executeSqliteQuerySync(
        lifecycle.db,
        lifecycle.kysely
          .selectFrom("gateway_boot_lifecycle")
          .select(["boot_id", "completed_at_ms", "outcome", "startup_reason"])
          .where("startup_reason", "in", [
            GATEWAY_CRASH_LOOP_BREAKER_REASON,
            GATEWAY_CRASH_LOOP_RECOVERED_REASON,
          ])
          .orderBy("started_at_ms"),
      ).rows.map(({ boot_id, completed_at_ms, outcome, startup_reason }) => [
        boot_id,
        completed_at_ms,
        outcome,
        startup_reason,
      ]),
    ).toEqual([
      [safeModeBootId, nowMs + 5, "safe_mode_stable", GATEWAY_CRASH_LOOP_BREAKER_REASON],
      [recoveredBootId, null, null, GATEWAY_CRASH_LOOP_RECOVERED_REASON],
    ]);
    expect(await lifecycle.inspect(nowMs + 5)).toMatchObject({
      recovered: false,
      uncleanBoots: 1,
    });
    await lifecycle.complete(recoveredBootId, "clean_stop", nowMs + 6);
    expect(await lifecycle.inspect(nowMs + 7)).toMatchObject({
      tripped: false,
      uncleanBoots: 0,
      recovered: false,
    });
    insertBootRows(lifecycle, [
      bootRow("unclean-dependency", nowMs - 10, {
        startupReason: "gateway.tailscale_backend_stopped",
      }),
      bootRow("unclean-channel", nowMs - 9),
      bootRow("unknown-failure", nowMs - 8, {
        completedAtMs: nowMs - 7,
        outcome: "startup_failed",
      }),
      bootRow("new-breaker-marker", nowMs + 7, {
        completedAtMs: nowMs + 8,
        outcome: "safe_mode_stable",
        startupReason: GATEWAY_CRASH_LOOP_BREAKER_REASON,
      }),
    ]);
    const tripped = await lifecycle.inspect(nowMs + 9);
    expect(tripped).toMatchObject({
      tripped: true,
      uncleanBoots: 3,
      recoveryPausedUntilMs: nowMs - 7 + GATEWAY_BOOT_LOOP_WINDOW_MS + 1,
    });
  });

  it("repairs maintenance history without clearing real startup crashes", async () => {
    const lifecycle = createLifecycleDb();
    const nowMs = 1_000_000;
    insertBootRows(lifecycle, [
      ...["gateway.maintenance_required", "gateway.agent_media_migration_required"].map(
        (startupReason, index) =>
          bootRow(`maintenance-${index}`, nowMs - 2, {
            completedAtMs: nowMs - 1,
            outcome: "startup_failed" as const,
            startupReason,
          }),
      ),
      bootRow("unrelated", nowMs - 1, {
        completedAtMs: nowMs,
        outcome: "startup_failed",
        reason: "EADDRINUSE",
      }),
    ]);
    expect(repairGatewayMaintenanceStartupFailures(lifecycle.env)).toBe(2);
    expect(repairGatewayMaintenanceStartupFailures(lifecycle.env)).toBe(0);
    expect(await lifecycle.inspect(nowMs + 1)).toMatchObject({
      tripped: false,
      uncleanBoots: 1,
    });
    const rows = executeSqliteQuerySync(
      lifecycle.db,
      lifecycle.kysely
        .selectFrom("gateway_boot_lifecycle")
        .select(["boot_id", "outcome"])
        .orderBy("boot_id"),
    ).rows;
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

    const rows = executeSqliteQuerySync(
      db.db,
      db.kysely.selectFrom("gateway_boot_lifecycle").select("boot_id").orderBy("boot_id"),
    ).rows.map((row) => row.boot_id);

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
