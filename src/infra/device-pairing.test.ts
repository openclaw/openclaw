import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../shared/device-bootstrap-profile.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { loadOriginDeviceToken } from "./device-auth-store.js";
import {
  readDeviceAuthTokenForTest as readCachedToken,
  seedDeviceAuthToken,
  seedOriginDeviceToken,
} from "./device-auth-store.test-support.js";
import { issueDeviceBootstrapToken, verifyDeviceBootstrapToken } from "./device-bootstrap.js";
import { approveBootstrapDevicePairing, approveDevicePairing } from "./device-pairing-approval.js";
import { updatePairedNodeBins, updatePairedNodeSessionHost } from "./device-pairing-node-facts.js";
import { approveNodePairing, requestNodePairing } from "./device-pairing-node.js";
import {
  loadDevicePairingStoreState,
  persistDeviceBootstrapTokenRecords,
  persistDevicePairingStoreState,
} from "./device-pairing-store.js";
import {
  ensureDeviceToken,
  revokeDeviceToken,
  rotateDeviceToken,
  verifyDeviceToken,
} from "./device-pairing-tokens.js";
import {
  getPairedDevice,
  hasPairedCardRenderer,
  hasEffectivePairedDeviceRole,
  listEffectivePairedDeviceRoles,
  listDevicePairing,
  removePairedDevice,
  requestDevicePairing,
  resolveNodePairingGeneration,
  updatePairedDeviceMetadata,
  updatePairedDevicePresence,
  withPairedDeviceRecords,
  type PairedDevice,
} from "./device-pairing.js";
import { loadApnsRegistration, registerApnsRegistration } from "./push-apns.js";

const requireRecord = createRequireRecord("record", "message");

function requestPairing(
  request: Partial<Parameters<typeof requestDevicePairing>[0]>,
  stateDir = baseDir,
) {
  return requestDevicePairing(
    { deviceId: "device-1", publicKey: "public-key-1", ...request },
    stateDir,
  );
}

function requestBootstrap(patch: Partial<Parameters<typeof requestDevicePairing>[0]> = {}) {
  return requestPairing(
    { role: "node", roles: ["node"], scopes: [], silent: true, ...patch },
    baseDir,
  );
}

type RotateDeviceTokenResult = Awaited<ReturnType<typeof rotateDeviceToken>>;

function requestOperator(scopes: string[]) {
  return requestPairing({ role: "operator", scopes }, baseDir);
}

const nodeIdentity = { deviceId: "node-1", publicKey: "public-key-node-1", role: "node" };
const browserIdentity = {
  deviceId: "browser-device-1",
  publicKey: "public-key-browser-1",
  clientId: "openclaw-control-ui",
  clientMode: "webchat",
};

async function pairDevice(
  scopes: string[],
  identity: Partial<Parameters<typeof requestDevicePairing>[0]> = {},
) {
  const { request } = await requestPairing({ role: "operator", scopes, ...identity }, baseDir);
  await approveDevicePairing(request.requestId, { callerScopes: scopes }, baseDir);
}

async function pairNodeSurface(commands: string[]) {
  await pairDevice([], nodeIdentity);
  const pending = await requestNodePairing(
    { nodeId: "node-1", platform: "darwin", commands },
    baseDir,
  );
  await approveNodePairing(
    pending.request.requestId,
    { callerScopes: ["operator.pairing", "operator.admin"] },
    baseDir,
  );
  return requireValue(
    resolveNodePairingGeneration(await getPairedDevice("node-1", baseDir)),
    "expected node generation",
  );
}

async function setupOperatorToken(scopes: string[]) {
  await pairDevice(scopes);
  const paired = await getPairedDevice("device-1", baseDir);
  return requireToken(paired?.tokens?.operator?.token);
}

function verifyOperatorToken(token: string, scopes: string[]) {
  return verifyDeviceToken({ deviceId: "device-1", role: "operator", token, scopes, baseDir });
}

function requireToken(token: string | undefined): string {
  expect(token).toBeTypeOf("string");
  return requireValue(token, "expected device token");
}

function requireValue<T>(value: T | null | undefined, message: string): T {
  if (value == null) {
    throw new Error(message);
  }
  return value;
}

function requireRotatedEntry(result: RotateDeviceTokenResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(`expected rotated token entry, got ${result.reason}`);
  }
  return result.entry;
}

