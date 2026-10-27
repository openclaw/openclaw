import { channel } from "node:diagnostics_channel";
import { describe, expect, it } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { sessionSqlFixture } from "../../commands/doctor-session-sqlite.sql.test-support.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  persistDevicePairingStoreState,
  readDevicePairingStoreSnapshotFromDatabase,
  type DevicePairingStoreState,
} from "../device-pairing-store.js";
import { removePairedDevice } from "../device-pairing.js";
import { clearApnsRegistrationFromDatabase } from "../push-apns-store-transaction.js";
import {
  clearApnsRegistrationIfCurrent,
  readApnsRegistrationFromDatabase,
} from "../push-apns-store.js";
import type { ApnsRegistration } from "../push-apns-store.types.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission as admit } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";
import { createSqlStatementObserver } from "./sql-statement-observer.test-support.js";

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
      const sql = sessionSqlFixture(db);
      sql`INSERT INTO apns_registrations (node_id, transport, token, topic, environment, updated_at_ms)
        VALUES (${nodeId}, 'direct', ${registration.token}, ${registration.topic}, ${registration.environment}, ${version})`.run();
      sql`INSERT INTO apns_registration_tombstones (node_id, deleted_at_ms) VALUES (${nodeId}, ${tombstone})`.run();
    },
    { database },
  );
  return registration;
}

function readTombstone(database: OpenClawStateDatabase, nodeId: string) {
  return sessionSqlFixture(
    database.db,
  )`SELECT deleted_at_ms FROM apns_registration_tombstones WHERE node_id = ${nodeId}`.get();
}

const engines = mixedAgentConnection ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
describe.each(engines)("%s APNs deletion transaction", (engine) => {
  const fixture = useMixedAgentPair(engine, engine);
  const persistPairing = (
    pairedByDeviceId: DevicePairingStoreState["pairedByDeviceId"],
    clearApnsNodeIds?: string[],
  ) =>
    admit(() =>
      persistDevicePairingStoreState(
        { pendingById: {}, pairedByDeviceId },
        fixture.root,
        "paired",
        clearApnsNodeIds ? { clearApnsNodeIds } : undefined,
      ),
    );

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
        const observe = createSqlStatementObserver(isApnsSql, () => {
          statements += 1;
        });
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
      persistPairing({
        [nodeId]: {
          deviceId: nodeId,
          publicKey: "synthetic-public-key",
          role: "node",
          roles: ["node"],
          createdAtMs: 1,
          approvedAtMs: 2,
        },
      });
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
        expect(() => persistPairing({}, [nodeId])).toThrow("APNs registration version exhausted");
      } else {
        await expect(removePairedDevice(nodeId, fixture.root)).rejects.toThrow(
          "APNs registration version exhausted",
        );
      }
      expect(read()).toEqual(before);
    },
  );
});
