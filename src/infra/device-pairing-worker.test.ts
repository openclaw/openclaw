import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { approveBootstrapDevicePairing, approveDevicePairing } from "./device-pairing-approval.js";
import {
  isPairedDeviceTokenIdentityCurrent,
  resolveAuthenticatedDeviceTokenIdentity,
  resolveNodePairingGeneration,
} from "./device-pairing-identity.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import { updatePairedNodeBins, updatePairedNodeSessionHost } from "./device-pairing-node-facts.js";
import {
  recordPairedNodeConnection,
  recordPairedNodeDisconnection,
  recordPairedNodeHostStats,
} from "./device-pairing-node.js";
import { getPublishedPairedDeviceBinding } from "./device-pairing-publication.js";
import { loadPairedDevicePairingStoreRecordReadOnly } from "./device-pairing-store-readonly.js";
import {
  persistDevicePairingStoreState,
  readDevicePairingStoreStateFromDatabase,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";
import {
  ensureDeviceToken,
  rotateDeviceToken,
  revokeDeviceToken,
  verifyDeviceToken,
} from "./device-pairing-tokens.js";
import {
  getPairedDevice,
  getPendingDevicePairing,
  recordPairedDeviceAccess,
  listDevicePairing,
  listDevicePairingReadOnly,
  requestDevicePairing,
  updatePairedDeviceMetadata,
} from "./device-pairing.js";
import * as queries from "./kysely-sync.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

let baseDir: string;
let database: ReturnType<typeof openOpenClawStateDatabase>;
const readState = () => readDevicePairingStoreStateFromDatabase(database.db);
const paired = () => getPairedDevice("paired-rich", baseDir);
const operator = { deviceId: "paired-rich", role: "operator", scopes: ["operator.read"] };
const verifyOperator = (directory?: string) =>
  verifyDeviceToken({ ...operator, token: "synthetic-operator-token", baseDir: directory });
async function holdWriter() {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const holding = withDevicePairingLock(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  return { holding, release };
}
async function nodeGeneration() {
  const generation = resolveNodePairingGeneration(await paired());
  if (!generation) {
    throw new Error("expected fixture node generation");
  }
  return generation;
}
async function withUnreadableSibling(run: () => Promise<void>) {
  database.db
    .prepare("UPDATE device_pairing_paired SET tokens_json = ? WHERE device_id = ?")
    .run("synthetic-unreadable-json", "paired-minimal");
  try {
    await run();
  } finally {
    await withDevicePairingLock(async () => {});
    database.db
      .prepare("UPDATE device_pairing_paired SET tokens_json = NULL WHERE device_id = ?")
      .run("paired-minimal");
  }
}
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeOpenClawStateDatabaseByPathAsync(database.path);
    cleanup();
  }),
);

beforeAll(() => {
  baseDir = tempDirs.make("pairing-worker-contract-");
  database = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
  });
});

beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", baseDir);
  await withDevicePairingLock(async () => {});
  const now = Date.now();
  const state: DevicePairingStoreState = {
    pendingById: {
      expired: {
        requestId: "expired",
        deviceId: "expired-device",
        publicKey: "synthetic-expired",
        ts: now - 600_000,
      },
      refreshed: {
        requestId: "refreshed",
        deviceId: "refreshed-device",
        publicKey: "synthetic-refreshed",
        roles: [],
        ts: now - 600_000,
        refreshedAtMs: now,
      },
      newest: {
        requestId: "newest",
        deviceId: "paired-rich",
        publicKey: "synthetic-replacement-key",
        role: "operator",
        roles: ["operator"],
        scopes: ["operator.read"],
        silent: true,
        isRepair: true,
        ts: now,
      },
    },
    pairedByDeviceId: {
      "paired-minimal": {
        deviceId: "paired-minimal",
        publicKey: "synthetic-minimal-key",
        createdAtMs: 1,
        approvedAtMs: 2,
      },
      "paired-rich": {
        deviceId: "paired-rich",
        publicKey: "synthetic-original-key",
        displayName: "Synthetic device",
        browserOrigin: "https://fixture.invalid",
        roles: ["operator", "node"],
        scopes: ["operator.read"],
        approvedScopes: ["operator.read"],
        tokens: {
          operator: {
            token: "synthetic-operator-token",
            role: "operator",
            scopes: ["operator.read"],
            createdAtMs: 1,
            lastUsedAtMs: 3,
          },
          node: { token: "synthetic-node-token", role: "node", scopes: [], createdAtMs: 1 },
        },
        nodeSurface: {
          createdAtMs: 1,
          approvedAtMs: 4,
        },
        createdAtMs: 1,
        approvedAtMs: 4,
        lastSeenAtMs: 6,
        lastSeenReason: "fixture",
      },
    },
  };
  persistDevicePairingStoreState(state, baseDir, "both");
});

