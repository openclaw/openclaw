// Covers bootstrap device pairing approval and handoff scope baselines.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
  FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
  PAIRING_SETUP_BOOTSTRAP_PROFILE,
} from "../shared/device-bootstrap-profile.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { approveBootstrapDevicePairing, approveDevicePairing } from "./device-pairing-approval.js";
import {
  loadDevicePairingStoreState,
  persistDevicePairingStoreState,
} from "./device-pairing-store.js";
import { ensureDeviceToken, verifyDeviceToken } from "./device-pairing-tokens.js";
import {
  getPairedDevice,
  requestDevicePairing,
  withPairedDeviceRecords,
  type PairedDevice,
} from "./device-pairing.js";

const suiteRootTracker = createSuiteTempRootTracker({
  prefix: "openclaw-device-pairing-bootstrap-",
});
let suiteBaseDir = "";
const requireRecord = createRequireRecord("record", "message");

async function makeDevicePairingDir(): Promise<string> {
  if (!suiteBaseDir) {
    throw new Error("device pairing bootstrap test root is not initialized");
  }
  return suiteBaseDir;
}

function requireToken(token: string | undefined): string {
  expect(typeof token).toBe("string");
  if (typeof token !== "string") {
    throw new Error("expected device token to be issued");
  }
  return token;
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function expectRecordFields(
  value: unknown,
  message: string,
  expected: Record<string, unknown>,
): Record<string, unknown> {
  const record = requireRecord(value, message);
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], `${message}.${key}`).toEqual(expectedValue);
  }
  return record;
}

async function mutatePairedDevice(
  baseDir: string,
  deviceId: string,
  mutate: (device: PairedDevice) => void,
) {
  await withPairedDeviceRecords(baseDir, (pairedByDeviceId) => {
    const device = requireValue(pairedByDeviceId[deviceId], `expected paired device ${deviceId}`);
    mutate(device);
    return { value: undefined, persist: true };
  });
}

function mutatePendingRequest(
  baseDir: string,
  requestId: string,
  mutate: (pending: { ts: number; refreshedAtMs?: number; scopes?: string[] }) => void,
) {
  const state = loadDevicePairingStoreState(baseDir);
  const pending = requireValue(state.pendingById[requestId], "expected pending pairing request");
  mutate(pending);
  persistDevicePairingStoreState(state, baseDir, "pending");
}

async function setupPairedOperatorDevice(baseDir: string, scopes: string[]) {
  const request = await requestDevicePairing(
    {
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator",
      scopes,
    },
    baseDir,
  );
  await approveDevicePairing(request.request.requestId, { callerScopes: scopes }, baseDir);
}

