import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, expect, onTestFinished, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import * as stateReads from "../state/openclaw-state-db-readonly.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import { approveBootstrapDevicePairing, approveDevicePairing } from "./device-pairing-approval.js";
import {
  isNodePairingGenerationCurrent,
  resolveCurrentPairedDeviceNodeBinding,
} from "./device-pairing-node-state.js";
import { getPublishedPairedDeviceBinding } from "./device-pairing-publication.js";
import {
  persistDevicePairingStoreState,
  readDevicePairingStoreStateFromDatabase,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";
import {
  ensureDeviceToken,
  revokeDeviceToken,
  rotateDeviceToken,
  verifyDeviceToken,
} from "./device-pairing-tokens.js";
import {
  getPairedDevice,
  getPendingDevicePairing,
  listDevicePairing,
  listDevicePairingReadOnly,
  removePairedDevice,
  removePairedDeviceRole,
  requestDevicePairing,
  resolveNodePairingGeneration,
  updatePairedDeviceMetadata,
  updatePairedDevicePresence,
} from "./device-pairing.js";
import * as queries from "./kysely-sync.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";

let baseDir: string;
let database: ReturnType<typeof openOpenClawStateDatabase>;
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

beforeEach(() => {
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
        scopes: [],
        silent: false,
        isRepair: false,
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
        operatorLabel: "Fixture",
        platform: "linux",
        deviceFamily: "desktop",
        clientId: "fixture-client",
        clientMode: "node",
        browserOrigin: "https://fixture.invalid",
        role: "operator",
        roles: ["operator", "node"],
        scopes: ["operator.read"],
        approvedScopes: ["operator.read"],
        remoteIp: "192.0.2.1",
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
        approvedVia: "owner",
        nodeSurface: {
          commands: ["system.run"],
          caps: [],
          permissions: { camera: false },
          bins: [],
          sessionHost: false,
          createdAtMs: 1,
          approvedAtMs: 4,
        },
        pendingNodeSurface: {
          requestId: "node-pending",
          revision: "fixture-revision",
          commands: [],
          silent: false,
          ts: 5,
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
  const native = readDevicePairingStoreStateFromDatabase(database.db);
  const { refreshedAtMs: _refreshedAtMs, ...refreshed } = native.pendingById.refreshed!;
  const goldenList = JSON.stringify({
    pending: [native.pendingById.newest, refreshed],
    paired: [native.pairedByDeviceId["paired-rich"], native.pairedByDeviceId["paired-minimal"]],
  });
  const all = vi.spyOn(queries, "executeSqliteQuerySync");
  const first = vi.spyOn(queries, "executeSqliteQueryTakeFirstSync");
  try {
    expect(JSON.stringify(await listDevicePairing(baseDir))).toBe(goldenList);
    expect(JSON.stringify(await listDevicePairingReadOnly(baseDir))).toBe(goldenList);
    expect(JSON.stringify(await getPairedDevice(" paired-rich ", baseDir))).toBe(
      JSON.stringify(native.pairedByDeviceId["paired-rich"]),
    );
    expect(JSON.stringify(await getPendingDevicePairing("refreshed", baseDir))).toBe(
      JSON.stringify(refreshed),
    );
    expect(await getPendingDevicePairing("expired", baseDir)).toBeNull();
    for (const missing of ["missing", "toString", "constructor", "__proto__"]) {
      expect(await getPairedDevice(missing, baseDir)).toBeNull();
    }
    expect(all).not.toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
  } finally {
    all.mockRestore();
    first.mockRestore();
  }
});

test("rolls back owner approval when live policy is revoked before worker commit", async () => {
  const before = JSON.stringify(readDevicePairingStoreStateFromDatabase(database.db));
  let allowed = true;
  let revokeAfterGrant = true;
  const isApprovalCurrent = () => {
    if (revokeAfterGrant) {
      queueMicrotask(() => {
        allowed = false;
      });
    }
    return allowed;
  };
  const approve = () =>
    approveDevicePairing("newest", { callerScopes: ["operator.read"], isApprovalCurrent }, baseDir);

  await expect(approve()).resolves.toEqual({
    status: "forbidden",
    reason: "approval-policy-changed",
  });
  expect(JSON.stringify(readDevicePairingStoreStateFromDatabase(database.db))).toBe(before);
  allowed = true;
  revokeAfterGrant = false;
  await expect(approve()).resolves.toMatchObject({
    status: "approved",
    requestId: "newest",
    device: { deviceId: "paired-rich", publicKey: "synthetic-replacement-key" },
  });
  expect(await getPendingDevicePairing("newest", baseDir)).toBeNull();
  expect((await getPairedDevice("paired-rich", baseDir))?.publicKey).toBe(
    "synthetic-replacement-key",
  );
});

test("refreshes cached reads after another connection replaces pairing authority", async () => {
  await expect(getPairedDevice("paired-rich", baseDir)).resolves.toMatchObject({
    publicKey: "synthetic-original-key",
  });
  await listDevicePairing(baseDir);
  const other = new DatabaseSync(database.path);
  try {
    other
      .prepare(
        "UPDATE device_pairing_paired SET public_key = ?, display_name = ? WHERE device_id = ?",
      )
      .run("synthetic-external-key", "External fixture", "paired-rich");
  } finally {
    other.close();
  }
  const native = readDevicePairingStoreStateFromDatabase(database.db).pairedByDeviceId[
    "paired-rich"
  ];
  expect(JSON.stringify((await listDevicePairing(baseDir)).paired[0])).toBe(JSON.stringify(native));
  expect(JSON.stringify(await getPairedDevice("paired-rich", baseDir))).toBe(
    JSON.stringify(native),
  );
});

test("reconnects without replacing paired rows or changing unrelated device fields", async () => {
  // Admit the writer before installing fixture-only mutation guards.
  await ensureDeviceToken({
    deviceId: "paired-rich",
    role: "operator",
    scopes: ["operator.read"],
    baseDir,
  });
  database.db.exec(`
    CREATE TRIGGER pairing_reconnect_no_delete BEFORE DELETE ON device_pairing_paired
      BEGIN SELECT RAISE(ABORT, 'reconnect deleted a paired row'); END;
    CREATE TRIGGER pairing_reconnect_no_insert BEFORE INSERT ON device_pairing_paired
      BEGIN SELECT RAISE(ABORT, 'reconnect inserted a paired row'); END;
    CREATE TRIGGER pairing_reconnect_exact_update BEFORE UPDATE ON device_pairing_paired
      WHEN OLD.device_id <> 'paired-rich'
      BEGIN SELECT RAISE(ABORT, 'reconnect updated another device'); END;
  `);
  const before = readDevicePairingStoreStateFromDatabase(database.db);
  try {
    await expect(
      verifyDeviceToken({
        deviceId: " paired-rich ",
        token: "synthetic-operator-token",
        role: "operator",
        scopes: ["operator.read"],
        baseDir,
      }),
    ).resolves.toEqual({ ok: true });
    const verified = await getPairedDevice("paired-rich", baseDir);
    expect(verified?.tokens?.operator?.lastUsedAtMs).toBeGreaterThan(3);
    expect(verified?.lastSeenAtMs).toBe(verified?.tokens?.operator?.lastUsedAtMs);
    expect(verified?.lastSeenReason).toBe("device-token-auth");
    await expect(
      updatePairedDeviceMetadata(
        "paired-rich",
        {
          displayName: undefined,
          remoteIp: "192.0.2.2",
          lastSeenAtMs: 1234,
          lastSeenReason: "connect",
        },
        baseDir,
      ),
    ).resolves.toBe(true);
    await expect(
      ensureDeviceToken({
        deviceId: "paired-rich",
        role: "operator",
        scopes: ["operator.read"],
        baseDir,
      }),
    ).resolves.toEqual(verified?.tokens?.operator);
    const after = readDevicePairingStoreStateFromDatabase(database.db);
    expect(after).toEqual({
      ...before,
      pairedByDeviceId: {
        ...before.pairedByDeviceId,
        "paired-rich": {
          ...before.pairedByDeviceId["paired-rich"],
          displayName: undefined,
          remoteIp: "192.0.2.2",
          tokens: verified?.tokens,
          lastSeenAtMs: 1234,
          lastSeenReason: "connect",
        },
      },
    });
  } finally {
    database.db.exec(`
      DROP TRIGGER pairing_reconnect_no_delete;
      DROP TRIGGER pairing_reconnect_no_insert;
      DROP TRIGGER pairing_reconnect_exact_update;
    `);
  }
});

test("reconnect receipts ignore pending rows while invalidating foreign pairing changes", async () => {
  await listDevicePairing(baseDir);
  const previousBinding = getPublishedPairedDeviceBinding("paired-rich", baseDir);
  expect(previousBinding).not.toBeNull();
  const other = new DatabaseSync(database.path);
  try {
    other
      .prepare("UPDATE device_pairing_paired SET public_key = ? WHERE device_id = ?")
      .run("synthetic-foreign-key", "paired-rich");
    // A receipt must not decode unrelated pending requests.
    other
      .prepare("UPDATE device_pairing_pending SET roles_json = ? WHERE request_id = ?")
      .run("synthetic-unreadable-json", "refreshed");
  } finally {
    other.close();
  }
  try {
    await expect(
      updatePairedDeviceMetadata("paired-minimal", { displayName: "Reconnected" }, baseDir),
    ).resolves.toBe(true);
    expect(() => getPublishedPairedDeviceBinding("paired-rich", baseDir)).toThrow(
      "requires a current worker publication",
    );
    const tokenParams = {
      deviceId: "paired-rich",
      role: "operator",
      scopes: ["operator.read"],
      baseDir,
    };
    await expect(
      verifyDeviceToken({ ...tokenParams, token: "synthetic-operator-token" }),
    ).resolves.toEqual({ ok: true });
    const currentBinding = getPublishedPairedDeviceBinding("paired-rich", baseDir);
    expect(currentBinding).not.toBeNull();
    expect(currentBinding?.identity).not.toBe(previousBinding?.identity);
    await expect(ensureDeviceToken(tokenParams)).resolves.toMatchObject({
      token: "synthetic-operator-token",
    });
    expect(getPublishedPairedDeviceBinding("paired-rich", baseDir)).toEqual(currentBinding);
  } finally {
    database.db
      .prepare("UPDATE device_pairing_pending SET roles_json = ? WHERE request_id = ?")
      .run("[]", "refreshed");
  }
  expect((await getPendingDevicePairing("refreshed", baseDir))?.roles).toEqual([]);
});

test.each(["current", "replaced key", "recreated pairing", "newer observation"] as const)(
  "binds a delayed metadata refresh to its observed pairing (%s)",
  async (state) => {
    const before = await getPairedDevice("paired-rich", baseDir);
    expect(before).not.toBeNull();
    const expectedPairing = {
      publicKey: state === "replaced key" ? "synthetic-old-key" : before!.publicKey,
      createdAtMs: state === "recreated pairing" ? 0 : before!.createdAtMs,
      approvedAtMs: before!.approvedAtMs,
    };
    const patch = {
      displayName: "Reconnected browser",
      lastSeenAtMs: state === "newer observation" ? 5 : 10,
      lastSeenReason: "connect",
    };
    await expect(
      updatePairedDeviceMetadata("paired-rich", patch, baseDir, {
        expectedPairing,
        assertCurrent: () => {},
      }),
    ).resolves.toBe(state === "current");
    expect(await getPairedDevice("paired-rich", baseDir)).toEqual(
      state === "current" ? { ...before, ...patch } : before,
    );
  },
);

test("rolls back delayed metadata when its connection closes before worker commit", async () => {
  const before = await getPairedDevice("paired-rich", baseDir);
  expect(before).not.toBeNull();
  let connected = true;
  let commitRequested = false;
  const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
  const closing = vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      createAdmission((request, grant) => {
        if (request.stage === "commit") {
          commitRequested = true;
          connected = false;
        }
        admit(request, grant);
      }, attachment),
    );
  try {
    await expect(
      updatePairedDeviceMetadata(
        "paired-rich",
        { displayName: "Closed browser", lastSeenAtMs: 10, lastSeenReason: "connect" },
        baseDir,
        {
          expectedPairing: before!,
          assertCurrent: () => {
            if (!connected) {
              throw new Error("Synthetic connection retired");
            }
          },
        },
      ),
    ).rejects.toThrow("Synthetic connection retired");
    expect(commitRequested).toBe(true);
    expect(() => getPublishedPairedDeviceBinding("paired-rich", baseDir)).toThrow(
      "requires a current worker publication",
    );
    expect(await getPairedDevice("paired-rich", baseDir)).toEqual(before);
  } finally {
    closing.mockRestore();
  }
});

test.each(
  ["node", "operator"].flatMap((role) =>
    ["current", "role removed", "token revoked", "token rotated"].map((change) => ({
      role,
      change,
    })),
  ),
)("binds delayed metadata to the current $role grant ($change)", async ({ role, change }) => {
  const before = await getPairedDevice("paired-rich", baseDir);
  const grant = before?.tokens?.[role];
  if (!before || !grant) {
    throw new Error("Expected the fixture's approved role token");
  }
  const expectedPairing = { ...before, grant: { role, token: grant.token } };
  const authority = { deviceId: before.deviceId, role, baseDir, callerScopes: ["operator.read"] };
  if (change === "role removed") {
    await removePairedDeviceRole(authority);
  } else if (change === "token revoked") {
    await revokeDeviceToken(authority);
  } else if (change === "token rotated") {
    await rotateDeviceToken(authority);
  }
  const current = await getPairedDevice(before.deviceId, baseDir);
  expect(current).toMatchObject({
    publicKey: before.publicKey,
    createdAtMs: before.createdAtMs,
    approvedAtMs: before.approvedAtMs,
  });
  const patch = { displayName: "Delayed observation", lastSeenAtMs: 10, lastSeenReason: "connect" };
  await expect(
    updatePairedDeviceMetadata(before.deviceId, patch, baseDir, {
      expectedPairing,
      assertCurrent: () => {},
    }),
  ).resolves.toBe(change === "current");
  expect(await getPairedDevice(before.deviceId, baseDir)).toEqual(
    change === "current" ? { ...current, ...patch } : current,
  );
});

test("does not overwrite a same-key platform reapproval with delayed metadata", async () => {
  const before = await getPairedDevice("paired-rich", baseDir);
  if (!before) {
    throw new Error("Expected the fixture's paired device");
  }
  const requested = await requestDevicePairing(
    {
      deviceId: before.deviceId,
      publicKey: before.publicKey,
      platform: "freebsd",
      role: "operator",
      scopes: ["operator.read"],
    },
    baseDir,
  );
  const approved = await approveDevicePairing(
    requested.request.requestId,
    { callerScopes: ["operator.read"] },
    baseDir,
  );
  if (approved?.status !== "approved") {
    throw new Error("Expected the same-key platform reapproval");
  }
  expect(approved.device).toMatchObject({
    publicKey: before.publicKey,
    createdAtMs: before.createdAtMs,
    platform: "freebsd",
  });
  expect(approved.device.approvedAtMs).not.toBe(before.approvedAtMs);
  await expect(
    updatePairedDeviceMetadata(
      before.deviceId,
      { platform: "linux", lastSeenAtMs: 10, lastSeenReason: "connect" },
      baseDir,
      { expectedPairing: before, assertCurrent: () => {} },
    ),
  ).resolves.toBe(false);
  expect(await getPairedDevice(before.deviceId, baseDir)).toEqual(approved.device);
});

test.each([
  "metadata",
  "presence",
  "removal",
  "committed metadata",
  "intermediate metadata",
] as const)(
  "keeps committed pairing reads available only during non-auth %s work",
  async (kind) => {
    const before = await getPairedDevice("paired-rich", baseDir);
    const previousBinding = getPublishedPairedDeviceBinding("paired-rich", baseDir);
    const generation = resolveNodePairingGeneration(before);
    if (!before || !generation) {
      throw new Error("Expected the fixture's paired node");
    }
    const writerStarted = createDeferred();
    const releaseWriter = createDeferred();
    const writerCommitted = createDeferred();
    const releaseReply = createDeferred();
    const readCompleted = createDeferred();
    const releaseRead = createDeferred();
    const runOperation = stateWorker.runOpenClawStateWorkerOperation;
    const heldWriter = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        runOperation(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                writerStarted.resolve();
                await releaseWriter.promise;
                const result = await scope.execute(command, executeOptions);
                writerCommitted.resolve();
                if (kind === "committed metadata") {
                  await releaseReply.promise;
                }
                return result;
              },
            }),
          options,
        ),
      );
    const executeRead = stateReads.executeExistingOpenClawStateRead;
    let capturedRead = false;
    const observedRead = vi
      .spyOn(stateReads, "executeExistingOpenClawStateRead")
      .mockImplementation(async (...args) => {
        const capture = args[1].type === "devicePairing.lookup" && !capturedRead;
        if (capture) {
          capturedRead = true;
          if (kind === "intermediate metadata") {
            await writerCommitted.promise;
          }
        }
        const result = await executeRead(...args);
        if (capture) {
          readCompleted.resolve();
          if (kind === "committed metadata" || kind === "intermediate metadata") {
            await releaseRead.promise;
          }
        }
        return result;
      });
    const patch = { lastSeenAtMs: 10, lastSeenReason: "connect" };
    const mutation =
      kind === "metadata" || kind === "committed metadata" || kind === "intermediate metadata"
        ? updatePairedDeviceMetadata("paired-rich", patch, baseDir)
        : kind === "presence"
          ? updatePairedDevicePresence("paired-rich", patch, generation, baseDir)
          : removePairedDevice("paired-rich", baseDir);
    const reader = writerStarted.promise.then(() => getPairedDevice("paired-rich", baseDir));
    const authority = writerStarted.promise.then(() =>
      withEnvAsync({ OPENCLAW_STATE_DIR: baseDir }, () =>
        Promise.allSettled([
          resolveCurrentPairedDeviceNodeBinding("paired-rich"),
          isNodePairingGenerationCurrent(generation),
        ]),
      ),
    );
    onTestFinished(async () => {
      releaseWriter.resolve();
      releaseReply.resolve();
      releaseRead.resolve();
      await Promise.allSettled([mutation, reader, authority]);
      observedRead.mockRestore();
      heldWriter.mockRestore();
    });
    await writerStarted.promise;
    if (kind === "intermediate metadata") {
      releaseWriter.resolve();
    }
    await readCompleted.promise;
    if (kind === "removal") {
      expect(() => getPublishedPairedDeviceBinding("paired-rich", baseDir)).toThrow(
        "requires a current worker publication",
      );
      releaseWriter.resolve();
      expect(await reader).toBeNull();
    } else if (kind === "committed metadata") {
      releaseWriter.resolve();
      await writerCommitted.promise;
      releaseRead.resolve();
      // The read completed before this observation committed. Consuming its
      // snapshot must preserve newer authority without waiting for the delayed reply.
      expect(await reader).toEqual(before);
      releaseReply.resolve();
    } else if (kind === "intermediate metadata") {
      await mutation;
      await authority;
      const latest = { ...patch, lastSeenAtMs: 20 };
      await updatePairedDeviceMetadata("paired-rich", latest, baseDir);
      releaseRead.resolve();
      expect(await reader).toEqual({ ...before, ...latest });
    } else {
      expect(() => getPublishedPairedDeviceBinding("paired-rich", baseDir)).toThrow(
        "requires a current worker publication",
      );
      expect(await reader).toEqual(before);
      releaseWriter.resolve();
    }
    await mutation;
    expect(getPublishedPairedDeviceBinding("paired-rich", baseDir)).toEqual(
      kind === "removal" ? null : previousBinding,
    );
    expect(await authority).toEqual([
      { status: "fulfilled", value: kind === "removal" ? undefined : previousBinding },
      { status: "fulfilled", value: kind !== "removal" },
    ]);
  },
);

