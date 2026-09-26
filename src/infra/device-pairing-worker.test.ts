import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { approveBootstrapDevicePairing, approveDevicePairing } from "./device-pairing-approval.js";
import { getPublishedPairedDeviceBinding } from "./device-pairing-publication.js";
import {
  persistDevicePairingStoreState,
  readDevicePairingStoreStateFromDatabase,
  type DevicePairingStoreState,
} from "./device-pairing-store.js";
import { ensureDeviceToken, verifyDeviceToken } from "./device-pairing-tokens.js";
import {
  getPairedDevice,
  getPendingDevicePairing,
  listDevicePairing,
  listDevicePairingReadOnly,
  updatePairedDeviceMetadata,
} from "./device-pairing.js";
import * as queries from "./kysely-sync.js";

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

test.each(["owner", "bootstrap"] as const)(
  "rolls back %s approval when live policy is revoked before worker commit",
  async (kind) => {
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
      kind === "owner"
        ? approveDevicePairing(
            "newest",
            { callerScopes: ["operator.read"], isApprovalCurrent },
            baseDir,
          )
        : approveBootstrapDevicePairing(
            "newest",
            { roles: ["operator"], scopes: ["operator.read"] },
            { isApprovalCurrent },
            baseDir,
          );

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
  },
);

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
