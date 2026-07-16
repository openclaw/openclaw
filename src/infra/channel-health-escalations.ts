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

// Rows older than the largest window any caller uses are dead weight; retention
// only needs to comfortably exceed the one-hour budget window.
const CHANNEL_HEALTH_ESCALATION_RETENTION_MS = 24 * 60 * 60_000;

type ChannelHealthEscalationsDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "channel_health_escalations"
>;

export type ChannelHealthEscalationBudget = {
  allowed: boolean;
  usedInWindow: number;
  /** True when the state database could not arbitrate; callers must not restart. */
  unavailable?: boolean;
};

/**
 * Consumes one escalation from the rolling per-key window (row per escalation,
 * counted over the trailing windowMs). Fails closed: a gateway process restart
 * interrupts every channel, so an unavailable state database means manual
 * recovery instead of an unbounded restart loop.
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
    let budget: ChannelHealthEscalationBudget = { allowed: false, usedInWindow: 0 };
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        const kysely = getNodeSqliteKysely<ChannelHealthEscalationsDatabase>(db);
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom("channel_health_escalations")
            .where("escalated_at_ms", "<", nowMs - CHANNEL_HEALTH_ESCALATION_RETENTION_MS),
        );
        const row = executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("channel_health_escalations")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("escalation_key", "=", opts.escalationKey)
            .where("escalated_at_ms", ">", nowMs - opts.windowMs),
        );
        const usedBefore = row?.count ?? 0;
        if (usedBefore >= opts.maxPerWindow) {
          budget = { allowed: false, usedInWindow: usedBefore };
          return;
        }
        executeSqliteQuerySync(
          db,
          kysely.insertInto("channel_health_escalations").values({
            escalation_key: opts.escalationKey,
            escalated_at_ms: nowMs,
          }),
        );
        budget = { allowed: true, usedInWindow: usedBefore + 1 };
      },
      { env },
    );
    return budget;
  } catch (err) {
    escalationLog.warn(
      `escalation budget state unavailable; failing closed to manual recovery: ${String(err)}`,
    );
    return { allowed: false, usedInWindow: 0, unavailable: true };
  }
}