test("keeps public list, lookup, and pending bytes while executing no host queries", async () => {
  const native = readState();
  const { refreshedAtMs: _refreshedAtMs, ...refreshed } = native.pendingById.refreshed!;
  const goldenList = JSON.stringify({
    pending: [native.pendingById.newest, refreshed],
    paired: [native.pairedByDeviceId["paired-rich"], native.pairedByDeviceId["paired-minimal"]],
  });
  using all = vi.spyOn(queries, "executeSqliteQuerySync");
  using first = vi.spyOn(queries, "executeSqliteQueryTakeFirstSync");
  expect(JSON.stringify(await listDevicePairing(baseDir))).toBe(goldenList);
  expect(JSON.stringify(await listDevicePairingReadOnly(baseDir))).toBe(goldenList);
  expect(JSON.stringify(await getPendingDevicePairing("refreshed", baseDir))).toBe(
    JSON.stringify(refreshed),
  );
  expect(await getPendingDevicePairing("expired", baseDir)).toBeNull();
  for (const missing of ["missing", "toString", "constructor", "__proto__"]) {
    expect(await getPairedDevice(missing, baseDir)).toBeNull();
  }
  using unavailable = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockRejectedValue(new Error("reader busy"));
  expect(JSON.stringify(await getPairedDevice(" paired-rich ", baseDir))).toBe(
    JSON.stringify(native.pairedByDeviceId["paired-rich"]),
  );
  await updatePairedDeviceMetadata("paired-rich", { displayName: "Committed" }, baseDir);
  expect((await paired())?.displayName).toBe("Committed");
  expect(unavailable).not.toHaveBeenCalled();
  expect(all).not.toHaveBeenCalled();
  expect(first).not.toHaveBeenCalled();
});