async function setOperatorScopes(baseDir: string, scopes: string[]) {
  await mutatePairedDevice(baseDir, "device-1", (device) => {
    const operatorToken = requireValue(device.tokens?.operator, "expected paired operator token");
    operatorToken.scopes = scopes;
  });
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

// Tampers with a persisted pending request through the store layer; the domain
// module has no API for rewriting pending timestamps.
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

const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-device-pairing-" });
let baseDir = "";

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

describe("device pairing tokens", () => {
  beforeAll(async () => {
    baseDir = await suiteRootTracker.setup();
  });

  beforeEach(() => {
    persistDevicePairingStoreState({ pendingById: {}, pairedByDeviceId: {} }, baseDir, "both");
    persistDeviceBootstrapTokenRecords({}, baseDir);
  });

  afterAll(async () => {
    await closeStateDatabaseForTest();
    await suiteRootTracker.cleanup();
  });

  test("re-requests keep one pending request alive past the pending TTL without churning requestIds", async () => {
    // Keepalive extends the TTL without changing approval ordering or request identity.
    const req = {
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator" as const,
      scopes: ["operator.read"],
    };
    const first = await requestDevicePairing(req, baseDir);
    expect(first.created).toBe(true);
    const refreshed = await requestDevicePairing(req, baseDir);
    expect(refreshed.created).toBe(false);

    // Simulate hours of aging since creation while retries kept the keepalive fresh.
    const createdTs = Date.now() - 60 * 60 * 1000;
    mutatePendingRequest(baseDir, first.request.requestId, (pending) => {
      expect(pending.refreshedAtMs).toBeGreaterThanOrEqual(pending.ts);
      pending.ts = createdTs;
    });

    const third = await requestDevicePairing(req, baseDir);
    expect(third.created).toBe(false);
    expect(third.request.requestId).toBe(first.request.requestId);
    expect(third.request.ts).toBe(createdTs);
    // The keepalive is store-internal; it must not leak into protocol payloads.
    expect("refreshedAtMs" in third.request).toBe(false);

    mutatePendingRequest(baseDir, first.request.requestId, (pending) => {
      pending.refreshedAtMs = createdTs;
    });
    expect((await listDevicePairing(baseDir)).pending).toHaveLength(0);
  });

  test("supersedes pending requests when requested roles/scopes change", async () => {
    const first = await requestPairing({ role: "node", scopes: [], silent: false });
    const second = await requestPairing({
      role: "operator",
      scopes: ["operator.read", "operator.write"],
      silent: true,
    });

    expect(second.created).toBe(true);
    expect(second.request.requestId).not.toBe(first.request.requestId);
    expect(second.superseded).toEqual([
      { requestId: first.request.requestId, deviceId: "device-1" },
    ]);
    expect(second.request.role).toBe("operator");
    expect(second.request.silent).toBe(false);
    expect(second.request.roles).toEqual(expect.arrayContaining(["node", "operator"]));
    expect(second.request.scopes).toEqual(
      expect.arrayContaining(["operator.read", "operator.write"]),
    );

    const list = await listDevicePairing(baseDir);
    expect(list.pending).toHaveLength(1);
    expect(list.pending[0]?.requestId).toBe(second.request.requestId);

    await approveDevicePairing(
      second.request.requestId,
      { callerScopes: ["operator.read", "operator.write"] },
      baseDir,
    );
    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.roles).toEqual(expect.arrayContaining(["node", "operator"]));
    expect(paired?.scopes).toEqual(expect.arrayContaining(["operator.read", "operator.write"]));
  });

  test("does not widen a down-scoped operator token when approving a scope upgrade", async () => {
    await pairDevice(["operator.read", "operator.write"]);
    await setOperatorScopes(baseDir, ["operator.read"]);
    const upgrade = await requestOperator(["operator.talk.secrets"]);

    const approved = await approveDevicePairing(
      upgrade.request.requestId,
      { callerScopes: ["operator.read", "operator.talk.secrets", "operator.write"] },
      baseDir,
    );
    expect(requireRecord(approved, "approved result")).toMatchObject({ status: "approved" });

    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.approvedScopes).toEqual([
      "operator.read",
      "operator.write",
      "operator.talk.secrets",
    ]);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read", "operator.talk.secrets"]);
    expect(paired?.tokens?.operator?.scopes).not.toContain("operator.write");
  });

  test("rejects operator scopes requested only for a node role", async () => {
    const { request } = await requestPairing({ roles: ["node"], scopes: ["operator.read"] });
    await expect(
      approveDevicePairing(request.requestId, { callerScopes: ["operator.read"] }, baseDir),
    ).resolves.toEqual({
      status: "forbidden",
      reason: "scope-outside-requested-roles",
      scope: "operator.read",
    });
    await expect(getPairedDevice("device-1", baseDir)).resolves.toBeNull();
  });

  test("preserves existing non-operator scopes during operator-only mixed-role repairs", async () => {
    const initial = await requestPairing({ role: "node", scopes: ["node.exec"] });
    const approvedInitial = await approveDevicePairing(initial.request.requestId, baseDir);
    expect(approvedInitial).toMatchObject({
      status: "approved",
      requestId: initial.request.requestId,
    });

    const repair = await requestPairing({ roles: ["node", "operator"], scopes: ["operator.read"] });
    const approvedRepair = await approveDevicePairing(
      repair.request.requestId,
      { callerScopes: ["operator.read"] },
      baseDir,
    );
    expect(approvedRepair).toMatchObject({
      status: "approved",
      requestId: repair.request.requestId,
    });

    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.tokens?.node?.scopes).toEqual(["node.exec"]);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    await expect(
      verifyDeviceToken({
        deviceId: "device-1",
        token: requireToken(paired?.tokens?.node?.token),
        role: "node",
        scopes: ["node.exec"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
  });

  test("rejects bootstrap token replay before pending scope escalation can be approved", async () => {
    const issued = await issueDeviceBootstrapToken({
      baseDir,
      roles: ["operator"],
      scopes: ["operator.approvals", "operator.read", "operator.write"],
    });

    const params = {
      token: issued.token,
      deviceId: "device-1",
      publicKey: "public-key-1",
      role: "operator",
      baseDir,
    };
    await expect(
      verifyDeviceBootstrapToken({
        ...params,
        scopes: ["operator.read"],
      }),
    ).resolves.toEqual({ ok: true });

    const first = await requestOperator(["operator.read"]);

    await expect(
      verifyDeviceBootstrapToken({
        ...params,
        scopes: ["operator.write", "operator.approvals"],
      }),
    ).resolves.toEqual({ ok: false, reason: "bootstrap_token_invalid" });

    const pending = await listDevicePairing(baseDir);
    expect(pending.pending).toHaveLength(1);
    expect(pending.pending[0]?.scopes).toEqual(["operator.read"]);

    await approveDevicePairing(
      first.request.requestId,
      { callerScopes: ["operator.read"] },
      baseDir,
    );
    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.scopes).toEqual(["operator.read"]);
    expect(paired?.approvedScopes).toEqual(["operator.read"]);
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
  });

  test("fails closed for operator approvals when caller scopes are omitted", async () => {
    const { request } = await requestOperator(["operator.admin"]);

    await expect(approveDevicePairing(request.requestId, baseDir)).resolves.toEqual({
      status: "forbidden",
      reason: "caller-scopes-required",
      scope: "operator.admin",
    });

    const approved = await approveDevicePairing(
      request.requestId,
      { callerScopes: ["operator.admin"] },
      baseDir,
    );
    expect(approved).toMatchObject({ status: "approved", requestId: request.requestId });
  });

  test("metadata refresh can update display metadata but not approved role and scope fields", async () => {
    await pairDevice([], nodeIdentity);
    const before = await getPairedDevice("node-1", baseDir);

    await updatePairedDeviceMetadata(
      "node-1",
      {
        displayName: "renamed-node",
        operatorLabel: "Kitchen Mac",
        platform: "iOS 26.5.0",
        lastSeenAtMs: 4321,
        lastSeenReason: "bg_app_refresh",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.admin"],
        approvedScopes: ["operator.admin"],
        tokens: {},
        publicKey: "attacker-key",
      } as unknown as Parameters<typeof updatePairedDeviceMetadata>[1],
      baseDir,
    );

    expect(await getPairedDevice("node-1", baseDir)).toEqual({
      ...before,
      displayName: "renamed-node",
      operatorLabel: "Kitchen Mac",
      platform: "iOS 26.5.0",
      lastSeenAtMs: 4321,
      lastSeenReason: "bg_app_refresh",
    });
  });

  test("stale node presence cannot update a replacement pairing generation", async () => {
    const original = await pairNodeSurface(["system.run"]);
    await expect(updatePairedNodeBins("node-1", ["retired-bin"], original, baseDir)).resolves.toBe(
      true,
    );
    await expect(
      updatePairedNodeSessionHost({
        nodeId: "node-1",
        sessionHost: true,
        expectedPairingGeneration: original,
        isConnectionCurrent: () => true,
        baseDir,
      }),
    ).resolves.toBe(true);

    const rotated = await rotateDeviceToken({
      deviceId: "node-1",
      role: "node",
      scopes: [],
      baseDir,
    });
    expect(rotated.ok).toBe(true);
    const replacement = resolveNodePairingGeneration(await getPairedDevice("node-1", baseDir));
    expect(replacement?.key).not.toBe(original.key);

    await expect(
      updatePairedDevicePresence(
        "node-1",
        { lastSeenAtMs: 4321, lastSeenReason: "bg_app_refresh" },
        original,
        baseDir,
      ),
    ).resolves.toBe(false);
    const paired = await getPairedDevice("node-1", baseDir);
    expect(paired?.nodeSurface?.bins).toBeUndefined();
    expect(paired?.nodeSurface?.sessionHost).toBeUndefined();
    expect(paired?.lastSeenAtMs).toBeUndefined();
    expect(paired?.lastSeenReason).toBeUndefined();
  });

  test("repair approvals preserve owner labels and last-seen metadata", async () => {
    await pairDevice([], nodeIdentity);
    await updatePairedDeviceMetadata(
      "node-1",
      { operatorLabel: "Kitchen Mac", lastSeenAtMs: 1234, lastSeenReason: "bg_app_refresh" },
      baseDir,
    );

    const repair = await requestPairing({
      ...nodeIdentity,
      scopes: [],
      displayName: "fresh-client-name",
    });
    await approveDevicePairing(repair.request.requestId, { callerScopes: [] }, baseDir);

    const paired = await getPairedDevice("node-1", baseDir);
    expect(paired).toMatchObject({
      operatorLabel: "Kitchen Mac",
      lastSeenAtMs: 1234,
      lastSeenReason: "bg_app_refresh",
      displayName: "fresh-client-name",
    });
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
    const refreshed = seedDeviceAuthToken({
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

  test("rolls back legacy node rotation when matching cache cleanup fails", async () => {
    const { baseDir: dir, env, before, cached } = await legacyNodeRecovery();
    const { db } = openOpenClawStateDatabase({ env });
    db.exec(`
      CREATE TRIGGER reject_node_cache_cleanup BEFORE DELETE ON device_auth_tokens
      WHEN OLD.device_id = 'device-1' AND OLD.role = 'node'
      BEGIN SELECT RAISE(ABORT, 'node cache cleanup refused'); END;
    `);
    try {
      await expect(
        rotateDeviceToken({ deviceId: "device-1", role: "node", scopes: [], baseDir: dir }),
      ).rejects.toThrow("node cache cleanup refused");
      expect(await getPairedDevice("device-1", dir)).toEqual(before);
      expect(readCachedToken({ deviceId: "device-1", role: "node", env })).toEqual(cached);
    } finally {
      db.exec("DROP TRIGGER reject_node_cache_cleanup");
    }

    requireRotatedEntry(
      await rotateDeviceToken({ deviceId: "device-1", role: "node", scopes: [], baseDir: dir }),
    );
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

  test("requires authority for inherited scopes before approving a scopeless repair", async () => {
    await pairDevice(["operator.admin"]);
    const before = await getPairedDevice("device-1", baseDir);

    const repair = await requestPairing({ role: "operator" });

    await expect(
      approveDevicePairing(
        repair.request.requestId,
        { callerScopes: ["operator.pairing"] },
        baseDir,
      ),
    ).resolves.toEqual({
      status: "forbidden",
      reason: "caller-missing-scope",
      scope: "operator.admin",
    });

    const after = await getPairedDevice("device-1", baseDir);
    expect(after?.tokens?.operator?.token).toEqual(before?.tokens?.operator?.token);
    expect(after?.tokens?.operator?.scopes).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
    ]);
    await expect(
      approveDevicePairing(repair.request.requestId, { callerScopes: ["operator.admin"] }, baseDir),
    ).resolves.toMatchObject({ status: "approved" });
    const approved = await getPairedDevice("device-1", baseDir);
    expect(approved?.scopes).toEqual(["operator.admin"]);
    expect(approved?.approvedScopes).toEqual(["operator.admin"]);
    expect(approved?.tokens?.operator?.scopes).toEqual([
      "operator.admin",
      "operator.read",
      "operator.write",
    ]);
  });

  test.each([
    {
      name: "scope escalation",
      scopes: ["operator.read"],
      request: { role: "operator", scopes: ["operator.admin"] },
      expected: { ok: false, reason: "scope-outside-approved-baseline" },
    },
    {
      name: "caller scope ceiling",
      scopes: ["operator.admin"],
      request: { role: "operator", callerScopes: ["operator.pairing"] },
      expected: { ok: false, reason: "caller-missing-scope", scope: "operator.admin" },
    },
    {
      name: "unapproved role",
      scopes: ["operator.pairing"],
      request: { role: "node" },
      expected: { ok: false, reason: "unknown-device-or-role" },
    },
  ])(
    "rejects rotation for $name without changing the paired device",
    async ({ scopes, request, expected }) => {
      await pairDevice(scopes);
      const before = await getPairedDevice("device-1", baseDir);
      await expect(
        rotateDeviceToken({ deviceId: "device-1", ...request, baseDir }),
      ).resolves.toEqual(expected);
      expect(await getPairedDevice("device-1", baseDir)).toEqual(before);
    },
  );

  test("revokes effective roles only when the caller holds the token scopes", async () => {
    await pairDevice(["operator.admin"]);
    const before = await getPairedDevice("device-1", baseDir);
    expect(before && listEffectivePairedDeviceRoles(before)).toEqual(["operator"]);
    expect(before && hasEffectivePairedDeviceRole(before, "operator")).toBe(true);

    const revoked = await revokeDeviceToken({
      deviceId: "device-1",
      role: "operator",
      callerScopes: ["operator.pairing"],
      baseDir,
    });
    expect(revoked).toEqual({ ok: false, reason: "caller-missing-scope", scope: "operator.admin" });

    const after = await getPairedDevice("device-1", baseDir);
    expect(after?.tokens?.operator?.token).toEqual(before?.tokens?.operator?.token);
    expect(after?.tokens?.operator?.revokedAtMs).toBeUndefined();
    const allowed = await revokeDeviceToken({
      deviceId: "device-1",
      role: "operator",
      callerScopes: ["operator.admin"],
      baseDir,
    });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) {
      throw new Error(allowed.reason);
    }
    expect(allowed.entry.role).toBe("operator");
    expect(allowed.entry.revokedAtMs).toBeTypeOf("number");
    const paired = requireValue(
      await getPairedDevice("device-1", baseDir),
      "expected revoked device",
    );
    expect(paired.tokens?.operator?.revokedAtMs).toBeTypeOf("number");
    expect(paired.roles).toContain("operator");
    expect(listEffectivePairedDeviceRoles(paired)).toEqual([]);
    expect(hasEffectivePairedDeviceRole(paired, "operator")).toBe(false);
  });

  test("binds shared-auth browser tokens to their issuing generation through upgrades and rotation", async () => {
    await pairDevice(["operator.read"], browserIdentity);
    const params = { deviceId: "browser-device-1", role: "operator", baseDir };
    const verify = (token: string, generation: string, scopes = ["operator.read"]) =>
      verifyDeviceToken({
        ...params,
        token,
        scopes,
        requiredSharedGatewaySessionGeneration: generation,
      });
    const legacy = await getPairedDevice(params.deviceId, baseDir);
    const legacyToken = requireToken(legacy?.tokens?.operator?.token);
    await expect(verify(legacyToken, "old-generation")).resolves.toEqual({
      ok: false,
      reason: "legacy-browser-token",
    });

    const oldIssuer = { kind: "shared-gateway-auth", generation: "old-generation" } as const;
    const oldIssued = await ensureDeviceToken({
      ...params,
      scopes: ["operator.read"],
      issuer: oldIssuer,
    });
    const oldToken = requireToken(oldIssued?.token);
    expect(oldToken).not.toBe(legacyToken);
    expect(oldIssued?.issuer).toEqual(oldIssuer);
    await expect(verify(oldToken, "old-generation")).resolves.toEqual({
      ok: true,
      issuer: oldIssuer,
    });
    await expect(verify(oldToken, "new-generation")).resolves.toEqual({
      ok: false,
      reason: "issuer-generation-stale",
    });

    const issuer = { kind: "shared-gateway-auth", generation: "new-generation" } as const;
    const newIssued = await ensureDeviceToken({ ...params, scopes: ["operator.read"], issuer });
    const newToken = requireToken(newIssued?.token);
    expect(newToken).not.toBe(oldToken);
    expect(newIssued?.issuer).toEqual(issuer);
    await expect(verify(newToken, "new-generation")).resolves.toEqual({ ok: true, issuer });

    const upgrade = await requestPairing({
      ...browserIdentity,
      role: "operator",
      scopes: ["operator.admin"],
    });
    await expect(
      approveDevicePairing(
        upgrade.request.requestId,
        { callerScopes: ["operator.admin"] },
        baseDir,
      ),
    ).resolves.toMatchObject({ status: "approved" });
    const upgraded = await getPairedDevice(params.deviceId, baseDir);
    const upgradedToken = requireToken(upgraded?.tokens?.operator?.token);
    await expect(verify(upgradedToken, "new-generation", ["operator.admin"])).resolves.toEqual({
      ok: true,
      issuer,
    });
    await expect(verify(upgradedToken, "later-generation", ["operator.admin"])).resolves.toEqual({
      ok: false,
      reason: "issuer-generation-stale",
    });

    const rotated = requireRotatedEntry(
      await rotateDeviceToken({ ...params, scopes: ["operator.read"] }),
    );
    expect(rotated.scopes).toEqual(["operator.read"]);
    expect(rotated.issuer).toEqual(issuer);
    expect((await getPairedDevice(params.deviceId, baseDir))?.approvedScopes).toEqual([
      "operator.read",
      "operator.admin",
    ]);
    await expect(verify(rotated.token, "new-generation")).resolves.toEqual({ ok: true, issuer });
  });

  test("keeps ambiguous legacy device tokens valid across shared gateway auth rotation", async () => {
    const token = await setupOperatorToken(["operator.read"]);
    const params = { deviceId: "device-1", role: "operator", scopes: ["operator.read"], baseDir };
    const verify = (bearer: string) =>
      verifyDeviceToken({
        ...params,
        token: bearer,
        requiredSharedGatewaySessionGeneration: "new-generation",
      });
    await expect(verify(token)).resolves.toEqual({ ok: true });
    const issuer = { kind: "shared-gateway-auth", generation: "new-generation" } as const;
    const issued = await ensureDeviceToken({ ...params, issuer });
    expect(issued?.token).not.toBe(token);
    expect(issued?.issuer).toEqual(issuer);
    await expect(verify(requireToken(issued?.token))).resolves.toEqual({ ok: true, issuer });
    const unbound = await ensureDeviceToken(params);
    expect(unbound?.token).not.toBe(issued?.token);
    expect(unbound?.issuer).toBeUndefined();
    await expect(verify(requireToken(unbound?.token))).resolves.toEqual({ ok: true });
  });

  test("normalizes legacy node token scopes back to [] on re-approval", async () => {
    await pairDevice([], nodeIdentity);
    await mutatePairedDevice(baseDir, "node-1", (device) => {
      const nodeToken = requireValue(device.tokens?.node, "expected paired node token");
      nodeToken.scopes = ["operator.read"];
    });

    const repair = await requestPairing(nodeIdentity);
    await approveDevicePairing(repair.request.requestId, { callerScopes: [] }, baseDir);

    const paired = await getPairedDevice("node-1", baseDir);
    expect(paired?.scopes).toStrictEqual([]);
    expect(paired?.approvedScopes).toStrictEqual([]);
    expect(paired?.tokens?.node?.scopes).toStrictEqual([]);
  });

  test("bootstrap pairing treats missing persisted scopes as an empty grant", async () => {
    const { request } = await requestBootstrap({ role: "operator", roles: ["operator"] });
    mutatePendingRequest(baseDir, request.requestId, (pending) => {
      delete pending.scopes;
    });

    const approved = await approveBootstrapDevicePairing(
      request.requestId,
      PAIRING_SETUP_BOOTSTRAP_PROFILE,
      baseDir,
    );
    expect(approved).toMatchObject({ status: "approved" });

    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.approvedScopes).toStrictEqual([]);
    expect(paired?.tokens?.operator?.scopes).toStrictEqual([]);
  });

  test("bootstrap approval access metadata initializes paired device last-seen fields", async () => {
    const { request } = await requestBootstrap({ displayName: "pending", remoteIp: "127.0.0.1" });
    const firstSeenAtMs = Date.now();

    const approved = await approveBootstrapDevicePairing(
      request.requestId,
      PAIRING_SETUP_BOOTSTRAP_PROFILE,
      {
        accessMetadata: {
          displayName: "connected",
          remoteIp: "10.0.0.2",
          lastSeenAtMs: firstSeenAtMs,
          lastSeenReason: "connect",
        },
      },
      baseDir,
    );
    expect(approved).toMatchObject({ status: "approved" });

    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired).toMatchObject({
      displayName: "connected",
      remoteIp: "10.0.0.2",
      lastSeenAtMs: firstSeenAtMs,
      lastSeenReason: "connect",
    });
  });

  test("bootstrap node approval preserves existing operator token scopes", async () => {
    await pairDevice(["operator.admin"]);
    const before = await getPairedDevice("device-1", baseDir);
    const operatorToken = requireToken(before?.tokens?.operator?.token);

    const { request } = await requestBootstrap();

    const approved = await approveBootstrapDevicePairing(
      request.requestId,
      PAIRING_SETUP_BOOTSTRAP_PROFILE,
      baseDir,
    );
    expect(approved).toMatchObject({ status: "approved" });

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

  test("bootstrap pairing bounds approved baseline to handoff scopes", async () => {
    const { request } = await requestBootstrap({
      roles: ["node", "operator"],
      scopes: ["node.exec", "operator.approvals", "operator.read", "operator.write"],
    });

    const approved = await approveBootstrapDevicePairing(
      request.requestId,
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
    expect(approved).toMatchObject({ status: "approved" });

    const paired = await getPairedDevice("device-1", baseDir);
    const granted = ["operator.approvals", "operator.read", "operator.write"];
    expect(paired?.approvedScopes).toEqual(granted);
    expect(paired?.tokens?.operator?.scopes).toEqual(granted);
    expect(paired?.tokens?.node?.scopes).toStrictEqual([]);
    await expect(
      ensureDeviceToken({
        deviceId: "device-1",
        role: "operator",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toBeNull();
    expect(await getPairedDevice("device-1", baseDir)).toEqual(paired);
  });

  test("bootstrap repair removes stale privileges from a legacy approval baseline", async () => {
    const profile = {
      roles: ["node", "operator"],
      scopes: ["operator.approvals", "operator.read", "operator.write"],
    };
    const first = await requestBootstrap(profile);
    await approveBootstrapDevicePairing(first.request.requestId, profile, baseDir);
    await mutatePairedDevice(baseDir, "device-1", (device) => {
      device.approvedScopes = ["operator.admin"];
      device.scopes = ["operator.admin"];
    });

    const repair = await requestBootstrap({ ...profile, publicKey: "rotated-public-key" });
    await expect(
      approveBootstrapDevicePairing(repair.request.requestId, profile, baseDir),
    ).resolves.toMatchObject({ status: "approved" });

    const paired = await getPairedDevice("device-1", baseDir);
    expect(paired?.approvedScopes).toEqual(profile.scopes);
    await expect(
      ensureDeviceToken({
        deviceId: "device-1",
        role: "operator",
        scopes: ["operator.admin"],
        baseDir,
      }),
    ).resolves.toBeNull();
  });

  test("rejects persisted tokens whose scopes exceed the approved scope baseline", async () => {
    const token = await setupOperatorToken(["operator.read"]);
    await setOperatorScopes(baseDir, ["operator.admin"]);
    await expect(verifyOperatorToken(token, ["operator.admin"])).resolves.toEqual({
      ok: false,
      reason: "scope-mismatch",
    });
  });

  test.each([
    ["verification", { ok: false, reason: "scope-mismatch" }],
    ["ensure", null],
    ["rotation", { ok: false, reason: "missing-approved-scope-baseline" }],
  ] as const)(
    "fails closed without an approval baseline during %s",
    async (operation, expected) => {
      const token = await setupOperatorToken(["operator.admin"]);
      await mutatePairedDevice(baseDir, "device-1", (device) => {
        delete device.approvedScopes;
        delete device.scopes;
      });
      const params = {
        deviceId: "device-1",
        role: "operator",
        scopes: ["operator.admin"],
        baseDir,
      };
      const result =
        operation === "verification"
          ? await verifyDeviceToken({ ...params, token })
          : operation === "ensure"
            ? await ensureDeviceToken(params)
            : await rotateDeviceToken(params);
      expect(result).toEqual(expected);
    },
  );

  test("treats multibyte same-length token input as mismatch without throwing", async () => {
    const token = await setupOperatorToken(["operator.read"]);
    const multibyteToken = "é".repeat(token.length);
    expect(Buffer.from(multibyteToken).length).not.toBe(Buffer.from(token).length);

    await expect(verifyOperatorToken(multibyteToken, ["operator.read"])).resolves.toEqual({
      ok: false,
      reason: "token-mismatch",
    });
  });

  test("filters active token roles to the approved pairing role set", () => {
    const device = {
      role: "operator",
      roles: ["operator"],
      tokens: {
        node: { token: "forged-node", role: "node", scopes: [], createdAtMs: 1 },
        operator: {
          token: "operator",
          role: "operator",
          scopes: ["operator.read"],
          createdAtMs: 1,
        },
      },
    };

    expect(listEffectivePairedDeviceRoles(device)).toEqual(["operator"]);
    expect(hasEffectivePairedDeviceRole(device, "node")).toBe(false);
  });

  test("does not treat a Linux CLI device as a card renderer", async () => {
    const dir = await suiteRootTracker.make("renderer-case");
    await expect(hasPairedCardRenderer(dir)).resolves.toBe(false);
    const { request } = await requestPairing(
      {
        clientId: "cli",
        platform: "linux",
        role: "operator",
        scopes: [],
      },
      dir,
    );
    await approveDevicePairing(request.requestId, { callerScopes: [] }, dir);

    await expect(hasPairedCardRenderer(dir)).resolves.toBe(false);
  });

  test.each(["owner", "bootstrap"] as const)(
    "clears APNs only when a $approval reapproval changes installation identity",
    async (approval) => {
      await pairNodeSurface(["system.run", "system.which"]);
      await registerApnsRegistration({
        nodeId: "node-1",
        transport: "direct",
        token: "ABCD1234ABCD1234ABCD1234ABCD1234",
        topic: "ai.openclaw.ios",
        environment: "sandbox",
        baseDir,
      });
      const approve = async (requestId: string) =>
        approval === "owner"
          ? await approveDevicePairing(requestId, { callerScopes: [] }, baseDir)
          : await approveBootstrapDevicePairing(
              requestId,
              PAIRING_SETUP_BOOTSTRAP_PROFILE,
              baseDir,
            );

      const sameInstallationRepair = await requestPairing({ ...nodeIdentity, scopes: [] });
      await expect(approve(sameInstallationRepair.request.requestId)).resolves.toMatchObject({
        status: "approved",
        nodePairingGenerationChanged: true,
      });
      expect(
        (await listDevicePairing(baseDir)).pending.map((request) => request.requestId),
      ).not.toContain(sameInstallationRepair.request.requestId);
      await expect(loadApnsRegistration("node-1", baseDir)).resolves.toMatchObject({
        token: "abcd1234abcd1234abcd1234abcd1234",
      });

      const previousGeneration = requireValue(
        resolveNodePairingGeneration(await getPairedDevice("node-1", baseDir)),
        "expected node generation",
      );
      await expect(
        updatePairedNodeBins("node-1", ["retired-bin"], previousGeneration, baseDir),
      ).resolves.toBe(true);
      const replacementRepair = await requestPairing({
        ...nodeIdentity,
        publicKey: "public-key-node-1-replacement",
        scopes: [],
      });
      await expect(approve(replacementRepair.request.requestId)).resolves.toMatchObject({
        status: "approved",
        nodePairingGenerationChanged: true,
      });
      expect(
        (await listDevicePairing(baseDir)).pending.map((request) => request.requestId),
      ).not.toContain(replacementRepair.request.requestId);
      await expect(loadApnsRegistration("node-1", baseDir)).resolves.toBeNull();
      const paired = await getPairedDevice("node-1", baseDir);
      expect(resolveNodePairingGeneration(paired)?.key).not.toBe(previousGeneration.key);
      expect(paired?.nodeSurface?.commands).toEqual(["system.run", "system.which"]);
      expect(paired?.nodeSurface?.bins).toBeUndefined();
    },
  );

  test("removal clears the device, repair, APNs registration, and renderer cache", async () => {
    await pairDevice(["operator.read"]);
    await updatePairedDeviceMetadata(
      "device-1",
      { clientId: "openclaw-control-ui", clientMode: "webchat" },
      baseDir,
    );
    await registerApnsRegistration({
      nodeId: "device-1",
      transport: "direct",
      token: "ABCD1234ABCD1234ABCD1234ABCD1234",
      topic: "ai.openclaw.ios",
      environment: "sandbox",
      baseDir,
    });

    const staleRepair = await requestPairing({
      publicKey: "public-key-1-rotated",
      role: "operator",
      scopes: ["operator.read"],
    });
    const otherPending = await requestPairing({
      deviceId: "device-2",
      publicKey: "public-key-2",
      role: "node",
      scopes: [],
    });

    await expect(hasPairedCardRenderer(baseDir)).resolves.toBe(true);
    await expect(removePairedDevice("device-1", baseDir)).resolves.toEqual({
      deviceId: "device-1",
    });
    await expect(hasPairedCardRenderer(baseDir)).resolves.toBe(false);

    const pending = (await listDevicePairing(baseDir)).pending;
    expect(pending.map((entry) => entry.requestId)).not.toContain(staleRepair.request.requestId);
    expect(pending.map((entry) => entry.requestId)).toContain(otherPending.request.requestId);
    await expect(
      approveDevicePairing(
        staleRepair.request.requestId,
        { callerScopes: ["operator.read"] },
        baseDir,
      ),
    ).resolves.toBeNull();
    await expect(getPairedDevice("device-1", baseDir)).resolves.toBeNull();
    await expect(loadApnsRegistration("device-1", baseDir)).resolves.toBeNull();
    await expect(removePairedDevice("device-1", baseDir)).resolves.toBeNull();
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
