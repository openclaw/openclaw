import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { awaitGateBeforeSettlement as awaitGate } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createDeferredCore } from "../shared/deferred.js";
import { StateDatabaseReadAdmissionInvalidatedError as RetiredContextError } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  redeemDevicePairingJoinCode as redeem,
  registerDevicePairingJoinCode as register,
} from "./device-pairing-join-code.js";
import { setupPairedNode } from "./device-pairing-node.test-support.js";
import { getPublishedPairedDeviceBinding } from "./device-pairing-publication.js";
import { listDevicePairing } from "./device-pairing.js";
import { SqliteWorkerError } from "./sqlite-worker-contract.js";
import * as workerAdmission from "./sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

const payload = { url: "wss://join.example.invalid", bootstrapToken: "synthetic-join-bootstrap" };
let baseDir: string;
let database: ReturnType<typeof openOpenClawStateDatabase>;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

function captureContext(directory = baseDir) {
  return captureOpenClawStateWorkerContext({
    env: { ...process.env, OPENCLAW_STATE_DIR: directory },
  });
}

function mint(context = captureContext(), assertCurrent?: () => void) {
  return register({
    payload,
    expiresAtMs: Date.now() + 60_000,
    context,
    assertCurrent,
  });
}

function afterCommand(
  effect: (command: Parameters<Parameters<typeof probe.command>[1]>[0]) => void | Promise<void>,
  once = false,
) {
  return probe.command(
    stateWorker,
    async (command, options, scope) => {
      const result = await scope.execute(command, options);
      await effect(command);
      return result;
    },
    { once },
  );
}

function storedCodes() {
  const { db } = database;
  return db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'device_pairing_join_codes'",
    )
    .get()
    ? db.prepare("SELECT shortcode FROM device_pairing_join_codes ORDER BY shortcode").all()
    : [];
}

beforeAll(() => {
  baseDir = tempDirs.make("join-code-worker-");
  database = openOpenClawStateDatabase({ env: { ...process.env, OPENCLAW_STATE_DIR: baseDir } });
});

afterEach(() => vi.restoreAllMocks());

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
    const observer = probe.admission(workerAdmission, (request, grant, admit) => {
      currentStage = request.stage;
      admit(request, grant);
    });
    const assertCurrent = () => {
      if (currentStage === refusedStage) {
        throw refused;
      }
    };
    const pending = shortcode
      ? redeem({ shortcode, context, assertCurrent })
      : mint(context, assertCurrent);
    await expect(pending).rejects.toBe(refused);
    expect(currentStage).toBe(refusedStage);
    expect(storedCodes()).toEqual(before);
    observer.mockRestore();
    // The first case rolls back lazy schema creation; retry must admit it again.
    const liveCode = shortcode ?? (await mint(context));
    await expect(redeem({ shortcode: liveCode, context })).resolves.toEqual(payload);
  },
);

test("keeps the captured store and paired-node authority while a join waits", async () => {
  const generation = await setupPairedNode(baseDir);
  await listDevicePairing(baseDir);
  const published = () => getPublishedPairedDeviceBinding("node-1", baseDir);
  const binding = published();
  expect(binding).toMatchObject({ identity: expect.any(String), generation: generation.key });
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
      await awaitGate(entered.promise, registration, "Join registration did not enter");
      expect(published()).toEqual(binding);
      release.resolve();
      const shortcode = await registration;
      expect(storedCodes()).toContainEqual({ shortcode });
      await expect(redeem({ shortcode, context })).resolves.toEqual(payload);
      expect(existsSync(path.join(otherRoot, "state", "openclaw.sqlite"))).toBe(false);
      expect(published()).toEqual(binding);
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
  afterCommand((command) => {
    if (command.type === "devicePairing.redeemJoinCode") {
      burns++;
      throw unknown;
    }
  });
  await expect(redeem({ shortcode, context })).rejects.toBe(unknown);
  expect(burns).toBe(1);
  expect(storedCodes()).not.toContainEqual({ shortcode });
});

test.each(["register", "redeem"] as const)(
  "withholds a join code that expires before %s acknowledgement",
  async (operation) => {
    const context = captureContext();
    const expiresAtMs = Date.now() + 60_000;
    const shortcode =
      operation === "redeem" ? await register({ payload, expiresAtMs, context }) : undefined;
    afterCommand(() => {
      vi.spyOn(Date, "now").mockReturnValue(expiresAtMs);
    }, true);
    if (shortcode) {
      await expect(redeem({ shortcode, context })).resolves.toBeNull();
      expect(storedCodes()).not.toContainEqual({ shortcode });
    } else {
      await expect(register({ payload, expiresAtMs, context })).rejects.toThrow(
        "Device pairing join code requires a future expiry.",
      );
    }
  },
);

test("database close joins accepted burn delivery and refuses its retired context", async () => {
  const closeRoot = tempDirs.make("join-code-close-");
  const closingDatabase = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: closeRoot },
  });
  const context = captureContext(closeRoot);
  const shortcode = await mint(context);
  const committed = createDeferredCore();
  const release = createDeferredCore();
  const order: string[] = [];
  afterCommand(async () => {
    committed.resolve();
    await release.promise;
    order.push("delivered");
  }, true);
  const redemption = redeem({ shortcode, context });
  let closing: Promise<boolean> | undefined;
  try {
    await awaitGate(committed.promise, redemption, "Burn did not commit");
    closing = closeOpenClawStateDatabaseByPathAsync(closingDatabase.path).then((result) => {
      order.push("closed");
      return result;
    });
    expect(() => context.admission.assertCurrent()).toThrow(RetiredContextError);
    expect(closingDatabase.db.isOpen).toBe(true);
    release.resolve();
    await expect(redemption).resolves.toEqual(payload);
    await closing;
    expect(order).toEqual(["delivered", "closed"]);
    await expect(mint(context)).rejects.toBeInstanceOf(RetiredContextError);
    expect(closingDatabase.db.isOpen).toBe(false);
  } finally {
    release.resolve();
    await Promise.allSettled([redemption, closing]);
  }
});
