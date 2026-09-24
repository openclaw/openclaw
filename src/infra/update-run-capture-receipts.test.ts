import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UpdateRunRecordSchema as WireRunSchema } from "../../packages/gateway-protocol/src/schema/update-runs.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { encodeRun } from "./update-run-codec.js";
import { readUpdateRunRecord } from "./update-run-read.kernel.js";
import { toPublicUpdateRun, type UpdateRunRecord } from "./update-run-record.js";
import { mutateRunInTransaction, persistRun, updateRunLedgerSchema } from "./update-run-write.js";

let root: string;
let database: DatabaseSync | undefined;
let env: NodeJS.ProcessEnv;

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    try {
      database?.close();
    } finally {
      database = undefined;
      cleanup();
    }
  }),
);

function ownedDatabase(): DatabaseSync {
  if (!database || fsSync.realpathSync(root) !== root || !fsSync.lstatSync(root).isDirectory()) {
    throw new Error("Receipt fixture requires its physically private database root");
  }
  return database;
}

function record(): UpdateRunRecord {
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    createdAtMs: 1,
    updatedAtMs: 2,
    trigger: "cli",
    phase: "finished",
    status: "failed",
    reason: "candidate failed",
    origin: { driver: { host: "fixture", pid: 41, startIdentity: "1" } },
    target: { kind: "package" },
    before: {},
    after: {},
    steps: [],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: 2,
    downtimeMs: null,
  };
}

function receipt() {
  return {
    manifestSha256: "a".repeat(64),
    configWrites: [
      {
        path: path.join(root, "state", "private-config.json"),
        beforeHash: "b".repeat(64),
        afterHash: "c".repeat(64),
        contiguous: false,
      },
    ],
    warnings: [
      {
        kind: "undeclared-migration-resources" as const,
        pluginId: "legacy",
        message: "Private state is undeclared",
      },
    ],
    status: "restore-failed" as const,
    error: `Retained capture at ${root}`,
  };
}

function storedRow() {
  return ownedDatabase().prepare("SELECT * FROM update_runs WHERE run_id=?").get(record().runId);
}

