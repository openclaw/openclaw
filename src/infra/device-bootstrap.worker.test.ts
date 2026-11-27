import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import * as bootstrap from "./device-bootstrap.js";
import {
  loadDeviceBootstrapTokenRecords,
  persistDeviceBootstrapTokenRecords,
  persistDevicePairingStoreState,
} from "./device-pairing-store.js";
import { rejectDevicePairing, requestDevicePairing } from "./device-pairing.js";
import type { PairedDevice } from "./device-pairing.types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

const node = { role: "node", scopes: [] };
const identity = { deviceId: "device-123", publicKey: "public-key-123" };
const verify = (baseDir: string, token: string, device = identity) =>
  bootstrap.verifyDeviceBootstrapToken({ baseDir, token, ...node, ...device });
const readCompletion = (baseDir: string, setupId: string) =>
  bootstrap.readDevicePairSetupCompletion({ baseDir, setupId });

it.each(["replaced identity", "retired authority", "expired credential"] as const)(
  "refuses setup completion when consumption sees %s",
  async (changed) => {
    const expired = changed === "expired credential";
    if (expired) {
      vi.useFakeTimers({ now: new Date("2026-03-14T12:00:00Z") });
    }
    const baseDir = tempDirs.make("openclaw-device-bootstrap-worker-");
    const issued = await bootstrap.issueDevicePairSetupBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    await verify(baseDir, issued.token);
    const tokenBytes = JSON.stringify(loadDeviceBootstrapTokenRecords(baseDir));
    const persistPaired = (publicKey: string) =>
      persistDevicePairingStoreState(
        {
          pendingById: {},
          pairedByDeviceId: {
            "device-123": { ...identity, publicKey, createdAtMs: 1, approvedAtMs: 1 },
          },
        },
        baseDir,
        "paired",
      );
    if (expired) {
      vi.setSystemTime(new Date(Date.now() + 10 * 60 * 1000 + 1));
    } else {
      persistPaired(changed === "replaced identity" ? "replacement-key" : "public-key-123");
    }
    let authorityCurrent = true;
    const completion = {
      baseDir,
      token: issued.token,
      deviceId: "device-123",
      completedAtMs: expired ? Date.now() : 1_000,
    };
    const consume = (pairedDeviceMatches?: (device: PairedDevice | null) => boolean) =>
      bootstrap.consumeDeviceBootstrapTokenWithSetupCompletion({
        ...completion,
        pairedDeviceMatches,
      });
    await expect(
      consume(
        expired
          ? undefined
          : (device) => {
              const accepted = authorityCurrent && device?.publicKey === "public-key-123";
              if (changed === "retired authority") {
                queueMicrotask(() => {
                  authorityCurrent = false;
                });
              }
              return accepted;
            },
      ),
    ).resolves.toBeNull();
    if (!expired) {
      expect(JSON.stringify(loadDeviceBootstrapTokenRecords(baseDir))).toBe(tokenBytes);
    }
    await expect(readCompletion(baseDir, issued.setupId)).resolves.toBeNull();
    if (expired) {
      return;
    }

    persistPaired("public-key-123");
    await expect(
      consume((device) => device?.publicKey === "public-key-123"),
    ).resolves.toMatchObject({
      completion: { setupId: issued.setupId, deviceId: "device-123", deliveryState: "uncertain" },
    });
  },
);

it("rejecting a pending request revokes only bootstrap tokens bound to its exact identity", async () => {
  const baseDir = tempDirs.make("openclaw-device-bootstrap-reject-");
  const issued = await bootstrap.issueDeviceBootstrapToken({ baseDir });
  const device = { deviceId: "bootstrap-reject-device", publicKey: "bootstrap-reject-public-key" };

  await expect(verify(baseDir, issued.token, device)).resolves.toEqual({ ok: true });

  const record = loadDeviceBootstrapTokenRecords(baseDir)[issued.token]!;
  const { deviceId: _deviceId, publicKey: _publicKey, ...unbound } = record;
  const retained = {
    "other-device": { ...record, token: "other-device", deviceId: "another-device" },
    "other-key": { ...record, token: "other-key", publicKey: "another-public-key" },
    unbound: { ...unbound, token: "unbound" },
  };
  persistDeviceBootstrapTokenRecords(
    {
      [issued.token]: record,
      "synthetic-matching": { ...record, token: "synthetic-matching" },
      ...retained,
    },
    baseDir,
  );

  const pending = await requestDevicePairing({ ...device, ...node, roles: ["node"] }, baseDir);

  await expect(rejectDevicePairing(pending.request.requestId, baseDir)).resolves.toEqual({
    requestId: pending.request.requestId,
    deviceId: device.deviceId,
  });
  await expect(verify(baseDir, issued.token, device)).resolves.toEqual({
    ok: false,
    reason: "bootstrap_token_invalid",
  });
  expect(loadDeviceBootstrapTokenRecords(baseDir)).toEqual(retained);
});
