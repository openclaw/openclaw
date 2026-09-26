import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  consumeDeviceBootstrapTokenWithSetupCompletion,
  issueDevicePairSetupBootstrapToken,
  issueDeviceBootstrapToken,
  readDevicePairSetupCompletion,
  verifyDeviceBootstrapToken,
} from "./device-bootstrap.js";
import {
  loadDeviceBootstrapTokenRecords,
  persistDeviceBootstrapTokenRecords,
  persistDevicePairingStoreState,
} from "./device-pairing-store.js";
import { rejectDevicePairing, requestDevicePairing } from "./device-pairing.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.useRealTimers();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);

async function verifyBootstrapToken(baseDir: string, token: string) {
  return await verifyDeviceBootstrapToken({
    baseDir,
    token,
    deviceId: "device-123",
    publicKey: "public-key-123",
    role: "node",
    scopes: [],
  });
}

it.each(["replaced identity", "retired authority"] as const)(
  "keeps the bearer and completion unchanged when consumption sees %s",
  async (changed) => {
    const baseDir = tempDirs.make("openclaw-device-bootstrap-worker-");
    const issued = await issueDevicePairSetupBootstrapToken({
      baseDir,
      profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    await verifyBootstrapToken(baseDir, issued.token);
    const tokenBytes = JSON.stringify(loadDeviceBootstrapTokenRecords(baseDir));
    const persistPaired = (publicKey: string) =>
      persistDevicePairingStoreState(
        {
          pendingById: {},
          pairedByDeviceId: {
            "device-123": {
              deviceId: "device-123",
              publicKey,
              createdAtMs: 1,
              approvedAtMs: 1,
            },
          },
        },
        baseDir,
        "paired",
      );
    persistPaired(changed === "replaced identity" ? "replacement-key" : "public-key-123");
    let authorityCurrent = true;
    const completion = {
      baseDir,
      token: issued.token,
      deviceId: "device-123",
      completedAtMs: 1_000,
    };
    await expect(
      consumeDeviceBootstrapTokenWithSetupCompletion({
        ...completion,
        pairedDeviceMatches: (device) => {
          const accepted = authorityCurrent && device?.publicKey === "public-key-123";
          if (changed === "retired authority") {
            queueMicrotask(() => {
              authorityCurrent = false;
            });
          }
          return accepted;
        },
      }),
    ).resolves.toBeNull();
    expect(JSON.stringify(loadDeviceBootstrapTokenRecords(baseDir))).toBe(tokenBytes);
    await expect(
      readDevicePairSetupCompletion({ baseDir, setupId: issued.setupId }),
    ).resolves.toBeNull();

    persistPaired("public-key-123");
    await expect(
      consumeDeviceBootstrapTokenWithSetupCompletion({
        ...completion,
        pairedDeviceMatches: (device) => device?.publicKey === "public-key-123",
      }),
    ).resolves.toMatchObject({
      completion: { setupId: issued.setupId, deviceId: "device-123", deliveryState: "uncertain" },
    });
  },
);

it("rejects a setup credential that expires after verification but before consumption", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-14T12:00:00Z"));
  const baseDir = tempDirs.make("openclaw-device-bootstrap-worker-expiry-");
  const issued = await issueDevicePairSetupBootstrapToken({
    baseDir,
    profile: NODE_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  });
  await verifyBootstrapToken(baseDir, issued.token);

  vi.setSystemTime(new Date(Date.now() + 10 * 60 * 1000 + 1));
  await expect(
    consumeDeviceBootstrapTokenWithSetupCompletion({
      token: issued.token,
      deviceId: "device-123",
      completedAtMs: Date.now(),
      baseDir,
    }),
  ).resolves.toBeNull();

  await expect(
    readDevicePairSetupCompletion({ baseDir, setupId: issued.setupId }),
  ).resolves.toBeNull();
});

it("rejecting a pending request revokes only bootstrap tokens bound to its exact identity", async () => {
  const baseDir = tempDirs.make("openclaw-device-bootstrap-reject-");
  const issued = await issueDeviceBootstrapToken({ baseDir });

  await expect(
    verifyDeviceBootstrapToken({
      token: issued.token,
      deviceId: "bootstrap-reject-device",
      publicKey: "bootstrap-reject-public-key",
      role: "node",
      scopes: [],
      baseDir,
    }),
  ).resolves.toEqual({ ok: true });

  const record = loadDeviceBootstrapTokenRecords(baseDir)[issued.token]!;
  const { deviceId: _deviceId, publicKey: _publicKey, ...unbound } = record;
  const retained = {
    "synthetic-other-device": {
      ...record,
      token: "synthetic-other-device",
      deviceId: "another-device",
    },
    "synthetic-other-key": {
      ...record,
      token: "synthetic-other-key",
      publicKey: "another-public-key",
    },
    "synthetic-unbound": { ...unbound, token: "synthetic-unbound" },
  };
  persistDeviceBootstrapTokenRecords(
    {
      [issued.token]: record,
      "synthetic-matching": { ...record, token: "synthetic-matching" },
      ...retained,
    },
    baseDir,
  );

  const pending = await requestDevicePairing(
    {
      deviceId: "bootstrap-reject-device",
      publicKey: "bootstrap-reject-public-key",
      role: "node",
      roles: ["node"],
      scopes: [],
    },
    baseDir,
  );

  await expect(rejectDevicePairing(pending.request.requestId, baseDir)).resolves.toEqual({
    requestId: pending.request.requestId,
    deviceId: "bootstrap-reject-device",
  });
  await expect(
    verifyDeviceBootstrapToken({
      token: issued.token,
      deviceId: "bootstrap-reject-device",
      publicKey: "bootstrap-reject-public-key",
      role: "node",
      scopes: [],
      baseDir,
    }),
  ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });
  expect(loadDeviceBootstrapTokenRecords(baseDir)).toEqual(retained);
});
