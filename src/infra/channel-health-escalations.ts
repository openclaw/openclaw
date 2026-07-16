// Persists channel-health gateway-restart escalations so the hourly budget
// survives the process replacement the escalation itself causes.
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

const escalationLog = createSubsystemLogger("gateway/health-escalations");

type ChannelHealthEscalationsDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "channel_health_escalations"
>;

export type ChannelHealthEscalationBudget = {
  allowed: boolean;
  usedInWindow: number;
};

/**
 * Consumes one escalation from the rolling per-key window, resetting the
 * window when it has fully elapsed. Fails open: an unavailable state database
 * must not block the recovery restart it is budgeting.
 */
export function takeChannelHealthEscalationBudgetSync(opts: {
  escalationKey: string;
  windowMs: number;
  maxPerWindow: number;
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
}): ChannelHealthEscalationBudget {
  const env = opts.env ?? process.env;
  const nowMs = opts.nowMs ?? Date.now();
  try {
    let budget: ChannelHealthEscalationBudget = { allowed: true, usedInWindow: 1 };
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const kysely = getNodeSqliteKysely<ChannelHealthEscalationsDatabase>(db);
        const row = executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("channel_health_escalations")
            .select(["window_started_at_ms", "escalation_count"])
            .where("escalation_key", "=", opts.escalationKey),
        );
        const windowActive = row !== undefined && nowMs - row.window_started_at_ms < opts.windowMs;
        const usedBefore = windowActive ? row.escalation_count : 0;
        if (usedBefore >= opts.maxPerWindow) {
          budget = { allowed: false, usedInWindow: usedBefore };
          return;
        }
        const windowStartedAtMs = windowActive ? row.window_started_at_ms : nowMs;
        executeSqliteQuerySync(
          db,
          kysely
            .insertInto("channel_health_escalations")
            .values({
              escalation_key: opts.escalationKey,
              window_started_at_ms: windowStartedAtMs,
              escalation_count: usedBefore + 1,
              updated_at_ms: nowMs,
            })
            .onConflict((conflict) =>
              conflict.column("escalation_key").doUpdateSet({
                window_started_at_ms: windowStartedAtMs,
                escalation_count: usedBefore + 1,
                updated_at_ms: nowMs,
              }),
            ),
        );
        budget = { allowed: true, usedInWindow: usedBefore + 1 };
      },
      { env },
    );
    return budget;
  } catch (err) {
    escalationLog.warn(`escalation budget state unavailable; fail-open: ${String(err)}`);
    return { allowed: true, usedInWindow: 0 };
  }
}
