import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { Value } from "typebox/value";
import { afterEach, beforeEach, expect, it } from "vitest";
import { z } from "zod";
import { UpdateRunRecordSchema as WireRunSchema } from "../../packages/gateway-protocol/src/schema/update-runs.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "./node-sqlite.js";
import { encodeRun } from "./update-run-codec.js";
import { readUpdateRunRecord } from "./update-run-read.kernel.js";
import { toPublicUpdateRun, type UpdateRunRecord } from "./update-run-record.js";
import { createUpdateRunRecordFixture } from "./update-run-record.test-support.js";
import {
  mutateRunInTransaction,
  persistRun,
  updateRunLedgerSchema,
  upsertStep,
} from "./update-run-write.js";

let root: string;
let database: DatabaseSync | undefined;
let env: NodeJS.ProcessEnv;
const runId = "00000000-0000-4000-8000-000000000001";

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

function db(): DatabaseSync {
  if (!database || fsSync.realpathSync(root) !== root || !fsSync.lstatSync(root).isDirectory()) {
    throw new Error("Receipt fixture requires its physically private database root");
  }
  return database;
}

const record = (overrides: Partial<UpdateRunRecord> = {}): UpdateRunRecord =>
  createUpdateRunRecordFixture(runId, {
    reason: "candidate failed",
    origin: { driver: { host: "fixture", pid: 41, startIdentity: "1" } },
    target: { kind: "package" },
    ...overrides,
  });

const receipt = () =>
  ({
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
      { kind: "undeclared-migration-resources", pluginId: "legacy", message: "undeclared" },
    ],
    status: "restore-failed",
    error: `Retained capture at ${root}`,
  }) satisfies NonNullable<UpdateRunRecord["origin"]["updateRecoveryCapture"]>;

const storedRow = () => db().prepare("SELECT * FROM update_runs WHERE run_id=?").get(runId);

function reopen() {
  db().close();
  database = new (requireNodeSqlite().DatabaseSync)(path.join(root, "state", "receipts.sqlite"));
}

const read = () => expectDefined(readUpdateRunRecord(db(), runId), "persisted update run");

const persist = (input: UpdateRunRecord) => persistRun(db(), input, { env });

const mutate = (update: (run: UpdateRunRecord) => void) =>
  mutateRunInTransaction(db(), runId, update, { env });

function addDiagnostics(run: UpdateRunRecord, count: number, prefix: string, detail: string) {
  for (let index = 0; index < count; index++) {
    upsertStep(run, { step: `${prefix}:${index}`, status: "completed", detail });
  }
}