test("reconnects without replacing paired rows or changing unrelated device fields", async () => {
  // Admit the writer before installing fixture-only mutation guards.
  await ensureDeviceToken(operator);
  database.db.exec(`
    CREATE TRIGGER pairing_reconnect_no_delete BEFORE DELETE ON device_pairing_paired
      BEGIN SELECT RAISE(ABORT, 'reconnect deleted a paired row'); END;
    CREATE TRIGGER pairing_reconnect_no_insert BEFORE INSERT ON device_pairing_paired
      BEGIN SELECT RAISE(ABORT, 'reconnect inserted a paired row'); END;
    CREATE TRIGGER pairing_reconnect_exact_update BEFORE UPDATE ON device_pairing_paired
      WHEN OLD.device_id <> 'paired-rich'
      BEGIN SELECT RAISE(ABORT, 'reconnect updated another device'); END;
  `);
  const before = readState();
  try {
    await expect(
      verifyDeviceToken({
        ...operator,
        deviceId: " paired-rich ",
        token: "synthetic-operator-token",
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
    await withDevicePairingLock(async () => {});
    const verified = await paired();
    expect(verified?.tokens?.operator?.lastUsedAtMs).toBeGreaterThan(3);
    expect(verified?.lastSeenAtMs).toBe(verified?.tokens?.operator?.lastUsedAtMs);
    expect(verified?.lastSeenReason).toBe("device-token-auth");
    const patch = {
      displayName: undefined,
      remoteIp: "192.0.2.2",
      lastSeenAtMs: 1234,
      lastSeenReason: "connect",
    };
    await expect(updatePairedDeviceMetadata("paired-rich", patch, baseDir)).resolves.toBe(true);
    await expect(ensureDeviceToken(operator)).resolves.toEqual(verified?.tokens?.operator);
    Object.assign(before.pairedByDeviceId["paired-rich"]!, patch, { tokens: verified?.tokens });
    expect(readState()).toEqual(before);
  } finally {
    database.db.exec(`
      DROP TRIGGER pairing_reconnect_no_delete;
      DROP TRIGGER pairing_reconnect_no_insert;
      DROP TRIGGER pairing_reconnect_exact_update;
    `);
  }
});

test("reconnect receipts refresh native replacements without decoding unrelated pending rows", async () => {
  await expect(paired()).resolves.toMatchObject({ publicKey: "synthetic-original-key" });
  await listDevicePairing(baseDir);
  const previousBinding = getPublishedPairedDeviceBinding("paired-rich", baseDir);
  expect(previousBinding).not.toBeNull();
  const state = readState();
  state.pairedByDeviceId["paired-rich"]!.publicKey = "synthetic-sibling-key";
  state.pairedByDeviceId["paired-rich"]!.displayName = "Sibling fixture";
  persistDevicePairingStoreState(state, baseDir, "paired");
  // A receipt must not decode unrelated pending requests.
  database.db
    .prepare("UPDATE device_pairing_pending SET roles_json = ? WHERE request_id = ?")
    .run("synthetic-unreadable-json", "refreshed");
  try {
    await expect(
      updatePairedDeviceMetadata("paired-minimal", { displayName: "Reconnected" }, baseDir),
    ).resolves.toBe(true);
    await expect(verifyOperator()).resolves.toEqual({ ok: true });
    const currentBinding = getPublishedPairedDeviceBinding("paired-rich", baseDir);
    expect(currentBinding).not.toBeNull();
    expect(currentBinding?.identity).not.toBe(previousBinding?.identity);
    await expect(ensureDeviceToken(operator)).resolves.toMatchObject({
      token: "synthetic-operator-token",
    });
    expect(getPublishedPairedDeviceBinding("paired-rich", baseDir)).toEqual(currentBinding);
  } finally {
    await withDevicePairingLock(async () => {});
    database.db
      .prepare("UPDATE device_pairing_pending SET roles_json = ? WHERE request_id = ?")
      .run("[]", "refreshed");
  }
  expect((await getPendingDevicePairing("refreshed", baseDir))?.roles).toEqual([]);
  const native = readState().pairedByDeviceId["paired-rich"];
  expect(JSON.stringify((await listDevicePairing(baseDir)).paired[0])).toBe(JSON.stringify(native));
  expect(JSON.stringify(await paired())).toBe(JSON.stringify(native));
});

test("publishes a device metadata update without loading unrelated paired rows", async () => {
  await listDevicePairing(baseDir);
  const originalBinding = getPublishedPairedDeviceBinding("paired-rich", baseDir);
  expect(originalBinding).not.toBeNull();
  const unavailable = vi
    .spyOn(stateReads, "executeExistingOpenClawStateRead")
    .mockRejectedValueOnce(new Error("synthetic unavailable pairing read"));
  try {
    await expect(getPendingDevicePairing("unavailable", baseDir)).rejects.toThrow(
      "synthetic unavailable pairing read",
    );
  } finally {
    unavailable.mockRestore();
  }
  expect(() => getPublishedPairedDeviceBinding("paired-rich", baseDir)).toThrow(
    "Device pairing authority requires a current worker publication",
  );
  await withUnreadableSibling(async () => {
    const patch = { lastSeenAtMs: 1234, lastSeenReason: "connect" };
    await expect(updatePairedDeviceMetadata(" paired-rich ", patch, baseDir)).resolves.toBe(true);
    expect(getPublishedPairedDeviceBinding("paired-rich", baseDir)).toEqual(originalBinding);
    expect(await paired()).toMatchObject(patch);
    expect(getPublishedPairedDeviceBinding("paired-minimal", baseDir)).toBeNull();
  });
});

test("persists token use and node connection facts without reading unrelated devices", async () => {
  await listDevicePairing(baseDir);
  const generation = await nodeGeneration();
  const node = { nodeId: "paired-rich", expectedPairingGeneration: generation, baseDir };
  const originalBinding = getPublishedPairedDeviceBinding("paired-rich", baseDir);
  await withUnreadableSibling(async () => {
    await expect(verifyOperator(baseDir)).resolves.toEqual({ ok: true });
    await withDevicePairingLock(async () => {});
    expect((await paired())?.tokens?.operator?.lastUsedAtMs).toBeGreaterThan(3);
    await expect(
      recordPairedNodeConnection("paired-rich", 100, baseDir, generation),
    ).resolves.toEqual({ recorded: true, firstConnection: true });
    await expect(
      recordPairedNodeDisconnection({
        ...node,
        connectedAtMs: 100,
        disconnectedAtMs: 200,
      }),
    ).resolves.toEqual({ recorded: true });
    await expect(updatePairedNodeBins("paired-rich", ["git"], generation, baseDir)).resolves.toBe(
      true,
    );
    const hostStats = {
      cpuCount: 8,
      memoryTotalBytes: 1024,
      memoryFreeBytes: 512,
      updatedAtMs: 300,
    };
    await expect(recordPairedNodeHostStats({ ...node, hostStats })).resolves.toBe(true);
    await expect(
      updatePairedNodeSessionHost({
        ...node,
        sessionHost: true,
        isConnectionCurrent: () => true,
      }),
    ).resolves.toBe(true);
    expect((await paired())?.nodeSurface).toMatchObject({
      lastConnectedAtMs: 100,
      lastDisconnectedAtMs: 200,
      bins: ["git"],
      sessionHost: true,
      lastHostStats: hostStats,
    });
    expect(getPublishedPairedDeviceBinding("paired-rich", baseDir)).toEqual(originalBinding);
  });
});

test("coalesces reconnect presence without rewriting recent last-seen or replacement approvals", async () => {
  const device = await paired();
  if (!device) {
    throw new Error("expected paired fixture");
  }
  const recordAccess = (patch: Parameters<typeof recordPairedDeviceAccess>[1]) =>
    recordPairedDeviceAccess(device.deviceId, patch, device, baseDir);
  const patch = { lastSeenAtMs: 100_000, lastSeenReason: "connect" };
  await Promise.all(Array.from({ length: 160 }, () => recordAccess(patch)));
  const before = readState();
  expect(before.pairedByDeviceId[device.deviceId]).toMatchObject(patch);
  await recordAccess({ ...patch, lastSeenAtMs: 100_001, lastSeenReason: "device-token-auth" });
  expect(readState()).toEqual(before);
  await recordAccess({ ...patch, displayName: "Changed", lastSeenAtMs: 100_002 });
  expect((await getPairedDevice(device.deviceId, baseDir))?.displayName).toBe("Changed");
  const replacement = readState();
  replacement.pairedByDeviceId[device.deviceId]!.publicKey = "replacement-key";
  persistDevicePairingStoreState(replacement, baseDir, "paired");
  await recordAccess({ platform: "stale-platform" });
  expect(readState()).toEqual(replacement);
});

test.each(["reply lost", "policy revoked", "callback throws"] as const)(
  "retires narrowed bootstrap grants only after native settlement (%s)",
  async (fault) => {
    const seeded = readState();
    const device = seeded.pairedByDeviceId["paired-rich"]!;
    device.scopes = ["operator.admin"];
    device.approvedScopes = ["operator.admin"];
    device.tokens!.operator!.scopes = ["operator.admin"];
    persistDevicePairingStoreState(seeded, baseDir, "both");
    await listDevicePairing(baseDir);
    const before = JSON.stringify(readState());
    const previousBinding = getPublishedPairedDeviceBinding("paired-rich", baseDir);
    const deliveryError = new Error("Synthetic bootstrap result delivery failure");
    const callbackError = new Error("Synthetic bootstrap retirement callback failure");
    let scopesAtRetirement: string[] | undefined;
    const onTokensReplaced = vi.fn((_deviceId: string, _roles: readonly string[]) => {
      scopesAtRetirement = readState().pairedByDeviceId["paired-rich"]?.tokens?.operator?.scopes;
      if (fault === "callback throws") {
        throw callbackError;
      }
    });
    const delivery = probe.command(stateWorker, async (command, executeOptions, scope) => {
      const result = await scope.execute(command, executeOptions);
      if (command.type === "devicePairing.approveBootstrap" && fault === "reply lost") {
        throw deliveryError;
      }
      return result;
    });
    let allowed = true;
    try {
      const approval = approveBootstrapDevicePairing(
        "newest",
        { roles: ["operator"], scopes: ["operator.read"] },
        {
          onTokensReplaced,
          isApprovalCurrent: () => {
            if (fault === "policy revoked") {
              queueMicrotask(() => {
                allowed = false;
              });
            }
            return allowed;
          },
        },
        baseDir,
      );
      if (fault === "policy revoked") {
        await expect(approval).resolves.toEqual({
          status: "forbidden",
          reason: "approval-policy-changed",
        });
        expect(onTokensReplaced).not.toHaveBeenCalled();
        expect(JSON.stringify(readState())).toBe(before);
      } else {
        await expect(approval).rejects.toThrow(
          fault === "reply lost" ? deliveryError.message : callbackError.message,
        );
        const committed = readState().pairedByDeviceId["paired-rich"];
        expect(committed?.approvedScopes).toEqual(["operator.read"]);
        expect(committed?.tokens?.operator?.scopes).toEqual(["operator.read"]);
        expect(committed?.tokens?.operator?.token).not.toBe(device.tokens!.operator!.token);
        expect(onTokensReplaced).toHaveBeenCalledExactlyOnceWith("paired-rich", ["operator"]);
        expect(scopesAtRetirement).toEqual(["operator.read"]);
        expect(getPublishedPairedDeviceBinding("paired-rich", baseDir)?.identity).not.toBe(
          previousBinding?.identity,
        );
        expect(await getPendingDevicePairing("newest", baseDir)).toBeNull();
      }
    } finally {
      delivery.mockRestore();
    }
  },
);

test("rechecks the original operator generation through reopened read-only pairing storage", async () => {
  const isolatedDir = tempDirs.make("pairing-operator-generation-");
  const deviceId = "recovery-device";
  const scopes = ["operator.read"];
  const { request } = await requestDevicePairing(
    { deviceId, publicKey: "synthetic-recovery-public-key", role: "operator", scopes },
    isolatedDir,
  );
  await expect(
    approveDevicePairing(request.requestId, { callerScopes: scopes }, isolatedDir),
  ).resolves.toMatchObject({ status: "approved" });
  const isolatedDatabase = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: isolatedDir },
  });
  try {
    const original = await loadPairedDevicePairingStoreRecordReadOnly(deviceId, isolatedDir);
    const identity = resolveAuthenticatedDeviceTokenIdentity(original, {
      role: "operator",
      publicKey: "synthetic-recovery-public-key",
      token: original!.tokens!.operator!.token,
      scopes,
    });
    if (!identity) {
      throw new Error("Original admitted operator token has no generation");
    }
    await closeOpenClawStateDatabaseByPathAsync(isolatedDatabase.path);
    const reopened = await loadPairedDevicePairingStoreRecordReadOnly(deviceId, isolatedDir);
    expect(isPairedDeviceTokenIdentityCurrent(reopened, "operator", identity, scopes)).toBe(true);
    await expect(
      rotateDeviceToken({ deviceId, role: "operator", baseDir: isolatedDir }),
    ).resolves.toMatchObject({ ok: true });
    const rotated = await loadPairedDevicePairingStoreRecordReadOnly(deviceId, isolatedDir);
    expect(isPairedDeviceTokenIdentityCurrent(rotated, "operator", identity, scopes)).toBe(false);
  } finally {
    await closeOpenClawStateDatabaseByPathAsync(isolatedDatabase.path);
  }
});

