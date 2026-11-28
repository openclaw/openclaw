import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { tableExists } from "./openclaw-state-db-schema-helpers.js";
import type { DB } from "./openclaw-state-db.generated.js";
import { createOpenClawStateSchemaEnsurer } from "./openclaw-state-feature-schema-ensure.js";
import type { WorkerWriteOperationContext } from "./worker-operation-registry.js";

const table = "pwa_icon_slots";
const queries = (db: EngineConnection) => getNodeSqliteKysely<Pick<DB, typeof table>>(db);
const ensure = createOpenClawStateSchemaEnsurer({ table, operationLabel: "pwaIcon.schema.ensure" });

export const pwaIconReadOperations = {
  "pwaIcon.tokens": (_input: undefined, db: EngineConnection) => ({
    type: "pwaIcon.tokens" as const,
    tokens: tableExists(db, table)
      ? executeSqliteQuerySync(db, queries(db).selectFrom(table).select("token")).rows.map(
          (row) => row.token,
        )
      : [],
  }),
};

type Change = { profileKey: string; device: string; token: string | null };
export const pwaIconOperations = {
  "pwaIcon.change": (input: Change, context: WorkerWriteOperationContext) => {
    if (input.token !== null) {
      ensure({ ...context.stateOptions(), database: context.open() });
    }
    return context.writeAdmitted(
      ({ db }) => {
        const k = queries(db);
        if (!tableExists(db, table)) {
          return { status: "ok", previous: undefined } as const;
        }
        const { profileKey, device, token } = input;
        const previous = executeSqliteQueryTakeFirstSync(
          db,
          k
            .selectFrom(table)
            .select("token")
            .where("profile_key", "=", profileKey)
            .where("device_key", "=", device),
        )?.token;
        if (token !== null) {
          if (!previous) {
            const counts = k.selectFrom(table).select((eb) => eb.fn.countAll<number>().as("n"));
            if (
              Number(executeSqliteQueryTakeFirstSync(db, counts)?.n) >= 128 ||
              Number(
                executeSqliteQueryTakeFirstSync(db, counts.where("profile_key", "=", profileKey))
                  ?.n,
              ) >= 8
            ) {
              return { status: "full" } as const;
            }
          }
          executeSqliteQuerySync(
            db,
            k
              .insertInto(table)
              .values({ profile_key: profileKey, device_key: device, token })
              .onConflict((conflict) =>
                conflict.columns(["profile_key", "device_key"]).doUpdateSet({ token }),
              ),
          );
        } else if (previous) {
          executeSqliteQuerySync(
            db,
            k
              .deleteFrom(table)
              .where("profile_key", "=", profileKey)
              .where("device_key", "=", device),
          );
        }
        return { status: "ok", previous } as const;
      },
      { operationLabel: "pwaIcon.change" },
    );
  },
};
