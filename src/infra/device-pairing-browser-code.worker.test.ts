import { afterAll, beforeAll, expect, test } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { startBrowserPairRequestInWorker as start } from "./device-pairing-browser-code.worker.js";

let database: ReturnType<typeof openOpenClawStateDatabase>;
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterAll(async () => {
    await closeStateDatabaseForTest();
    cleanup();
  }),
);

beforeAll(() => {
  database = openOpenClawStateDatabase({
    env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("browser-pair-") },
  });
});

function request(deviceId: string, overrides: Partial<Parameters<typeof start>[1]> = {}) {
  return {
    requestId: `request-${deviceId}`,
    codeCandidates: [`CODE${deviceId}`],
    deviceId,
    publicKey: `key-${deviceId}`,
    nowMs: 1_000,
    expiresAtMs: 2_000,
    maxPending: 2,
    ...overrides,
  };
}

test("skips a code another request already holds", () => {
  const first = start(database.db, request("AAA1", { codeCandidates: ["ABCDEFGH"] }));
  const second = start(database.db, request("AAA2", { codeCandidates: ["ABCDEFGH", "JKMNPQRS"] }));
  expect(first).toMatchObject({ status: "pending", code: "ABCDEFGH" });
  expect(second).toMatchObject({ status: "pending", code: "JKMNPQRS" });
});

test("refuses new browsers at the pending cap until requests expire", () => {
  const full = start(database.db, request("AAA3"));
  expect(full).toEqual({ status: "capacity" });
  const later = start(database.db, request("AAA3", { nowMs: 2_000, expiresAtMs: 3_000 }));
  expect(later).toMatchObject({ status: "pending", code: "CODEAAA3" });
});