test("reuses and verifies committed tokens while writes wait, then rejects committed revocation", async ({
  signal,
}) => {
  await listDevicePairing(baseDir);
  const params = operator;
  const { holding, release } = await holdWriter();
  try {
    const reusable = await withinTest(
      awaitGateBeforeSettlement(ensureDeviceToken(params), holding, "reuse waited for writer"),
      signal,
    );
    expect(reusable?.token).toBe("synthetic-operator-token");
    await expect(
      withinTest(
        awaitGateBeforeSettlement(
          verifyDeviceToken({ ...params, token: reusable!.token }),
          holding,
          "verification waited for writer",
        ),
        signal,
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      ensureDeviceToken({ ...params, isIssuanceCurrent: () => false }),
    ).resolves.toBeNull();
    expect((await paired())?.tokens?.operator?.lastUsedAtMs).toBe(3);
  } finally {
    release.resolve();
    await holding;
    await withDevicePairingLock(async () => {});
  }
  expect((await paired())?.tokens?.operator?.lastUsedAtMs).toBeGreaterThan(3);
  await revokeDeviceToken(params);
  await expect(verifyOperator()).resolves.toEqual({ ok: false, reason: "token-revoked" });
});

test("keeps queued token rotation before revocation in the pairing owner", async () => {
  const params = { deviceId: "paired-rich", role: "operator", baseDir };
  const { holding, release } = await holdWriter();
  const rotating = rotateDeviceToken(params);
  const revoking = revokeDeviceToken(params);
  release.resolve();
  const [, rotated, revoked] = await Promise.all([holding, rotating, revoking]);
  expect(rotated.ok).toBe(true);
  expect(revoked.ok).toBe(true);
  if (rotated.ok && revoked.ok) {
    expect(revoked.entry.token).toBe(rotated.entry.token);
    await expect(
      verifyDeviceToken({ ...params, token: rotated.entry.token, scopes: [] }),
    ).resolves.toEqual({ ok: false, reason: "token-revoked" });
  }
});

test("admits revocation between coalesced token last-use writes", async ({ signal }) => {
  await listDevicePairing(baseDir);
  const params = { ...operator, baseDir };
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const revokedBeforeRecord: boolean[] = [];
  let records = 0;
  const writer = probe.command(stateWorker, async (command, options, scope) => {
    if (command.type === "devicePairing.verifyToken") {
      records++;
      if (records === 1) {
        entered.resolve();
        await release.promise;
      } else {
        const device = await getPairedDevice(params.deviceId, baseDir);
        revokedBeforeRecord.push(Boolean(device?.tokens?.operator?.revokedAtMs));
      }
    }
    return scope.execute(command, options);
  });
  let revoking: Promise<unknown> | undefined;
  try {
    await expect(verifyOperator(baseDir)).resolves.toEqual({ ok: true });
    await withinTest(entered.promise, signal);
    revoking = revokeDeviceToken(params);
    await expect(verifyOperator(baseDir)).resolves.toEqual({ ok: true });
    release.resolve();
    await withinTest(revoking, signal);
    await withDevicePairingLock(async () => {});
    expect(revokedBeforeRecord).toEqual([true]);
    await expect(verifyOperator(baseDir)).resolves.toEqual({ ok: false, reason: "token-revoked" });
  } finally {
    release.resolve();
    await revoking;
    await withDevicePairingLock(async () => {});
    writer.mockRestore();
  }
});
