import { channel } from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import type { DB } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  persistDevicePairingStoreState,
  readDevicePairingStoreSnapshotFromDatabase,
} from "../device-pairing-store.js";
import { removePairedDevice } from "../device-pairing.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../kysely-sync.js";
import { clearApnsRegistrationFromDatabase } from "../push-apns-store-transaction.js";
import {
  clearApnsRegistrationIfCurrent,
  readApnsRegistrationFromDatabase,
} from "../push-apns-store.js";
import type { ApnsRegistration } from "../push-apns-store.types.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

function seed(database: OpenClawStateDatabase, nodeId: string, version: number, tombstone: number) {
  const registration: ApnsRegistration = {
    nodeId,
    transport: "direct",
    token: "0123456789abcdef0123456789abcdef",
    topic: "ai.openclaw.ios",
    environment: "sandbox",
    updatedAtMs: version,
  };
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const query = getNodeSqliteKysely<DB>(db);
      executeSqliteQuerySync(
        db,
        query.insertInto("apns_registrations").values({
          node_id: nodeId,
          transport: "direct",
          token: registration.token,
          topic: registration.topic,
          environment: registration.environment,
          updated_at_ms: version,
        }),
      );
      executeSqliteQuerySync(
        db,
        query.insertInto("apns_registration_tombstones").values({
          node_id: nodeId,
          deleted_at_ms: tombstone,
        }),
      );
    },
    { database },
  );
  return registration;
}

function readTombstone(database: OpenClawStateDatabase, nodeId: string) {
  return executeSqliteQueryTakeFirstSync(
    database.db,
    getNodeSqliteKysely<DB>(database.db)
      .selectFrom("apns_registration_tombstones")
      .select("deleted_at_ms")
      .where("node_id", "=", nodeId),
  );
}

const engines = mixedAgentConnection ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
describe.each(engines)("%s APNs deletion transaction", (engine) => {
  const fixture = useMixedAgentPair(engine, engine);

  it("clears in three statements and advances tombstones for present and absent owners", () => {
    admit(() => {
      const database = openOpenClawStateDatabase();
      const nodeId = "synthetic-delete-count";
      seed(database, nodeId, 40, 80);
      const isApnsSql = (sql: string) => /\bapns_registration(?:s|_tombstones)\b/u.test(sql);
      for (const [existed, version] of [
        [true, 81],
        [false, 82],
      ] as const) {
        let statements = 0;
        const observation = channel("openclaw.database.statement");
        const observe = (event: unknown) => {
          if (
            event &&
            typeof event === "object" &&
            "sql" in event &&
            typeof event.sql === "string" &&
            isApnsSql(event.sql)
          ) {
            statements += 1;
          }
        };
        const native = isPostgresSqlConnection(database.db)
          ? undefined
          : trackSqliteStatementExecutions(database.db, ["apns"], (sql) =>
              isApnsSql(sql) ? "apns" : null,
            );
        observation.subscribe(observe);
        try {
          expect(
            runOpenClawStateWriteTransaction(
              ({ db }) => clearApnsRegistrationFromDatabase(db, nodeId, 20),
              { database },
            ),
          ).toBe(existed);
          expect(native?.counts.apns ?? statements).toBe(3);
        } finally {
          observation.unsubscribe(observe);
          native?.restore();
        }
        expect(readApnsRegistrationFromDatabase(database.db, nodeId)).toBeNull();
        expect(readTombstone(database, nodeId)).toEqual({ deleted_at_ms: version });
      }
    });
  });

  it.each(["compare-and-clear", "standalone pairing", "bound pairing"] as const)(
    "rolls back deletion and pairing state when %s exhausts the version",
    async (caller) => {
      const nodeId = `synthetic-overflow-${caller}`;
      const database = admit(() => openOpenClawStateDatabase());
      const registration = admit(() => seed(database, nodeId, Number.MAX_SAFE_INTEGER, 17));
      admit(() =>
        persistDevicePairingStoreState(
          {
            pendingById: {},
            pairedByDeviceId: {
              [nodeId]: {
                deviceId: nodeId,
                publicKey: "synthetic-public-key",
                role: "node",
                roles: ["node"],
                createdAtMs: 1,
                approvedAtMs: 2,
              },
            },
          },
          fixture.root,
          "paired",
        ),
      );
      const read = () =>
        admit(() => ({
          registration: readApnsRegistrationFromDatabase(database.db, nodeId),
          tombstone: readTombstone(database, nodeId),
          pairing: readDevicePairingStoreSnapshotFromDatabase(database.db),
        }));
      const before = read();
      if (caller === "compare-and-clear") {
        await expect(
          clearApnsRegistrationIfCurrent({ nodeId, registration, baseDir: fixture.root }),
        ).rejects.toThrow("APNs registration version exhausted");
      } else if (caller === "standalone pairing") {
        expect(() =>
          admit(() =>
            persistDevicePairingStoreState(
              {
                pendingById: {},
                pairedByDeviceId: {},
              },
              fixture.root,
              "paired",
              { clearApnsNodeIds: [nodeId] },
            ),
          ),
        ).toThrow("APNs registration version exhausted");
      } else {
        await expect(removePairedDevice(nodeId, fixture.root)).rejects.toThrow(
          "APNs registration version exhausted",
        );
      }
      expect(read()).toEqual(before);
    },
  );
});