describe("device pairing bootstrap", () => {
  beforeAll(async () => {
    suiteBaseDir = await suiteRootTracker.setup();
  });

  beforeEach(() => {
    persistDevicePairingStoreState({ pendingById: {}, pairedByDeviceId: {} }, suiteBaseDir, "both");
  });

  afterAll(async () => {
    await closeStateDatabaseForTest();
    await suiteRootTracker.cleanup();
  });

  test("bootstrap pairing seeds only the requested node token by default", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "bootstrap-device-1",
        publicKey: "bootstrap-public-key-1",
        role: "node",
        roles: ["node"],
        scopes: [],
        silent: true,
      },
      baseDir,
    );

    const approved = await approveBootstrapDevicePairing(
      request.request.requestId,
      PAIRING_SETUP_BOOTSTRAP_PROFILE,
      baseDir,
    );
    expectRecordFields(approved, "approved result", { status: "approved" });

    const paired = await getPairedDevice("bootstrap-device-1", baseDir);
    expect(paired?.roles).toEqual(["node"]);
    expect(paired?.approvedScopes).toStrictEqual([]);
    expect(paired?.tokens?.node?.scopes).toStrictEqual([]);
    expect(paired?.tokens?.operator).toBeUndefined();
  });

  test("bootstrap pairing treats missing persisted scopes as an empty grant", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "bootstrap-device-missing-scopes",
        publicKey: "bootstrap-public-key-missing-scopes",
        role: "operator",
        roles: ["operator"],
        scopes: [],
        silent: true,
      },
      baseDir,
    );
    mutatePendingRequest(baseDir, request.request.requestId, (pending) => {
      delete pending.scopes;
    });

    const approved = await approveBootstrapDevicePairing(
      request.request.requestId,
      PAIRING_SETUP_BOOTSTRAP_PROFILE,
      baseDir,
    );
    expectRecordFields(approved, "approved result", { status: "approved" });

    const paired = await getPairedDevice("bootstrap-device-missing-scopes", baseDir);
    expect(paired?.approvedScopes).toStrictEqual([]);
    expect(paired?.tokens?.operator?.scopes).toStrictEqual([]);
  });

  test("bootstrap approval access metadata initializes paired device last-seen fields", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "bootstrap-device-seen",
        publicKey: "bootstrap-public-key-seen",
        role: "node",
        roles: ["node"],
        scopes: [],
        silent: true,
        remoteIp: "127.0.0.1",
      },
      baseDir,
    );
    const firstSeenAtMs = Date.now();

    const approved = await approveBootstrapDevicePairing(
      request.request.requestId,
      PAIRING_SETUP_BOOTSTRAP_PROFILE,
      {
        accessMetadata: {
          remoteIp: "10.0.0.2",
          lastSeenAtMs: firstSeenAtMs,
          lastSeenReason: "connect",
        },
      },
      baseDir,
    );
    expectRecordFields(approved, "approved result", { status: "approved" });

    const paired = await getPairedDevice("bootstrap-device-seen", baseDir);
    expectRecordFields(paired, "paired device", {
      remoteIp: "10.0.0.2",
      lastSeenAtMs: firstSeenAtMs,
      lastSeenReason: "connect",
    });
  });

  test("baseline bootstrap pairing issues full operator token when requested by QR handoff", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "bootstrap-device-operator-default",
        publicKey: "bootstrap-public-key-operator-default",
        role: "node",
        roles: ["node", "operator"],
        scopes: [
          "operator.admin",
          "operator.approvals",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
        silent: true,
      },
      baseDir,
    );

    const approved = await approveBootstrapDevicePairing(
      request.request.requestId,
      FULL_ACCESS_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      baseDir,
    );
    expectRecordFields(approved, "approved result", { status: "approved" });

    const paired = await getPairedDevice("bootstrap-device-operator-default", baseDir);
    const operatorToken = requireToken(paired?.tokens?.operator?.token);
    expect(paired?.tokens?.node?.scopes).toStrictEqual([]);
    expect(paired?.tokens?.operator?.scopes).toStrictEqual([
      "operator.admin",
      "operator.approvals",
      "operator.read",
      "operator.talk.secrets",
      "operator.write",
    ]);
    await expect(
      verifyDeviceToken({
        deviceId: "bootstrap-device-operator-default",
        token: operatorToken,
        role: "operator",
        scopes: [
          "operator.admin",
          "operator.approvals",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      verifyDeviceToken({
        deviceId: "bootstrap-device-operator-default",
        token: operatorToken,
        role: "operator",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      verifyDeviceToken({
        deviceId: "bootstrap-device-operator-default",
        token: operatorToken,
        role: "operator",
        scopes: ["operator.pairing"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
  });

  test("bootstrap node approval preserves existing operator token scopes", async () => {
    const baseDir = await makeDevicePairingDir();
    await setupPairedOperatorDevice(baseDir, ["operator.admin"]);
    const before = await getPairedDevice("device-1", baseDir);
    const operatorToken = requireToken(before?.tokens?.operator?.token);

    const request = await requestDevicePairing(
      {
        deviceId: "device-1",
        publicKey: "public-key-1",
        role: "node",
        roles: ["node"],
        scopes: [],
        silent: true,
      },
      baseDir,
    );

    const approved = await approveBootstrapDevicePairing(
      request.request.requestId,
      PAIRING_SETUP_BOOTSTRAP_PROFILE,
      baseDir,
    );
    expectRecordFields(approved, "approved result", { status: "approved" });

    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.approvedScopes).toEqual(["operator.admin"]);
    expect(paired?.tokens?.operator?.token).toBe(operatorToken);
    expect(paired?.tokens?.node?.scopes).toStrictEqual([]);
    await expect(
      verifyDeviceToken({
        deviceId: "device-1",
        token: operatorToken,
        role: "operator",
        scopes: ["operator.read"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
  });

  test("bootstrap pairing keeps operator token scopes operator-only", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "bootstrap-device-operator-scope",
        publicKey: "bootstrap-public-key-operator-scope",
        role: "node",
        roles: ["node", "operator"],
        scopes: ["node.exec", "operator.read", "operator.write"],
        silent: true,
      },
      baseDir,
    );

    const approved = await approveBootstrapDevicePairing(
      request.request.requestId,
      {
        roles: ["node", "operator"],
        scopes: ["node.exec", "operator.pairing", "operator.read", "operator.write"],
      },
      baseDir,
    );
    expectRecordFields(approved, "approved result", { status: "approved" });

    const paired = await getPairedDevice("bootstrap-device-operator-scope", baseDir);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read", "operator.write"]);
    expect(paired?.tokens?.node?.scopes).toStrictEqual([]);
  });

  test("bootstrap pairing bounds approved baseline to handoff scopes", async () => {
    const baseDir = await makeDevicePairingDir();
    const request = await requestDevicePairing(
      {
        deviceId: "bootstrap-device-bounded-baseline",
        publicKey: "bootstrap-public-key-bounded-baseline",
        role: "node",
        roles: ["node", "operator"],
        scopes: ["node.exec", "operator.approvals", "operator.read", "operator.write"],
        silent: true,
      },
      baseDir,
    );

    const approved = await approveBootstrapDevicePairing(
      request.request.requestId,
      {
        roles: ["node", "operator"],
        scopes: [
          "node.exec",
          "operator.admin",
          "operator.approvals",
          "operator.pairing",
          "operator.read",
          "operator.talk.secrets",
          "operator.write",
        ],
      },
      baseDir,
    );
    expectRecordFields(approved, "approved result", { status: "approved" });

    const paired = await getPairedDevice("bootstrap-device-bounded-baseline", baseDir);
    expect(paired?.approvedScopes).toEqual([
      "operator.approvals",
      "operator.read",
      "operator.write",
    ]);
    expect(paired?.tokens?.operator?.scopes).toEqual([
      "operator.approvals",
      "operator.read",
      "operator.write",
    ]);
    expect(paired?.tokens?.node?.scopes).toStrictEqual([]);
    await expect(
      ensureDeviceToken({
        deviceId: "bootstrap-device-bounded-baseline",
        role: "operator",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toBeNull();
  });

  test("bootstrap pairing sanitizes merged legacy baseline scopes", async () => {
    const baseDir = await makeDevicePairingDir();
    const bootstrapProfile = {
      roles: ["node", "operator"],
      scopes: ["operator.approvals", "operator.read", "operator.write"],
    };
    const first = await requestDevicePairing(
      {
        deviceId: "bootstrap-device-legacy-baseline",
        publicKey: "bootstrap-public-key-legacy-baseline",
        role: "node",
        roles: ["node", "operator"],
        scopes: bootstrapProfile.scopes,
        silent: true,
      },
      baseDir,
    );

    await approveBootstrapDevicePairing(first.request.requestId, bootstrapProfile, baseDir);
    await mutatePairedDevice(baseDir, "bootstrap-device-legacy-baseline", (device) => {
      device.approvedScopes = ["operator.admin"];
      device.scopes = ["operator.admin"];
    });

    const repair = await requestDevicePairing(
      {
        deviceId: "bootstrap-device-legacy-baseline",
        publicKey: "bootstrap-public-key-legacy-baseline-rotated",
        role: "node",
        roles: ["node", "operator"],
        scopes: bootstrapProfile.scopes,
        silent: true,
      },
      baseDir,
    );
    const approved = await approveBootstrapDevicePairing(
      repair.request.requestId,
      bootstrapProfile,
      baseDir,
    );
    expectRecordFields(approved, "approved result", { status: "approved" });

    const paired = await getPairedDevice("bootstrap-device-legacy-baseline", baseDir);
    expect(paired?.approvedScopes).toEqual(bootstrapProfile.scopes);
    await expect(
      ensureDeviceToken({
        deviceId: "bootstrap-device-legacy-baseline",
        role: "operator",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toBeNull();
  });
});
