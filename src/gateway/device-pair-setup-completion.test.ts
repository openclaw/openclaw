import { afterEach, describe, expect, it, vi } from "vitest";
import { readDevicePairSetupCompletion } from "../infra/device-bootstrap.js";
import {
  persistDeviceBootstrapTokenRecords,
  persistDevicePairingStoreState,
} from "../infra/device-pairing-store.js";
import type { DeviceBootstrapTokenRecord, PairedDevice } from "../infra/device-pairing.types.js";
import {
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../shared/device-bootstrap-profile.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  broadcastSetupHandoffCompletion,
  confirmSetupHandoffDelivery,
  consumeSetupHandoff,
} from "./device-pair-setup-completion.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import { GatewayClientRegistry } from "./server/client-registry.js";

const tempDirs = createTrackedTempDirs();
const deviceId = "device-123";

async function setupHandoff(
  baseDir: string,
  profile?: DeviceBootstrapTokenRecord["profile"],
  setupId?: string,
) {
  const token = setupId ? "bootstrap-secret" : "generic";
  const now = Date.now();
  persistDeviceBootstrapTokenRecords(
    { [token]: { token, setupId, ts: now, deviceId, profile, issuedAtMs: now } },
    baseDir,
  );
  const ts = setupId ? 3 : undefined;
  const handoff = await consumeSetupHandoff({ token, deviceId, baseDir, ts });
  expect(handoff).not.toBeNull();
  if (!setupId) {
    return handoff!;
  }
  const confirmed = await confirmSetupHandoffDelivery({ handoff: handoff!, baseDir });
  expect(confirmed).not.toBeNull();
  return confirmed!;
}

afterEach(async () => {
  await closeStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("device pair setup completion", () => {
  it.each([
    ["full", FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE],
    ["limited", PAIRING_SETUP_BOOTSTRAP_PROFILE],
    ["node", NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE],
  ] as const)("broadcasts authoritative %s completion metadata", async (access, profile) => {
    const baseDir = await tempDirs.make(`openclaw-setup-completion-${access}-`);
    const paired: PairedDevice = {
      deviceId,
      publicKey: "public-key-123",
      displayName: "Client name",
      operatorLabel: "Operator name",
      createdAtMs: 1,
      approvedAtMs: 2,
    };
    persistDevicePairingStoreState(
      { pendingById: {}, pairedByDeviceId: { [paired.deviceId]: paired } },
      baseDir,
      "paired",
    );
    const broadcast = vi.fn();
    const handoff = await setupHandoff(baseDir, profile, "setup-exact");
    broadcastSetupHandoffCompletion({ handoff, broadcast });
    expect(broadcast).toHaveBeenCalledWith(
      "device.pair.setup.completed",
      {
        setupId: "setup-exact",
        deviceId: paired.deviceId,
        deviceName: "Operator name",
        access,
        ts: 3,
      },
      { dropIfSlow: true },
    );
    expect(JSON.stringify(broadcast.mock.calls)).not.toContain("bootstrap-secret");
  });

  it("keeps the completion recoverable when a slow subscriber drops the frame", async () => {
    const baseDir = await tempDirs.make("openclaw-setup-completion-slow-");
    const { client, socket: slowSocket } = makeClient("c-pairing-slow", "operator", [
      "operator.pairing",
    ]);
    slowSocket.bufferedAmount = MAX_BUFFERED_BYTES + 1;
    const clients = new GatewayClientRegistry([client]);
    const { broadcast } = createGatewayBroadcaster({ clients });

    const handoff = await setupHandoff(
      baseDir,
      FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      "setup-dropped",
    );
    broadcastSetupHandoffCompletion({ handoff, broadcast });

    expect(slowSocket.send).not.toHaveBeenCalled();
    expect(slowSocket.close).not.toHaveBeenCalled();
    await expect(
      readDevicePairSetupCompletion({ baseDir, setupId: "setup-dropped" }),
    ).resolves.toMatchObject({
      setupId: "setup-dropped",
      deviceId: "device-123",
      access: "full",
      completedAtMs: 3,
      deliveryState: "confirmed",
    });
  });

  it("ignores generic bootstrap records without setup correlation", async () => {
    const baseDir = await tempDirs.make("openclaw-setup-completion-generic-");
    const broadcast = vi.fn();
    const handoff = await setupHandoff(baseDir);
    expect(handoff).toMatchObject({ record: { token: "generic" } });
    broadcastSetupHandoffCompletion({ handoff, broadcast });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
