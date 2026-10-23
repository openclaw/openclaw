import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { openClientCredentialCustody } from "./client-credential-store.js";
import {
  clearDeviceAuthToken,
  loadOriginDeviceToken,
  storeDeviceAuthToken,
} from "./device-auth-store.js";
import {
  readDeviceAuthTokenForTest as readCachedToken,
  seedDeviceAuthToken,
  seedOriginDeviceToken,
} from "./device-auth-store.test-support.js";
import { approveDevicePairing } from "./device-pairing-approval.js";
import { rotateDeviceToken, verifyDeviceToken } from "./device-pairing-tokens.js";
import {
  getPairedDevice,
  requestDevicePairing,
  withPairedDeviceRecords,
  type PairedDevice,
} from "./device-pairing.js";

const pairingWarn = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (name: string) => {
      const logger = actual.createSubsystemLogger(name);
      return name === "gateway/device-pairing" ? { ...logger, warn: pairingWarn } : logger;
    },
  };
});

const suiteRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-pairing-local-credentials-",
});

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function requireToken(token: string | undefined): string {
  expect(token).toBeTypeOf("string");
  return requireValue(token, "expected device token");
}

function requireRotatedEntry(result: Awaited<ReturnType<typeof rotateDeviceToken>>) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected rotated token entry, got ${result.reason}`);
  }
  return result.entry;
}

function requestPairing(
  request: Partial<Parameters<typeof requestDevicePairing>[0]>,
  stateDir: string,
) {
  return requestDevicePairing(
    { deviceId: "device-1", publicKey: "public-key-1", ...request },
    stateDir,
  );
}

async function mutatePairedDevice(
  stateDir: string,
  deviceId: string,
  mutate: (device: PairedDevice) => void,
) {
  await withPairedDeviceRecords(stateDir, (pairedByDeviceId) => {
    const device = requireValue(pairedByDeviceId[deviceId], `expected paired device ${deviceId}`);
    mutate(device);
    return { value: undefined, persist: true };
  });
}

async function legacyNodeRecovery() {
  const dir = await suiteRootTracker.make("legacy-node-recovery");
  const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
  const { request } = await requestPairing(
    {
      displayName: "Workshop device",
      roles: ["operator", "node", "observer"],
      scopes: ["operator.read"],
    },
    dir,
  );
  await approveDevicePairing(request.requestId, { callerScopes: ["operator.admin"] }, dir);
  await mutatePairedDevice(dir, "device-1", (device) => {
    device.operatorLabel = "Workshop";
    requireValue(device.tokens?.node, "expected node token").scopes = ["operator.read"];
  });
  const before = requireValue(await getPairedDevice("device-1", dir), "expected paired device");
  const token = requireToken(before.tokens?.node?.token);
  const cached = seedDeviceAuthToken({
    deviceId: "device-1",
    role: "node",
    token,
    scopes: ["operator.read"],
    env,
  });
  return { baseDir: dir, env, before, token, cached };
}

describe("device pairing local credential cleanup", () => {
  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  beforeEach(() => {
    pairingWarn.mockClear();
  });

  afterAll(async () => {
    await closeStateDatabaseForTest();
    await suiteRootTracker.cleanup();
  });

  test("recovers legacy node scopes and retires only its matching cached bearer", async () => {
    const { baseDir: dir, env, before, token, cached } = await legacyNodeRecovery();

    await expect(
      rotateDeviceToken({ deviceId: "device-1", role: "node", baseDir: dir }),
    ).resolves.toEqual({ ok: false, reason: "scope-outside-approved-baseline" });
    expect(readCachedToken({ deviceId: "device-1", role: "node", env })).toEqual(cached);

    const entry = requireRotatedEntry(
      await rotateDeviceToken({ deviceId: "device-1", role: "node", scopes: [], baseDir: dir }),
    );

    expect(entry.scopes).toEqual([]);
    expect(entry.token).not.toBe(token);
    expect(readCachedToken({ deviceId: "device-1", role: "node", env })).toBeNull();
    expect(await getPairedDevice("device-1", dir)).toEqual({
      ...before,
      tokens: { ...before.tokens, node: entry },
    });
    await expect(
      verifyDeviceToken({ deviceId: "device-1", role: "node", token, scopes: [], baseDir: dir }),
    ).resolves.toEqual({ ok: false, reason: "token-mismatch" });
    await expect(
      verifyDeviceToken({
        deviceId: "device-1",
        role: "node",
        token: entry.token,
        scopes: [],
        baseDir: dir,
      }),
    ).resolves.toEqual({ ok: true });
  });

  test("legacy node recovery preserves refreshed and unrelated cached credentials", async () => {
    const { baseDir: dir, env, token } = await legacyNodeRecovery();
    const refreshed = await storeDeviceAuthToken({
      deviceId: "device-1",
      role: "node",
      token: "refreshed-node-bearer",
      scopes: [],
      env,
      expectedToken: token,
    });
    const operator = seedDeviceAuthToken({ deviceId: "device-1", role: "operator", token, env });
    const otherDevice = seedDeviceAuthToken({ deviceId: "device-2", role: "node", token, env });
    const gatewayScope = "wss://other-gateway.example/rpc";
    const origin = seedOriginDeviceToken({
      gatewayScope,
      deviceId: "device-1",
      role: "node",
      token,
      env,
    });
    const otherEnv = {
      ...process.env,
      OPENCLAW_STATE_DIR: await suiteRootTracker.make("other-profile"),
    };
    const otherProfile = seedDeviceAuthToken({
      deviceId: "device-1",
      role: "node",
      token,
      env: otherEnv,
    });

    requireRotatedEntry(
      await rotateDeviceToken({ deviceId: "device-1", role: "node", scopes: [], baseDir: dir }),
    );

    expect(refreshed).not.toBeNull();
    expect(readCachedToken({ deviceId: "device-1", role: "node", env })).toEqual(refreshed);
    expect(readCachedToken({ deviceId: "device-1", role: "operator", env })).toEqual(operator);
    expect(readCachedToken({ deviceId: "device-2", role: "node", env })).toEqual(otherDevice);
    expect(
      await loadOriginDeviceToken({ gatewayScope, deviceId: "device-1", role: "node", env }),
    ).toEqual(origin);
    expect(readCachedToken({ deviceId: "device-1", role: "node", env: otherEnv })).toEqual(
      otherProfile,
    );
  });

  test("keeps server rotation committed and warns when matching local cache cleanup is busy", async () => {
    const { baseDir: dir, env, before, token, cached } = await legacyNodeRecovery();
    const custody = requireValue(
      openClientCredentialCustody(env),
      "expected local credential custody",
    );
    try {
      const entry = requireRotatedEntry(
        await rotateDeviceToken({ deviceId: "device-1", role: "node", scopes: [], baseDir: dir }),
      );
      expect(entry.token).not.toBe(token);
      expect(await getPairedDevice("device-1", dir)).toEqual({
        ...before,
        tokens: { ...before.tokens, node: entry },
      });
      expect(pairingWarn).toHaveBeenCalledExactlyOnceWith(
        expect.stringMatching(
          /Local retired node token cleanup failed: .*Client credentials are busy/,
        ),
      );
      await expect(
        verifyDeviceToken({ deviceId: "device-1", role: "node", token, scopes: [], baseDir: dir }),
      ).resolves.toEqual({ ok: false, reason: "token-mismatch" });
      await expect(
        verifyDeviceToken({
          deviceId: "device-1",
          role: "node",
          token: entry.token,
          scopes: [],
          baseDir: dir,
        }),
      ).resolves.toEqual({ ok: true });
    } finally {
      custody.close();
    }

    expect(readCachedToken({ deviceId: "device-1", role: "node", env })).toEqual(cached);
    await expect(
      clearDeviceAuthToken({ deviceId: "device-1", role: "node", expectedToken: token, env }),
    ).resolves.toBe(true);
    expect(readCachedToken({ deviceId: "device-1", role: "node", env })).toBeNull();
  });

  test("valid node rotation to empty scopes does not apply legacy cache cleanup", async () => {
    const dir = await suiteRootTracker.make("valid-node-rotation");
    const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
    const { request } = await requestPairing(
      { deviceId: "node-1", publicKey: "node-key", role: "node", scopes: ["node.exec"] },
      dir,
    );
    await approveDevicePairing(request.requestId, dir);
    const before = requireValue(await getPairedDevice("node-1", dir), "expected paired node");
    const cached = seedDeviceAuthToken({
      deviceId: "node-1",
      role: "node",
      token: requireToken(before.tokens?.node?.token),
      scopes: ["node.exec"],
      env,
    });

    const entry = requireRotatedEntry(
      await rotateDeviceToken({ deviceId: "node-1", role: "node", scopes: [], baseDir: dir }),
    );

    expect(entry.scopes).toEqual([]);
    expect(readCachedToken({ deviceId: "node-1", role: "node", env })).toEqual(cached);
    expect((await getPairedDevice("node-1", dir))?.approvedScopes).toEqual(["node.exec"]);
  });
});