beforeEach(async () => {
  root = await fs.realpath(tempDirs.make("update-receipts-"));
  const stateDir = path.join(root, "state");
  const handoffDir = path.join(root, "handoff");
  await fs.mkdir(stateDir, { mode: 0o700 });
  await fs.mkdir(handoffDir, { mode: 0o700 });
  expect(await fs.realpath(stateDir)).toBe(stateDir);
  expect(await fs.realpath(handoffDir)).toBe(handoffDir);
  env = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  database = new (requireNodeSqlite().DatabaseSync)(path.join(stateDir, "receipts.sqlite"));
  ownedDatabase().exec(updateRunLedgerSchema);
  const row = encodeRun(record(), { env });
  const columns = Object.keys(row);
  ownedDatabase()
    .prepare(
      `INSERT INTO update_runs (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .run(...Object.values(row));
});

describe("durable update capture receipts", () => {
  it("keeps ordinary runs writable without a capture receipt", () => {
    const input = { ...record(), reason: "ordinary progress" };
    persistRun(ownedDatabase(), input, { env });
    const recovered = readUpdateRunRecord(ownedDatabase(), input.runId);
    expect(recovered?.reason).toBe("ordinary progress");
    expect(recovered?.origin.driver).toEqual(input.origin.driver);
    expect(recovered?.origin.updateRecoveryCapture).toBeUndefined();
    expect(toPublicUpdateRun(recovered!)).toEqual(recovered);
    expect(recovered?.updatedAtMs).toBeGreaterThan(2);
  });

  it("preserves exact receipt paths, hashes and warnings through the real ledger writer and reader", () => {
    const capture = receipt();
    const input = {
      ...record(),
      reason: `Failure at ${root}`,
      origin: { ...record().origin, updateRecoveryCapture: capture },
    };
    persistRun(ownedDatabase(), input, { env });
    ownedDatabase().close();
    database = undefined;
    database = new (requireNodeSqlite().DatabaseSync)(path.join(root, "state", "receipts.sqlite"));
    const recovered = readUpdateRunRecord(ownedDatabase(), input.runId);
    expect(recovered?.origin.updateRecoveryCapture).toEqual(capture);
    expect(recovered?.origin.driver).toEqual(record().origin.driver);
    expect(recovered?.reason).not.toContain(root);
    expect(recovered?.reason).toContain("~");
    expect(recovered?.status).toBe("failed");
  });

  it("exports a valid public run without private recovery receipts or changing durable evidence", () => {
    const capture = receipt();
    persistRun(
      ownedDatabase(),
      { ...record(), origin: { ...record().origin, updateRecoveryCapture: capture } },
      { env },
    );
    const retained = readUpdateRunRecord(ownedDatabase(), record().runId)!;
    // Directly returning the internal row breaks the closed wire contract and reveals private paths.
    expect(Value.Check(WireRunSchema, retained)).toBe(false);
    const output = toPublicUpdateRun(retained);
    expect(Value.Check(WireRunSchema, output)).toBe(true);
    expect(output.origin).toEqual(record().origin);
    expect(JSON.stringify(output)).not.toContain(root);
    expect(retained.origin.updateRecoveryCapture).toEqual(capture);
    expect(
      readUpdateRunRecord(ownedDatabase(), record().runId)?.origin.updateRecoveryCapture,
    ).toEqual(capture);
  });

  it("keeps an existing capture when a main consumer updates unrelated run progress", () => {
    const capture = receipt();
    // A stored receipt from the capture producer must survive later ledger mutations.
    ownedDatabase()
      .prepare("UPDATE update_runs SET origin_json=? WHERE run_id=?")
      .run(JSON.stringify({ ...record().origin, updateRecoveryCapture: capture }), record().runId);
    const updated = mutateRunInTransaction(
      ownedDatabase(),
      record().runId,
      (run) => {
        run.reason = "retained recovery still pending";
      },
      { env },
    );
    expect(updated.reason).toBe("retained recovery still pending");
    expect(updated.origin.updateRecoveryCapture).toEqual(capture);
    expect(
      readUpdateRunRecord(ownedDatabase(), record().runId)?.origin.updateRecoveryCapture,
    ).toEqual(capture);
  });

  it.each(["retirement", "forward"] as const)(
    "retains %s resolution without changing the failed-run outcome",
    (mode) => {
      const capture = receipt();
      const resolution =
        mode === "retirement"
          ? {
              restored: true as const,
              retirement: {
                directory: root,
                installRoot: root,
                stateDir: env.OPENCLAW_STATE_DIR!,
                configPath: env.OPENCLAW_CONFIG_PATH!,
                identity: { dev: 1, ino: 2, birthtimeMs: 3 },
                outcome: "restored" as const,
                generations: [
                  {
                    kind: "candidate" as const,
                    manifestSha256: "d".repeat(64),
                    identity: { dev: 4, ino: 5, birthtimeMs: 6 },
                  },
                ],
              },
            }
          : {
              forwardResolution: {
                kind: "forward-resolved" as const,
                binding: {
                  runId: record().runId,
                  failedAtMs: 2,
                  manifestSha256: capture.manifestSha256,
                  candidateSha256: "d".repeat(64),
                  preparedSha256: null,
                  installRoot: root,
                  stateDir: env.OPENCLAW_STATE_DIR!,
                  configPath: env.OPENCLAW_CONFIG_PATH!,
                  incompleteGenerations: { candidate: "e".repeat(64) },
                },
                repair: {
                  root,
                  packageSha256: "f".repeat(64),
                  node: path.join(root, "node"),
                  nodeVersion: "24.20.0",
                  build: "fixture",
                  artifact: {
                    rootIdentity: "fixture-root",
                    module: path.join(root, "module.mjs"),
                    entry: path.join(root, "entry.mjs"),
                    inventorySha256: "1".repeat(64),
                    executableIdentity: "fixture-executable",
                    executableSha256: "2".repeat(64),
                  },
                },
                completedAtMs: 3,
              },
            };
      const retained = { ...capture, ...resolution };
      persistRun(
        ownedDatabase(),
        { ...record(), origin: { updateRecoveryCapture: retained } },
        { env },
      );
      const recovered = readUpdateRunRecord(ownedDatabase(), record().runId);
      expect(recovered?.origin.updateRecoveryCapture).toEqual(retained);
      expect(recovered?.status).toBe("failed");
      expect(recovered?.finishedAtMs).toBe(2);
    },
  );

  it("bounds disposable diagnostics without shrinking operational receipts", () => {
    const capture = receipt();
    const diagnostics = {
      sessionKey: "s".repeat(20_000),
      doctorHint: "d".repeat(20_000),
      nextAction: "n".repeat(20_000),
      requester: {
        channel: "c".repeat(20_000),
        accountId: "a".repeat(20_000),
        senderId: "i".repeat(20_000),
        authorizationSource: "o".repeat(20_000),
      },
    };
    const input = {
      ...record(),
      origin: { ...record().origin, ...diagnostics, updateRecoveryCapture: capture },
    };
    expect(Buffer.byteLength(JSON.stringify(input.origin))).toBeGreaterThan(16 * 1024);
    persistRun(ownedDatabase(), input, { env });
    const row = storedRow();
    expect(typeof row?.origin_json).toBe("string");
    expect(Buffer.byteLength(String(row?.origin_json))).toBeLessThanOrEqual(16 * 1024);
    expect(readUpdateRunRecord(ownedDatabase(), input.runId)?.origin.updateRecoveryCapture).toEqual(
      capture,
    );
  });

  it.each([0, 1])("preserves receipts with only %i bytes left for diagnostics", (remaining) => {
    const capture = receipt();
    const driver = record().origin.driver;
    const size = Buffer.byteLength(JSON.stringify({ driver, updateRecoveryCapture: capture }));
    capture.warnings[0]!.message += "w".repeat(16 * 1024 - remaining - size);
    persistRun(
      ownedDatabase(),
      { ...record(), origin: { driver, updateRecoveryCapture: capture, nextAction: "diagnostic" } },
      { env },
    );
    const row = storedRow();
    expect(Buffer.byteLength(String(row?.origin_json))).toBe(16 * 1024 - remaining);
    const recovered = readUpdateRunRecord(ownedDatabase(), record().runId);
    expect(recovered?.origin.updateRecoveryCapture).toEqual(capture);
    expect(recovered?.origin.driver).toEqual(driver);
    expect(recovered?.origin.nextAction).toBeUndefined();
  });

  it("refuses an oversized receipt without replacing the persisted row", () => {
    const capture = receipt();
    capture.configWrites = Array.from({ length: 40 }, (_, index) => ({
      ...capture.configWrites[0]!,
      path: path.join(root, "state", `${index}-${"x".repeat(600)}.json`),
    }));
    const before = storedRow();
    expect(() =>
      persistRun(
        ownedDatabase(),
        { ...record(), origin: { updateRecoveryCapture: capture } },
        { env },
      ),
    ).toThrow(/recovery receipts exceed the origin byte limit/);
    expect(storedRow()).toEqual(before);
  });

  it.each(["hash", "path"] as const)(
    "rejects a malformed receipt %s without changing the stored row",
    (field) => {
      const capture = receipt();
      if (field === "hash") {
        capture.manifestSha256 = "not-a-hash";
      } else {
        capture.configWrites[0]!.path = "../unowned.json";
      }
      const before = storedRow();
      expect(() =>
        persistRun(
          ownedDatabase(),
          { ...record(), origin: { updateRecoveryCapture: capture } },
          { env },
        ),
      ).toThrow();
      expect(storedRow()).toEqual(before);
    },
  );
});