test.each(["reply lost", "policy revoked", "callback throws"] as const)(
  "retires narrowed bootstrap grants only after native settlement (%s)",
  async (fault) => {
    const seeded = readDevicePairingStoreStateFromDatabase(database.db);
    const device = seeded.pairedByDeviceId["paired-rich"]!;
    device.scopes = ["operator.admin"];
    device.approvedScopes = ["operator.admin"];
    device.tokens!.operator!.scopes = ["operator.admin"];
    persistDevicePairingStoreState(seeded, baseDir, "both");
    await listDevicePairing(baseDir);
    const before = JSON.stringify(readDevicePairingStoreStateFromDatabase(database.db));
    const previousBinding = getPublishedPairedDeviceBinding("paired-rich", baseDir);
    const deliveryError = new Error("Synthetic bootstrap result delivery failure");
    const callbackError = new Error("Synthetic bootstrap retirement callback failure");
    let scopesAtRetirement: string[] | undefined;
    const onTokensReplaced = vi.fn((_deviceId: string, _roles: readonly string[]) => {
      scopesAtRetirement = readDevicePairingStoreStateFromDatabase(database.db).pairedByDeviceId[
        "paired-rich"
      ]?.tokens?.operator?.scopes;
      if (fault === "callback throws") {
        throw callbackError;
      }
    });
    const original = stateWorker.runOpenClawStateWorkerOperation;
    const delivery = vi
      .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
      .mockImplementation((context, operation, options) =>
        original(
          context,
          (scope) =>
            operation({
              execute: async (command, executeOptions) => {
                const result = await scope.execute(command, executeOptions);
                if (command.type === "devicePairing.approveBootstrap" && fault === "reply lost") {
                  throw deliveryError;
                }
                return result;
              },
            }),
          options,
        ),
      );
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
        expect(JSON.stringify(readDevicePairingStoreStateFromDatabase(database.db))).toBe(before);
      } else {
        await expect(approval).rejects.toThrow(
          fault === "reply lost" ? deliveryError.message : callbackError.message,
        );
        const committed = readDevicePairingStoreStateFromDatabase(database.db).pairedByDeviceId[
          "paired-rich"
        ];
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
