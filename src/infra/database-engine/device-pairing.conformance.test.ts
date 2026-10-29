import { describe, expect, it } from "vitest";
import type { NodeHostStats } from "../../shared/node-host-stats.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { approveDevicePairing } from "../device-pairing-approval.js";
import {
  recordPairedNodeConnection,
  recordPairedNodeDisconnection,
} from "../device-pairing-node.js";
import { setupPairedNode } from "../device-pairing-node.test-support.js";
import { readDevicePairingNodeSnapshot } from "../device-pairing-store-readonly.js";
import { readDevicePairingStoreSnapshotFromDatabase } from "../device-pairing-store.js";
import {
  getPairedDevice,
  getPendingDevicePairing,
  requestDevicePairing,
  updatePairedDeviceMetadata,
} from "../device-pairing.js";
import { isPostgresSqlConnection } from "../sql-connection.js";
import { withEngineStoreAdmission } from "./admission-scope.js";
import { mixedAgentConnection, useMixedAgentPair } from "./mixed-agent.conformance.test-support.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL pairing worker transaction", () => {
  const fixture = useMixedAgentPair("postgres", "postgres");

  it("rolls back refused approval and publishes committed pairing and metadata", async () => {
    const database = withEngineStoreAdmission(() => openOpenClawStateDatabase());
    expect(isPostgresSqlConnection(database.db)).toBe(true);
    const deviceId = "synthetic-pairing-device";
    const pairing = await requestDevicePairing(
      {
        deviceId,
        publicKey: "synthetic-pairing-key",
        role: "operator",
        scopes: ["operator.read"],
        displayName: "Original fixture",
      },
      fixture.root,
    );
    const requestId = pairing.request.requestId;
    const readCommitted = () =>
      withEngineStoreAdmission(() => readDevicePairingStoreSnapshotFromDatabase(database.db));
    const before = readCommitted();
    expect(before.state.pendingById[requestId]).toMatchObject({ deviceId });
    let allowed = true;
    await expect(
      approveDevicePairing(
        requestId,
        {
          callerScopes: ["operator.read"],
          isApprovalCurrent: () => {
            queueMicrotask(() => {
              allowed = false;
            });
            return allowed;
          },
        },
        fixture.root,
      ),
    ).resolves.toEqual({ status: "forbidden", reason: "approval-policy-changed" });
    expect(readCommitted()).toEqual(before);
    await expect(getPairedDevice(deviceId, fixture.root)).resolves.toBeNull();

    await expect(
      approveDevicePairing(requestId, { callerScopes: ["operator.read"] }, fixture.root),
    ).resolves.toMatchObject({ status: "approved", requestId, device: { deviceId } });
    await expect(getPendingDevicePairing(requestId, fixture.root)).resolves.toBeNull();
    await expect(getPairedDevice(deviceId, fixture.root)).resolves.toMatchObject({
      displayName: "Original fixture",
    });
    await expect(
      updatePairedDeviceMetadata(deviceId, { displayName: "Updated fixture" }, fixture.root),
    ).resolves.toBe(true);
    const committed = readCommitted();
    expect(committed.state.pendingById).toEqual({});
    expect(committed.state.pairedByDeviceId[deviceId]).toMatchObject({
      publicKey: "synthetic-pairing-key",
      displayName: "Updated fixture",
    });
    expect(committed.revision).not.toBe(before.revision);
    await expect(getPairedDevice(deviceId, fixture.root)).resolves.toEqual(
      committed.state.pairedByDeviceId[deviceId],
    );
  });

  it("commits and publishes the final host stats with the node disconnect", async () => {
    const database = withEngineStoreAdmission(() => openOpenClawStateDatabase());
    expect(isPostgresSqlConnection(database.db)).toBe(true);
    const generation = await setupPairedNode(fixture.root);
    await recordPairedNodeConnection("node-1", 1_000, fixture.root, generation);
    const publishedBefore = await readDevicePairingNodeSnapshot(fixture.root);
    expect(publishedBefore.paired.find((device) => device.deviceId === "node-1")).toMatchObject({
      nodeSurface: { lastConnectedAtMs: 1_000 },
    });
    const readCommitted = () =>
      withEngineStoreAdmission(() => readDevicePairingStoreSnapshotFromDatabase(database.db));
    const before = readCommitted();
    const hostStats: NodeHostStats = {
      cpuCount: 4,
      loadAverage: [1.5, 1, 0.5],
      memoryTotalBytes: 8192,
      memoryFreeBytes: 4096,
      updatedAtMs: 1_250,
    };
    await expect(
      recordPairedNodeDisconnection({
        nodeId: "node-1",
        connectedAtMs: 1_000,
        disconnectedAtMs: 1_500,
        hostStats,
        expectedPairingGeneration: generation,
        baseDir: fixture.root,
      }),
    ).resolves.toEqual({ recorded: true });
    const committed = readCommitted();
    const finalSurface = { lastDisconnectedAtMs: 1_500, lastHostStats: hostStats };
    expect(committed.state.pairedByDeviceId["node-1"]?.nodeSurface).toMatchObject(finalSurface);
    expect(BigInt(committed.revision)).toBe(BigInt(before.revision) + 1n);
    const published = await readDevicePairingNodeSnapshot(fixture.root);
    expect(published.paired.find((device) => device.deviceId === "node-1")).toMatchObject({
      nodeSurface: finalSurface,
    });
  });
});
