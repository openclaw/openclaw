// Gateway-wide runtime killswitch: pauses agent runs (interactive and cron)
// without stopping the gateway process itself, so an operator can still
// reach it (e.g. over Signal) to confirm state and later revive it.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

const KILLSWITCH_KEY = "global";
const killswitchLog = createSubsystemLogger("killswitch");

type KillswitchDatabase = Pick<OpenClawStateKyselyDatabase, "runtime_killswitch">;

/** Where an engage/release call originated, for audit/status display. */
export type KillswitchSource = "cli" | "signal" | "gateway-rpc";

export type KillswitchStatus = {
  engaged: boolean;
  reason?: string;
  source?: KillswitchSource;
  engagedAtMs?: number;
  releasedAtMs?: number;
};

function normalizeKillswitchReason(reason: string | undefined): string | undefined {
  const normalized = reason?.trim();
  return normalized ? truncateUtf16Safe(normalized, 200) : undefined;
}

/** Reads current killswitch status. Fails open (not engaged) so a state DB read
 * error never itself blocks agent runs; enable/disable paths still fail loud. */
export function getKillswitchStatusSync(env: NodeJS.ProcessEnv = process.env): KillswitchStatus {
  try {
    const { db } = openOpenClawStateDatabase({ env });
    const stateDb = getNodeSqliteKysely<KillswitchDatabase>(db);
    const row = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("runtime_killswitch")
        .select(["engaged", "reason", "source", "engaged_at_ms", "released_at_ms"])
        .where("killswitch_key", "=", KILLSWITCH_KEY),
    );
    if (!row) {
      return { engaged: false };
    }
    return {
      engaged: row.engaged === 1,
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.source ? { source: row.source as KillswitchSource } : {}),
      ...(typeof row.engaged_at_ms === "number" ? { engagedAtMs: row.engaged_at_ms } : {}),
      ...(typeof row.released_at_ms === "number" ? { releasedAtMs: row.released_at_ms } : {}),
    };
  } catch (err) {
    killswitchLog.warn(`failed to read killswitch status: ${String(err)}`);
    return { engaged: false };
  }
}

/** Fast boolean check for hot enforcement paths (agent run entrypoint, cron dispatch). */
export function isKillswitchEngagedSync(env: NodeJS.ProcessEnv = process.env): boolean {
  return getKillswitchStatusSync(env).engaged;
}

export function engageKillswitchSync(opts: {
  reason?: string;
  source: KillswitchSource;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = opts.env ?? process.env;
  const now = Date.now();
  const reason = normalizeKillswitchReason(opts.reason);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<KillswitchDatabase>(db);
      executeSqliteQuerySync(
        db,
        stateDb
          .insertInto("runtime_killswitch")
          .values({
            killswitch_key: KILLSWITCH_KEY,
            engaged: 1,
            reason: reason ?? null,
            source: opts.source,
            engaged_at_ms: now,
            released_at_ms: null,
            updated_at_ms: now,
          })
          .onConflict((conflict) =>
            conflict.column("killswitch_key").doUpdateSet({
              engaged: 1,
              reason: reason ?? null,
              source: opts.source,
              engaged_at_ms: now,
              released_at_ms: null,
              updated_at_ms: now,
            }),
          ),
      );
    },
    { env },
  );
}

export function releaseKillswitchSync(opts: {
  source: KillswitchSource;
  env?: NodeJS.ProcessEnv;
}): void {
  const env = opts.env ?? process.env;
  const now = Date.now();
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<KillswitchDatabase>(db);
      executeSqliteQuerySync(
        db,
        stateDb
          .insertInto("runtime_killswitch")
          .values({
            killswitch_key: KILLSWITCH_KEY,
            engaged: 0,
            reason: null,
            source: opts.source,
            engaged_at_ms: null,
            released_at_ms: now,
            updated_at_ms: now,
          })
          .onConflict((conflict) =>
            conflict.column("killswitch_key").doUpdateSet({
              engaged: 0,
              reason: null,
              source: opts.source,
              released_at_ms: now,
              updated_at_ms: now,
            }),
          ),
      );
    },
    { env },
  );
}
