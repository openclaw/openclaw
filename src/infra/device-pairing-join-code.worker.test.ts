import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { StateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  redeemDevicePairingJoinCode,
  registerDevicePairingJoinCode,
} from "./device-pairing-join-code.js";
import { getPublishedPairedDeviceBinding } from "./device-pairing-publication.js";
import { persistDevicePairingStoreState } from "./device-pairing-store.js";
import { listDevicePairing } from "./device-pairing.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";

const payload = { url: "wss://join.example.invalid", bootstrapToken: "synthetic-join-bootstrap" };
let baseDir: string;
let database: ReturnType<typeof openOpenClawStateDatabase>;
const databasePaths = new Set<string>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    for (const databasePath of databasePaths) {
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
    }
    cleanup();
  }),
);

function captureContext(directory = baseDir) {
  return captureOpenClawStateWorkerContext({
    env: { ...process.env, OPENCLAW_STATE_DIR: directory },
  });
}

function mint(context = captureContext(), assertCurrent?: () => void) {
  return registerDevicePairingJoinCode({
    payload,
    expiresAtMs: Date.now() + 60_000,
    context,
    assertCurrent,
  });
}

function storedCodes() {
  const exists = database.db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'device_pairing_join_codes'",
    )
    .get();
  return exists
    ? database.db
        .prepare("SELECT shortcode FROM device_pairing_join_codes ORDER BY shortcode")
        .all()
    : [];
}

beforeAll(() => {
  baseDir = tempDirs.make("join-code-worker-");
  database = openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } });
  databasePaths.add(database.path);
});

afterEach(() => {
  vi.restoreAllMocks();
});

test.each([
  { operation: "register", refusedStage: "commit" },
  { operation: "register", refusedStage: "transaction" },
  { operation: "redeem", refusedStage: "commit" },
  { operation: "redeem", refusedStage: "transaction" },
] as const)(
  "rolls back $operation at $refusedStage and preserves the host error",
  async ({ operation, refusedStage }) => {
    const context = captureContext();
    const shortcode = operation === "redeem" ? await mint(context) : undefined;
    const before = storedCodes();
    class JoinAuthorityError extends Error {}
    const refused = new JoinAuthorityError("Synthetic join authority revoked");
    let currentStage: workerAdmission.SqliteWorkerAdmissionRequest["stage"] | undefined;
    const original = workerAdmission.createSqliteWorkerOperationAdmission;
    const observer = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        original((request, grant) => {
          currentStage = request.stage;
          admit(request, grant);
        }, attachment),
      );
    const assertCurrent = () => {
      if (currentStage === refusedStage) {
        throw refused;
      }
    };
    try {
      const pending = shortcode
        ? redeemDevicePairingJoinCode({ shortcode, context, assertCurrent })
        : mint(context, assertCurrent);
      await expect(pending).rejects.toBe(refused);
      expect(currentStage).toBe(refusedStage);
      expect(storedCodes()).toEqual(before);
    } finally {
      observer.mockRestore();
    }
    // The first case rolls back lazy schema creation; retry must admit it again.
    const liveCode = shortcode ?? (await mint(context));
    await expect(redeemDevicePairingJoinCode({ shortcode: liveCode, context })).resolves.toEqual(
      payload,
    );
  },
);

test("keeps the captured store and paired-node authority while a join waits", async () => {
  persistDevicePairingStoreState(
    {
      pendingById: {},
      pairedByDeviceId: {
        node: {
          deviceId: "node",
          publicKey: "synthetic-node-key",
          roles: ["node"],
          tokens: {
            node: { token: "synthetic-node-token", role: "node", scopes: [], createdAtMs: 1 },
          },
          nodeSurface: { createdAtMs: 1, approvedAtMs: 1 },
          createdAtMs: 1,
          approvedAtMs: 1,
        },
      },
    },
    baseDir,
    "both",
  );
  await listDevicePairing(baseDir);
  const binding = getPublishedPairedDeviceBinding("node", baseDir);
  expect(binding).not.toBeNull();
  const context = captureContext();
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const original = stateWorker.runOpenClawStateWorkerOperation;
  vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementationOnce(
    async (...args) => {
      entered.resolve();
      await release.promise;
      return original(...args);
    },
  );
  const registration = mint(context);
  const otherRoot = tempDirs.make("join-code-other-root-");
  await withEnvAsync({ OPENCLAW_STATE_DIR: otherRoot }, async () => {
    try {
      await awaitGateBeforeSettlement(
        entered.promise,
        registration,
        "Join registration did not enter",
      );
      expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
      release.resolve();
      const shortcode = await registration;
      expect(storedCodes()).toContainEqual({ shortcode });
      await expect(redeemDevicePairingJoinCode({ shortcode, context })).resolves.toEqual(payload);
      expect(existsSync(path.join(otherRoot, "state", "openclaw.sqlite"))).toBe(false);
      expect(getPublishedPairedDeviceBinding("node", baseDir)).toEqual(binding);
    } finally {
      release.resolve();
      await Promise.allSettled([registration]);
    }
  });
});

