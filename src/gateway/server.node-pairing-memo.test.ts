import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { requestNodePairing } from "../infra/device-pairing-node.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import { configureSqliteConnectionPragmas } from "../infra/sqlite-wal.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { openTrackedWs } from "./device-authz.test-helpers.js";
import {
  createNodePairingTestState,
  describeWithGatewayServer,
} from "./server.node-pairing.test-support.js";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const {
  cleanup: cleanupNodePairingTestState,
  makeStateDir: makeNodePairingStateDir,
  seedNodeDevice,
  setup: setupNodePairingTestState,
} = createNodePairingTestState("openclaw-node-pair-memo-");

describe("gateway node pairing memoization", () => {
  beforeAll(async () => {
    await setupNodePairingTestState();
  });

  afterAll(async () => {
    closeOpenClawStateDatabaseForTest();
    await cleanupNodePairingTestState();
  });

  describeWithGatewayServer("node.list pairing snapshots", (getStarted) => {
    test("scans pairing tables once across two node.list dispatches", async () => {
      const ws = await openTrackedWs(getStarted().port);
      try {
        await connectOk(ws, {
          token: "secret",
          scopes: ["operator.read", "operator.pairing"],
          deviceIdentityPath: `${await makeNodePairingStateDir()}/memo-scan-count.sqlite`,
        });
        await seedNodeDevice("node-list-memo-scan-count");
        const database = openOpenClawStateDatabase();
        const { counts: tableSelects, restore } = trackSqliteStatementExecutions(
          database.db,
          ["paired", "pending"],
          (sql) => {
            if (sql.includes('from "device_pairing_pending"')) {
              return "pending";
            }
            if (sql.includes('from "device_pairing_paired"')) {
              return "paired";
            }
            return null;
          },
        );
        const observations: Array<{
          phase: string;
          token: string;
          value: number;
          tableSelects: typeof tableSelects;
        }> = [];
        const restoreTokenStatements: Array<() => void> = [];
        let phase = "first";
        const prepareDescriptor = Object.getOwnPropertyDescriptor(database.db, "prepare");
        const prepare = database.db.prepare.bind(database.db);
        database.db.prepare = (sql) => {
          const statement = prepare(sql);
          const token =
            sql === "PRAGMA data_version"
              ? "data_version"
              : sql === "SELECT total_changes() AS value"
                ? "value"
                : undefined;
          if (token) {
            const descriptor = Object.getOwnPropertyDescriptor(statement, "get");
            restoreTokenStatements.push(() => {
              if (descriptor) {
                Object.defineProperty(statement, "get", descriptor);
              } else {
                Reflect.deleteProperty(statement, "get");
              }
            });
            statement.get = new Proxy(statement.get.bind(statement), {
              apply(get, _receiver, bindings) {
                const row = get(...bindings);
                const value = row?.[token];
                if (typeof value === "number") {
                  observations.push({ phase, token, value, tableSelects: { ...tableSelects } });
                }
                return row;
              },
            });
          }
          return statement;
        };
        try {
          expect((await rpcReq(ws, "node.list", {})).ok).toBe(true);
          phase = "second";
          expect((await rpcReq(ws, "node.list", {})).ok).toBe(true);
          expect(tableSelects).toEqual({ paired: 1, pending: 1 });
        } catch (error) {
          console.error("node.list pairing cache observations", { observations, tableSelects });
          throw error;
        } finally {
          if (prepareDescriptor) {
            Object.defineProperty(database.db, "prepare", prepareDescriptor);
          } else {
            Reflect.deleteProperty(database.db, "prepare");
          }
          for (const restoreTokenStatement of restoreTokenStatements) {
            restoreTokenStatement();
          }
          restore();
        }
      } finally {
        ws.close();
      }
    });

    test("reflects a pairing mutation on the next node.list dispatch", async () => {
      const nodeId = "node-list-memo-mutation";
      await seedNodeDevice(nodeId);
      const ws = await openTrackedWs(getStarted().port);
      try {
        await connectOk(ws, {
          token: "secret",
          scopes: ["operator.read", "operator.pairing"],
          deviceIdentityPath: `${await makeNodePairingStateDir()}/memo-mutation.sqlite`,
        });
        const before = await rpcReq<{
          nodes?: Array<{ nodeId: string; pendingRequestId?: string }>;
        }>(ws, "node.list", {});
        expect(before.payload?.nodes?.find((node) => node.nodeId === nodeId)).not.toHaveProperty(
          "pendingRequestId",
        );

        const pending = await requestNodePairing({
          nodeId,
          platform: "macos",
          commands: ["system.run"],
        });
        const after = await rpcReq<{
          nodes?: Array<{ nodeId: string; pendingRequestId?: string }>;
        }>(ws, "node.list", {});
        expect(after.payload?.nodes).toContainEqual(
          expect.objectContaining({
            nodeId,
            pendingRequestId: pending.request.requestId,
          }),
        );
      } finally {
        ws.close();
      }
    });
  });

  test("reloads cached pairing tables after another connection commits", async () => {
    const nodeId = "node-pairing-memo-external-writer";
    const baseDir = await makeNodePairingStateDir();
    await seedNodeDevice(nodeId, baseDir);
    expect(
      (await listDevicePairing(baseDir)).paired.find((device) => device.deviceId === nodeId)
        ?.displayName,
    ).toBeUndefined();

    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
    });
    const external = new DatabaseSync(database.path);
    const maintenance = configureSqliteConnectionPragmas(external, {
      checkpointIntervalMs: 0,
      databaseLabel: "device-pairing-memo-external-writer",
      databasePath: database.path,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    try {
      external
        .prepare("UPDATE device_pairing_paired SET display_name = ? WHERE device_id = ?")
        .run("external name", nodeId);

      expect(
        (await listDevicePairing(baseDir)).paired.find((device) => device.deviceId === nodeId)
          ?.displayName,
      ).toBe("external name");
    } finally {
      maintenance.close();
      external.close();
    }
  });
});
