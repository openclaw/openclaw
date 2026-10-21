import { describe, expect, it } from "vitest";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { approveDevicePairing } from "../device-pairing-approval.js";
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
});