test("never replays a burned code or recovers its payload after an unknown result", async () => {
  const context = captureContext();
  const shortcode = await mint(context);
  const unknown = new SqliteWorkerError("Synthetic lost burn result", "outcome-unknown");
  let burns = 0;
  const original = stateWorker.runOpenClawStateWorkerOperation;
  vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementation(
    (captured, operation, options) =>
      original(
        captured,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              if (command.type === "devicePairing.redeemJoinCode") {
                burns++;
                throw unknown;
              }
              return result;
            },
          }),
        options,
      ),
  );
  await expect(redeemDevicePairingJoinCode({ shortcode, context })).rejects.toBe(unknown);
  expect(burns).toBe(1);
  expect(storedCodes()).not.toContainEqual({ shortcode });
});

test.each(["register", "redeem"] as const)(
  "withholds a join code that expires before %s acknowledgement",
  async (operation) => {
    const context = captureContext();
    const expiresAtMs = Date.now() + 60_000;
    const shortcode =
      operation === "redeem"
        ? await registerDevicePairingJoinCode({ payload, expiresAtMs, context })
        : undefined;
    const original = stateWorker.runOpenClawStateWorkerOperation;
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementationOnce(
      (captured, run, options) =>
        original(
          captured,
          (scope) =>
            run({
              execute: async (command, executeOptions) => {
                const result = await scope.execute(command, executeOptions);
                vi.spyOn(Date, "now").mockReturnValue(expiresAtMs);
                return result;
              },
            }),
          options,
        ),
    );
    if (shortcode) {
      await expect(redeemDevicePairingJoinCode({ shortcode, context })).resolves.toBeNull();
      expect(storedCodes()).not.toContainEqual({ shortcode });
    } else {
      await expect(
        registerDevicePairingJoinCode({ payload, expiresAtMs, context }),
      ).rejects.toThrow("Device pairing join code requires a future expiry.");
    }
  },
);

test("database close joins accepted burn delivery and refuses its retired context", async () => {
  const closeRoot = tempDirs.make("join-code-close-");
  const closingDatabase = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: closeRoot },
  });
  databasePaths.add(closingDatabase.path);
  const context = captureContext(closeRoot);
  const shortcode = await mint(context);
  const committed = createDeferredCore();
  const release = createDeferredCore();
  const order: string[] = [];
  const original = stateWorker.runOpenClawStateWorkerOperation;
  vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementationOnce(
    (captured, operation, options) =>
      original(
        captured,
        (scope) =>
          operation({
            execute: async (command, executeOptions) => {
              const result = await scope.execute(command, executeOptions);
              committed.resolve();
              await release.promise;
              order.push("delivered");
              return result;
            },
          }),
        options,
      ),
  );
  const redemption = redeemDevicePairingJoinCode({ shortcode, context });
  let closing: Promise<boolean> | undefined;
  try {
    await awaitGateBeforeSettlement(committed.promise, redemption, "Burn did not commit");
    closing = closeOpenClawStateDatabaseByPathAsync(closingDatabase.path).then((result) => {
      order.push("closed");
      return result;
    });
    expect(() => context.admission.assertCurrent()).toThrow(
      StateDatabaseReadAdmissionInvalidatedError,
    );
    expect(closingDatabase.db.isOpen).toBe(true);
    release.resolve();
    await expect(redemption).resolves.toEqual(payload);
    await closing;
    expect(order).toEqual(["delivered", "closed"]);
    await expect(mint(context)).rejects.toBeInstanceOf(StateDatabaseReadAdmissionInvalidatedError);
    expect(closingDatabase.db.isOpen).toBe(false);
  } finally {
    release.resolve();
    await Promise.allSettled([redemption, closing]);
  }
});