beforeEach(async () => {
  root = await fs.realpath(tempDirs.make("update-receipts-"));
  const stateDir = path.join(root, "state");
  await fs.mkdir(stateDir, { mode: 0o700 });
  expect(await fs.realpath(stateDir)).toBe(stateDir);
  env = {
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
  };
  database = new (requireNodeSqlite().DatabaseSync)(path.join(stateDir, "receipts.sqlite"));
  db().exec(updateRunLedgerSchema);
  const row = encodeRun(record(), { env });
  const columns = Object.keys(row);
  db()
    .prepare(
      `INSERT INTO update_runs (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    )
    .run(...Object.values(row));
});

it("retains named risk through 10.2/10.3-compatible compaction and reopen", () => {
  const dataAtRisk = "unreadable-state";
  const recovery = {
    serviceRestartSafe: false,
    reason: "runtime-verification-failed",
    packageRollbackVerified: false,
    dataAtRisk,
  } as const;
  const input = record({ verification: { recovery } });
  addDiagnostics(input, 120, "finalize:fixture", "diagnostic ".repeat(45));
  persist(input);
  const row = storedRow();
  // Shipped readers reject new recovery fields; this fixture uses one historical reason.
  const shippedVerification = z.object({
    recovery: z.strictObject({
      serviceRestartSafe: z.literal(false),
      packageRollbackVerified: z.boolean().optional(),
      reason: z.literal("runtime-verification-failed"),
    }),
  });
  const { dataAtRisk: _risk, ...publicRecovery } = recovery;
  expect(shippedVerification.parse(JSON.parse(String(row?.verification_json)))).toEqual({
    recovery: publicRecovery,
  });
  const fact = z.object({ check: z.string().max(128), code: z.string().max(80) });
  const facts = z.array(fact).max(5).optional();
  const shippedSteps = z.array(z.object({ failureFacts: facts })).max(128);
  expect(shippedSteps.parse(JSON.parse(String(row?.steps_json)))).toContainEqual({
    failureFacts: [{ check: "update-recovery", code: dataAtRisk }],
  });
  expect(Buffer.byteLength(String(row?.steps_json))).toBeLessThanOrEqual(16 * 1024);
  reopen();
  const recovered = read();
  const published = toPublicUpdateRun(recovered);
  expect(Value.Check(WireRunSchema, published)).toBe(true);
  expect(published).toEqual({ ...recovered, verification: { recovery: publicRecovery } });
  expect(recovered.verification.recovery).toEqual(recovery);
  mutate((run) => {
    run.verification.recovery = { serviceRestartSafe: true, version: "2026.10.3" };
  });
  const repaired = mutate((run) => {
    run.verification.recovery = {
      serviceRestartSafe: false,
      reason: "runtime-verification-failed",
    };
  });
  expect(repaired.verification.recovery).not.toHaveProperty("dataAtRisk");
});

it("retains database recovery locations after diagnostic eviction", () => {
  const summaries = [
    ["database snapshot", "Databases snapshotted at /backup.databases"],
    [
      "database migration writes",
      `Post-migration write inventory: 100 databases; SHA-256 ${"e".repeat(64)}. Snapshots: /backup.databases.`,
    ],
    ["database rollback", "Restored databases; migrated originals retained beside their paths"],
  ].map(([name, detail]) => ({
    step: `diagnostic:${name}`,
    status: "completed" as const,
    detail,
  }));
  mutate((run) => {
    for (const summary of summaries) {
      upsertStep(run, summary);
    }
    addDiagnostics(run, 150, "diagnostic", "validation detail ".repeat(50));
  });
  reopen();
  const recovered = read();
  expect(recovered.steps).toEqual(expect.arrayContaining(summaries));
  expect(recovered.steps.length).toBeLessThanOrEqual(128);
  expect(Buffer.byteLength(JSON.stringify(recovered.steps))).toBeLessThanOrEqual(16 * 1024);
});

it.each(["retirement", "forward"] as const)(
  "preserves %s evidence through persistence, public export and progress updates",
  (mode) => {
    const capture = receipt();
    const location = {
      installRoot: root,
      stateDir: env.OPENCLAW_STATE_DIR!,
      configPath: env.OPENCLAW_CONFIG_PATH!,
    };
    const resolution =
      mode === "retirement"
        ? {
            restored: true as const,
            retirement: {
              directory: root,
              ...location,
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
                runId,
                failedAtMs: 2,
                manifestSha256: capture.manifestSha256,
                candidateSha256: "d".repeat(64),
                preparedSha256: null,
                ...location,
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
    const input = record({
      reason: `Failure at ${root}`,
      origin: { ...record().origin, updateRecoveryCapture: retained },
    });
    persist(input);
    reopen();
    const recovered = read();
    expect(recovered.origin).toEqual({ ...record().origin, updateRecoveryCapture: retained });
    expect(recovered).toMatchObject({ status: "failed", finishedAtMs: 2 });
    expect(recovered.updatedAtMs).toBeGreaterThan(2);
    expect(recovered.reason).not.toContain(root);
    expect(recovered.reason).toContain("~");
    expect(Value.Check(WireRunSchema, recovered)).toBe(false);
    const output = toPublicUpdateRun(recovered);
    expect(Value.Check(WireRunSchema, output)).toBe(true);
    expect(output).toEqual({ ...recovered, origin: record().origin });
    expect(JSON.stringify(output)).not.toContain(root);
    expect(recovered.origin.updateRecoveryCapture).toEqual(retained);
    const updated = mutate((run) => {
      run.reason = "retained recovery still pending";
    });
    expect(updated.reason).toBe("retained recovery still pending");
    expect(updated.origin.updateRecoveryCapture).toEqual(retained);
    expect(read().origin.updateRecoveryCapture).toEqual(retained);
  },
);

it.each(["hash", "path", "oversized"] as const)(
  "rejects a malformed receipt %s without changing the stored row",
  (field) => {
    const capture = receipt();
    if (field === "hash") {
      capture.manifestSha256 = "not-a-hash";
    } else if (field === "path") {
      capture.configWrites[0]!.path = "../unowned.json";
    } else {
      capture.configWrites = Array.from({ length: 40 }, (_, index) => ({
        ...capture.configWrites[0]!,
        path: path.join(root, "state", `${index}-${"x".repeat(600)}.json`),
      }));
    }
    const before = storedRow();
    expect(() => persist(record({ origin: { updateRecoveryCapture: capture } }))).toThrow(
      field === "oversized" ? /recovery receipts exceed the origin byte limit/ : undefined,
    );
    expect(storedRow()).toEqual(before);
  },
);
