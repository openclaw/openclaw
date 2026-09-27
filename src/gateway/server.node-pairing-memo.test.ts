import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { requestNodePairing } from "../infra/device-pairing-node.js";
import { persistDeviceBootstrapTokenRecords } from "../infra/device-pairing-store.js";
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
    test("serves node.list without host pairing-table queries across unrelated state writes", async () => {
      const nodeId = "node-list-memo-scan-count";
      const ws = await openTrackedWs(getStarted().port);
      try {
        await connectOk(ws, {
          token: "secret",
          scopes: ["operator.read", "operator.pairing"],
          deviceIdentityPath: `${await makeNodePairingStateDir()}/memo-scan-count.sqlite`,
        });
        await seedNodeDevice(nodeId);
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
        try {
          expect(await rpcReq(ws, "node.list", {})).toMatchObject({
            ok: true,
            payload: { nodes: expect.arrayContaining([expect.objectContaining({ nodeId })]) },
          });
          persistDeviceBootstrapTokenRecords({
            memo: { token: "synthetic-bootstrap", ts: Date.now(), issuedAtMs: Date.now() },
          });
          expect(await rpcReq(ws, "node.list", {})).toMatchObject({
            ok: true,
            payload: { nodes: expect.arrayContaining([expect.objectContaining({ nodeId })]) },
          });
          expect(tableSelects).toEqual({ paired: 0, pending: 0 });
        } finally {
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
