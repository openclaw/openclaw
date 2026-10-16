import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { isPostgresSqlConnection, type EngineConnection } from "../infra/sql-connection.js";
import { runWithSqliteBusyTimeout } from "../infra/sqlite-busy-timeout.js";
import { runSqliteSingleStatementSync } from "../infra/sqlite-transaction.js";
import type { DB } from "./openclaw-state-db.generated.js";
import type { OpenClawStateLeaseIdentity } from "./openclaw-state-lease.types.js";

export type StateLeaseRenewalOutcome = { expiresAt: number | undefined } | { error: unknown };
export type StateLeaseRenewal = {
  identity: OpenClawStateLeaseIdentity;
  leaseMs: number;
  intervalMs: number;
  execute<T>(operation: () => T): T;
  complete(outcome: StateLeaseRenewalOutcome): void;
};

function identityKey(identity: OpenClawStateLeaseIdentity): string {
  return JSON.stringify([identity.scope, identity.key, identity.owner]);
}

/** One deadline and one conditional write serve the physical database's due leases. */
export function createStateLeaseRenewalScheduler(db: EngineConnection) {
  const pending = new Map<StateLeaseRenewal, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;

  const arm = () => {
    if (running) {
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    if (pending.size > 0) {
      timer = setTimeout(run, Math.max(1, Math.min(...pending.values()) - Date.now()));
      timer.unref();
    }
  };

  function run() {
    timer = undefined;
    const now = Date.now();
    const due = [...pending].filter(([, deadline]) => deadline <= now).map(([entry]) => entry);
    for (const entry of due) {
      pending.delete(entry);
    }
    const first = due[0];
    if (!first) {
      arm();
      return;
    }
    running = true;
    try {
      first.execute(() => {
        const renewedAt = Date.now();
        const query = getNodeSqliteKysely<Pick<DB, "state_leases">>(db)
          .updateTable("state_leases")
          .set((eb) => {
            const predicate = (entry: StateLeaseRenewal) =>
              eb.and([
                eb("scope", "=", entry.identity.scope),
                eb("lease_key", "=", entry.identity.key),
                eb("owner", "=", entry.identity.owner),
              ]);
            let expiry = eb
              .case()
              .when(predicate(first))
              .then(eb.val(renewedAt + first.leaseMs));
            for (const entry of due.slice(1)) {
              expiry = expiry.when(predicate(entry)).then(eb.val(renewedAt + entry.leaseMs));
            }
            return {
              expires_at: expiry.else(eb.ref("expires_at")).end(),
              heartbeat_at: renewedAt,
              updated_at: renewedAt,
            };
          })
          .where("expires_at", ">", renewedAt)
          .where((eb) =>
            eb.or(
              due.map((entry) =>
                eb.and([
                  eb("scope", "=", entry.identity.scope),
                  eb("lease_key", "=", entry.identity.key),
                  eb("owner", "=", entry.identity.owner),
                ]),
              ),
            ),
          )
          .returning(["scope", "lease_key", "owner", "expires_at"]);
        const renew = () =>
          runSqliteSingleStatementSync(db, () => executeSqliteQuerySync(db, query).rows);
        const rows = isPostgresSqlConnection(db)
          ? renew()
          : runWithSqliteBusyTimeout(db, 0, renew, { lockFailureReporting: "suppress" });
        const expiries = new Map(
          rows.map((row) => [
            identityKey({ scope: row.scope, key: row.lease_key, owner: row.owner }),
            row.expires_at ?? undefined,
          ]),
        );
        for (const entry of due) {
          entry.complete({ expiresAt: expiries.get(identityKey(entry.identity)) });
        }
      });
    } catch (error) {
      for (const entry of due) {
        entry.complete({ error });
      }
    } finally {
      running = false;
      arm();
    }
  }

  return {
    schedule(entry: StateLeaseRenewal, expiresAt: number) {
      let deadline = Math.min(expiresAt, expiresAt - entry.leaseMs + entry.intervalMs);
      // Joining an existing cadence can renew once early, never late.
      for (const [sibling, siblingDeadline] of pending) {
        if (sibling.intervalMs === entry.intervalMs) {
          deadline = Math.min(deadline, siblingDeadline);
        }
      }
      pending.set(entry, deadline);
      arm();
    },
    cancel(entry: StateLeaseRenewal) {
      pending.delete(entry);
      arm();
    },
  };
}
