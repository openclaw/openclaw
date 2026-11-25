import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runExistingOpenClawStateWriteTransaction } from "../state/openclaw-state-db-existing-write.js";
import * as handles from "../state/openclaw-state-db-handle.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
import { retainedCheckpointBinding } from "./update-retained-checkpoint.test-support.js";
import {
  createRetainedUpdateRecovery,
  storeRetainedUpdateRecovery,
  retainedReadinessRecord,
  retainedTerminalRecord,
} from "./update-retained-recovery.test-support.js";
import {
  createUpdateRun,
  finishUpdateRun,
  finishInterruptedUpdatePreview,
  getUpdateRun,
  recordUpdateRunPhase,
} from "./update-run-ledger.js";
import { legacyRecord } from "./update-run-recovery-legacy.test-support.js";
import {
  decodeUpdateRecovery,
  inspectUpdateRecovery,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import { readRecovery } from "./update-run-recovery-store.js";
import {
  assertNoPendingUpdateRecovery,
  inspectUpdateRecoveries,
  loadUpdateRecovery,
  UpdateRecoveryRequiredError,
} from "./update-run-recovery.js";
import { captureCompletedUpdateRun } from "./update-run-terminal-record.js";
import { updateRunLedgerSchema } from "./update-run-write.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
function setup(transform: (record: UpdateRecoveryRecord) => UpdateRecoveryRecord = (r) => r) {
  const root = dirs.make("retained-recovery-");
  const options = { env: { HOME: root, OPENCLAW_STATE_DIR: root } };
  const run = createUpdateRun({ trigger: "cli" }, options);
  const from = {
    root: path.join(root, "old"),
    nodePath: process.execPath,
    version: "1.0.0",
    buildId: "old-build",
  };
  const to = { ...from, root: path.join(root, "new"), version: "2.0.0", buildId: "new-build" };
  let record = createRetainedUpdateRecovery({ runId: run.runId, from, to }, options);
  record.checkpoint = retainedCheckpointBinding(record);
  record = storeRetainedUpdateRecovery(record, options);
  return { root, options, run, from, to, original: record, record: transform(record) };
}
function snapshot(root: string): unknown {
  return fs
    .readdirSync(root)
    .toSorted()
    .map((name) => {
      const file = path.join(root, name);
      const stat = fs.lstatSync(file);
      const { ino, mtimeMs: mtime, ctimeMs: ctime } = stat;
      const content = stat.isDirectory()
        ? snapshot(file)
        : createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      return { name, ino, mtime, ctime, content };
    });
}
function decode(record: UpdateRecoveryRecord) {
  return decodeUpdateRecovery(JSON.stringify(record), record.runId);
}
type Mutation<K extends keyof UpdateRecoveryRecord> = [
  string,
  (value: NonNullable<UpdateRecoveryRecord[K]>) => void,
];
function storeRaw(f: Pick<ReturnType<typeof setup>, "options">, record: { runId: string }) {
  const raw = JSON.stringify(record, null, 2);
  openOpenClawStateDatabase(f.options)
    .db.prepare("UPDATE config_machine_state SET value_json=? WHERE state_key=?")
    .run(raw, "update.recovery." + record.runId);
  return raw;
}
function closedSnapshot(f: Pick<ReturnType<typeof setup>, "root">) {
  closeOpenClawStateDatabaseForTest();
  return snapshot(f.root);
}
function nativeRecord(record: UpdateRecoveryRecord): UpdateRecoveryRecord {
  const preimages = { ...retainedCheckpointBinding(record), boundAtRevision: 0 };
  const next = { ...record, preimages };
  delete next.checkpoint;
  next.nativeManager = {
    identity: {
      ...record.source!,
      platform: "linux",
      scope: "user",
      uid: 1000,
      unitName: "openclaw.service",
      runId: record.runId,
      profile: record.source!.profile!,
    },
    original: { exists: true, enabled: true, loaded: true, stopped: false },
    boundAtRevision: 0,
    effects: [],
  };
  return next;
}

type Effect = UpdateRecoveryRecord["effects"][number];
function pendingEffect(kind: Effect["kind"], resourceId: string, effectId = randomUUID()): Effect {
  return {
    effectId,
    kind,
    resourceId,
    runtime: "candidate",
    state: "intent",
    observedIdentity: null,
  };
}
type NativeEffect = NonNullable<UpdateRecoveryRecord["nativeManager"]>["effects"][number];
function observedNativeEffect(
  action: NativeEffect["action"],
  before: NativeEffect["before"],
  after: NativeEffect["after"],
  intentRevision: number,
): NativeEffect {
  const effectId = randomUUID(),
    state = "observed",
    observedRevision = intentRevision + 1;
  return { effectId, action, before, after, state, intentRevision, observedRevision };
}

describe("retained recovery read-only compatibility", () => {
  it("requires native restoration before preparation settles", () => {
    const { record, ...f } = setup(nativeRecord);
    record.claimKind = "recovery";
    record.revision = 4;
    record.package = retainedTerminalRecord(f.original).package!;
    record.package.descriptor.retention = null;
    Object.assign(record.package.observed.observation, { previous: "live", candidate: "staged" });
    record.primaryFailure = { code: "interrupted-preparation", effectId: null };
    record.preparationAborted = {
      reason: "interrupted-preparation",
      committedAtMs: record.updatedAtMs,
      commitRevision: record.revision,
      observedIdentity: record.package.observed.observedIdentity,
    };
    expect(decode(record)).toEqual(record);

    const native = record.nativeManager!;
    const stopped = { ...native.original, stopped: true };
    native.effects = [
      observedNativeEffect("stop", native.original, stopped, 1),
      observedNativeEffect("restore", stopped, native.original, 3),
    ];
    expect(decode(record)).toEqual(record);

    const restore = native.effects[1]!;
    restore.state = "intent";
    delete restore.observedRevision;
    const settlementError = "Preparation settlement cannot carry effects or serving authority";
    expect(() => decode(record)).toThrow(settlementError);
    native.effects.pop();
    expect(() => decode(record)).toThrow(settlementError);
  });

  it("reopens private candidate proof without exposing it in history", () => {
    const { record, ...f } = setup(retainedReadinessRecord);
    storeRetainedUpdateRecovery(record, f.options);
    const before = closedSnapshot(f);
    expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(record);
    expect(snapshot(f.root)).toEqual(before);
    expect(JSON.stringify(getUpdateRun(f.run.runId, f.options))).not.toContain("retained-boot");
  });

  it.each([
    ["run", (r) => Object.assign(r.receipt, { runId: randomUUID() })],
    ["version", (r) => Object.assign(r.receipt.gateway, { version: "3.0.0" })],
    ["build", (r) => Object.assign(r.receipt.gateway, { buildId: null })],
    ["boot", (r) => Object.assign(r.receipt.gateway, { bootId: "other-boot" })],
    ["runtime", (r) => Object.assign(r, { runtime: "previous" })],
    ["transaction", (r) => Object.assign(r.receipt, { transactionId: randomUUID() })],
    ["claim", (r) => Object.assign(r.receipt, { claimId: randomUUID() })],
    ["revision", (r) => Object.assign(r.receipt, { revision: r.receipt.revision + 1 })],
    ["effect", (r) => Object.assign(r.receipt, { effectId: randomUUID() })],
  ] satisfies Mutation<"verification">[])("rejects mismatched readiness: %s", (_, mutate) => {
    const { record, ...f } = setup(retainedReadinessRecord);
    mutate(record.verification!);
    expect(() => decode(record)).toThrow();
    expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(f.original);
  });
  it("refuses incomplete retained service evidence", () => {
    const { record, ...f } = setup(retainedReadinessRecord);
    for (const value of [false, undefined]) {
      Object.assign(record.verification!.receipt.checks, { serviceRunning: value });
      expect(() => decode(record)).toThrow();
      expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(f.original);
    }
  });

  it("inspects legacy receipts without writes or admission", () => {
    const { record, ...f } = setup(retainedReadinessRecord);
    const raw = storeRaw(f, legacyRecord(record));
    const before = closedSnapshot(f);
    const inspected = inspectUpdateRecoveries(f.options);
    expect(inspected).toEqual([{ format: "legacy-serving", raw, record: JSON.parse(raw) }]);
    expect(() => loadUpdateRecovery(record.runId, f.options)).toThrow(/legacy.*readiness/i);
    expect(() => assertNoPendingUpdateRecovery(f.options)).toThrow(/legacy.*readiness/i);
    expect(snapshot(f.root)).toEqual(before);
    expect(inspectUpdateRecovery(raw, record.runId)).toEqual(inspected[0]);
    expect(() => decodeUpdateRecovery(raw, record.runId)).toThrow(/legacy.*readiness/i);
    const corrupt = JSON.parse(raw);
    corrupt.verification.receipt.transcript.assistant.seq = 0;
    expect(() => inspectUpdateRecovery(JSON.stringify(corrupt), record.runId)).toThrow();
    const stale = JSON.parse(raw);
    stale.effects.push({
      ...record.effects.at(-1),
      effectId: randomUUID(),
      observedIdentity: "later-boot",
    });
    expect(() => inspectUpdateRecovery(JSON.stringify(stale), record.runId)).toThrow();
    corrupt.verification.receipt = { ...JSON.parse(raw).verification.receipt, kind: "readiness" };
    expect(() => inspectUpdateRecovery(JSON.stringify(corrupt), record.runId)).toThrow();
    expect(() => inspectUpdateRecovery(raw, randomUUID())).toThrow("history run");
    expect(JSON.stringify(decode(f.original))).toBe(JSON.stringify(f.original));
  });
  it("admits terminal legacy history without execution authority", () => {
    const f = setup();
    const record = legacyRecord(retainedTerminalRecord(f.record, false));
    const raw = storeRaw(f, record);
    const before = closedSnapshot(f);
    expect(() => assertNoPendingUpdateRecovery(f.options)).not.toThrow();
    expect(() => loadUpdateRecovery(record.runId, f.options)).toThrow(/legacy.*readiness/i);
    expect(inspectUpdateRecoveries(f.options)[0]?.raw).toBe(raw);
    expect(snapshot(f.root)).toEqual(before);
    const preview = createUpdateRun({ trigger: "cli" }, f.options);
    finishInterruptedUpdatePreview(preview, f.options);
    expect(getUpdateRun(preview.runId, f.options)?.status).toBe("skipped");
    const next = createUpdateRun({ trigger: "cli" }, f.options);
    finishUpdateRun(next.runId, { status: "succeeded" }, f.options);
    expect(loadUpdateRecovery(next.runId, f.options)).toBeUndefined();
    expect(captureCompletedUpdateRun(next.runId, () => {}, f.options)?.runId).toBe(next.runId);
    expect(inspectUpdateRecoveries(f.options)[0]?.raw).toBe(raw);
  });

  it("keeps missing-state reads non-creating", () => {
    const root = dirs.make("retained-empty-");
    const options = { env: { OPENCLAW_STATE_DIR: root } };
    expect(loadUpdateRecovery("missing-run", options)).toBeUndefined();
    expect(inspectUpdateRecoveries(options)).toEqual([]);
    expect(() => assertNoPendingUpdateRecovery(options)).not.toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("reads only the named recovery payload regardless of unrelated history", () => {
    const f = setup();
    const db = requireNativeSqliteDatabase(openOpenClawStateDatabase(f.options).db);
    const raw = JSON.stringify(f.record);
    const selectedBytes =
      Buffer.byteLength(raw) + Buffer.byteLength("update.recovery." + f.run.runId);
    db.prepare("UPDATE config_machine_state SET value_json=? WHERE state_key=?").run(
      raw,
      "update.recovery." + f.run.runId,
    );
    const insert = db.prepare(
      "INSERT INTO config_machine_state (state_key,value_json,updated_at_ms) VALUES (?,?,0)",
    );
    for (let i = 0; i < 32; i++) {
      insert.run(`update.recovery.unrelated-${i}`, "invalid:" + "x".repeat(8192));
    }
    const counter = trackSqliteStatementExecutions(db, ["recovery"], (sql) =>
      /^select .* from "config_machine_state"/i.test(sql) ? "recovery" : null,
    );
    try {
      expect(readRecovery(db, f.run.runId)).toEqual(f.record);
      expect(counter.counts.recovery).toBe(1);
      expect(counter.rowCounts.recovery).toBe(1);
      expect(counter.textBytes.recovery).toBe(selectedBytes);
      expect(readRecovery(db, "missing-run")).toBeUndefined();
      expect(counter.counts.recovery).toBe(2);
      expect(counter.rowCounts.recovery).toBe(1);
      expect(counter.textBytes.recovery).toBe(selectedBytes);
    } finally {
      counter.restore();
    }
  });
  it.each(["intent", "completed"] as const)("preserves %s package effects", (outcome) => {
    const f = setup();
    const packageState = retainedTerminalRecord(f.record).package!;
    packageState.descriptor.retention = null;
    const effectId = randomUUID();
    const effect = pendingEffect("package-activation", packageState.descriptor.liveRoot, effectId);
    if (outcome === "completed") {
      effect.state = "observed";
      effect.observedIdentity = packageState.observed.observedIdentity;
    }
    effect.package = {
      intent: { effectId, action: "activate", descriptor: packageState.descriptor },
      ...(outcome === "intent" ? {} : { observed: packageState.observed, outcome }),
    };
    const record = { ...f.record, package: packageState, effects: [effect] };
    const raw = storeRaw(f, record);
    const before = closedSnapshot(f);
    expect(loadUpdateRecovery(record.runId, f.options)).toEqual(record);
    expect(inspectUpdateRecoveries(f.options)).toEqual([{ format: "current", raw, record }]);
    expect(() => assertNoPendingUpdateRecovery(f.options)).toThrow(UpdateRecoveryRequiredError);
    expect(snapshot(f.root)).toEqual(before);
  });
  it.each([
    "cleanup",
    "untyped-retirement",
    "restore-disguised-as-retirement",
    "package-restore",
    "restore-progress",
  ] as const)("distinguishes terminal cleanup from unfinished %s", (scenario) => {
    const { record, ...f } = setup(retainedTerminalRecord);
    const effectId = randomUUID();
    if (scenario === "restore-progress") {
      record.restore = {
        restoreId: randomUUID(),
        checkpointId: record.checkpoint!.ref.checkpointId,
        planPath: path.join(f.root, "restore-plan.sqlite"),
        planSha256: "d".repeat(64),
        resourceCursor: 0,
        phase: "intent",
      };
    } else {
      const kind = scenario === "package-restore" ? scenario : "retirement";
      const descriptor = record.package!.descriptor;
      const effect = pendingEffect(kind, descriptor.backupRoot, effectId);
      if (scenario !== "untyped-retirement") {
        const action = scenario === "cleanup" ? "retire" : "restore";
        effect.package = { intent: { effectId, action, descriptor } };
      }
      record.effects.push(effect);
    }
    storeRetainedUpdateRecovery(record, f.options);
    const before = closedSnapshot(f);
    if (scenario === "cleanup") {
      expect(() => assertNoPendingUpdateRecovery(f.options)).not.toThrow();
    } else {
      expect(() => assertNoPendingUpdateRecovery(f.options)).toThrow(UpdateRecoveryRequiredError);
    }
    expect(snapshot(f.root)).toEqual(before);
  });
  it.each(["version", "backup-path"] as const)("rejects invalid %s descriptors", (mismatch) => {
    const { record, ...f } = setup(retainedTerminalRecord);
    Object.assign(
      record.package!.descriptor,
      mismatch === "version"
        ? { version: 2 }
        : { backupRoot: path.join(f.root, "outside-package-parent") },
    );
    storeRaw(f, record);
    const before = closedSnapshot(f);
    expect(() => loadUpdateRecovery(record.runId, f.options)).toThrow();
    expect(() => inspectUpdateRecoveries(f.options)).toThrow();
    expect(() => assertNoPendingUpdateRecovery(f.options)).toThrow();
    expect(snapshot(f.root)).toEqual(before);
  });
  it.each([
    ["run", (n) => Object.assign(n.identity, { runId: randomUUID() })],
    ["state", (n) => Object.assign(n.identity, { stateDir: "/other-state" })],
    ["config", (n) => Object.assign(n.identity, { configPath: "/other-config" })],
    ["profile", (n) => Object.assign(n.identity, { profile: "different" })],
    ["revision", (n) => Object.assign(n, { boundAtRevision: n.boundAtRevision + 1 })],
  ] satisfies Mutation<"nativeManager">[])(
    "rejects misbound retained native %s facts",
    (_, mutate) => {
      const { record } = setup(nativeRecord);
      mutate(record.nativeManager!);
      expect(() => decode(record)).toThrow();
    },
  );
  it.each([false, true])("inspects legacy terminal roles (rollback=%s)", (rollback) => {
    const { record } = setup((r) => retainedTerminalRecord(r, rollback));
    const legacy = legacyRecord(record);
    const raw = JSON.stringify(legacy, null, 2);
    expect(inspectUpdateRecovery(raw, record.runId)).toEqual({
      format: "legacy-serving",
      raw,
      record: legacy,
    });
    expect(() => decodeUpdateRecovery(raw, record.runId)).toThrow(/legacy.*readiness/i);
    for (const field of ["version", "buildId", "bootId"] as const) {
      const invalid = structuredClone(legacy);
      invalid.terminal!.receipt.gateway[field] = "wrong";
      expect(() => inspectUpdateRecovery(JSON.stringify(invalid), record.runId)).toThrow();
    }
    const wrongPair = structuredClone(legacy);
    wrongPair.terminal!.pairId = randomUUID();
    expect(() => inspectUpdateRecovery(JSON.stringify(wrongPair), record.runId)).toThrow();
    const wrongRole = structuredClone(legacy);
    wrongRole.effects.at(-1)!.runtime = rollback ? "candidate" : "previous";
    expect(() => inspectUpdateRecovery(JSON.stringify(wrongRole), record.runId)).toThrow();
  });
});

it.each([
  ["facts", (e) => Object.assign(e.reconciledStop!.facts, { stopped: false })],
  ["revision", (e) => Object.assign(e.reconciledStop!, { revision: e.intentRevision })],
  ["action", (e) => Object.assign(e, { action: "restore" })],
  ["original-after", (e) => Object.assign(e.after, { loaded: false })],
  ["missing-marker", (e) => Object.assign(e, { reconciledStop: undefined })],
  ["intent-marker", (e) => Object.assign(e, { state: "intent" })],
  ["missing-failure", (_, r) => Object.assign(r, { primaryFailure: null })],
] satisfies [string, (effect: NativeEffect, record: UpdateRecoveryRecord) => void][])(
  "rejects corrupt suppression reconciliation: %s",
  (_, mutate) => {
    const { record } = setup(nativeRecord);
    const native = record.nativeManager!;
    const running = native.original;
    const stopped = { ...running, stopped: true };
    const suppressed = { ...running, enabled: false };
    const restartId = randomUUID();
    native.effects = [
      observedNativeEffect("stop", running, stopped, 1),
      { ...observedNativeEffect("restore", stopped, running, 3), effectId: restartId },
      {
        effectId: randomUUID(),
        action: "suppress",
        before: running,
        after: suppressed,
        state: "reconciled",
        intentRevision: 5,
        reconciledStop: { facts: { ...suppressed, stopped: true }, revision: 6 },
      },
    ];
    record.revision = 6;
    record.checkpoint = retainedCheckpointBinding(record);
    record.primaryFailure = { code: "candidate-failed", effectId: restartId };
    record.effects = [pendingEffect("service-restart", "gateway", restartId)];
    expect(() => decode(record)).not.toThrow();
    const invalid = structuredClone(record);
    const effect = invalid.nativeManager!.effects.at(-1)!;
    mutate(effect, invalid);
    expect(() => decode(invalid)).toThrow();
  },
);
it("rejects not-applied effects without failure or with unchanged targets", () => {
  const { record } = setup(nativeRecord);
  const native = record.nativeManager!;
  const before = { ...native.original, stopped: true };
  // Keep the earlier stop and captured running target in the retained history.
  native.effects = [
    observedNativeEffect("stop", native.original, before, 1),
    { ...observedNativeEffect("restore", before, native.original, 3), state: "not-applied" },
  ];
  record.revision = 4;
  record.primaryFailure = { code: "failed-start", effectId: null };
  expect(() => decode(record)).not.toThrow();
  expect(() => decode({ ...record, primaryFailure: null })).toThrow();
  const impossible = structuredClone(record);
  impossible.nativeManager!.effects.at(-1)!.after = { ...before };
  expect(() => decode(impossible)).toThrow();
});
it.each([
  ["run", (e) => Object.assign(e.binding, { runId: randomUUID() })],
  ["state", (e) => Object.assign(e.binding, { stateDir: "/other-state" })],
  ["config", (e) => Object.assign(e.binding, { configPath: "/other-config" })],
  ["root", (e) => Object.assign(e.binding.fromRuntime, { root: "/other-root" })],
  ["node", (e) => Object.assign(e.binding.fromRuntime, { nodePath: "/other-node" })],
  ["version", (e) => Object.assign(e.binding.fromRuntime, { version: "0.0.0" })],
  ["revision", (e) => Object.assign(e, { boundAtRevision: e.boundAtRevision + 1 })],
] satisfies Mutation<"preimages">[])("rejects retained preimage misbinding: %s", (_, mutate) => {
  const { record } = setup(nativeRecord);
  delete record.nativeManager;
  const early = record.preimages!;
  expect(() => decode(record)).not.toThrow();
  mutate(early);
  expect(() => decode(record)).toThrow();
});
it("rejects early-file references reused as a full checkpoint", () => {
  const { record } = setup(nativeRecord);
  delete record.nativeManager;
  const early = record.preimages!;
  record.checkpoint = { ref: early.ref, binding: early.binding, preimageRef: early.ref };
  expect(() => decode(record)).toThrow();
});
it.each(["current", "legacy-serving"] as const)("inspects %s packages", (format) => {
  const f = setup();
  const terminal = (from: UpdateRecoveryRecord["from"], to = f.to, rollback = false) => {
    const runId = createUpdateRun({ trigger: "cli" }, f.options).runId;
    const record = createRetainedUpdateRecovery({ runId, from, to }, f.options);
    return retainedTerminalRecord(record, rollback);
  };
  const a = retainedTerminalRecord(f.record);
  const b = terminal(f.to, { ...f.to, version: "3.0.0" });
  a.retainedPair = { ...a.retainedPair!, state: "superseded", replacementRunId: b.runId };
  a.package!.descriptor.retention = {
    state: "superseded",
    pairId: a.retainedPair.pairId,
    ownerRevision: 4,
    replacement: {
      pairId: b.retainedPair!.pairId,
      transactionId: b.transactionId,
      live: b.package!.descriptor.candidate,
      retainedRoot: b.package!.descriptor.backupRoot,
      retained: b.package!.descriptor.previous!,
      launchers: [],
    },
  };
  a.package!.observed.descriptor = a.package!.descriptor;
  const c = terminal(f.from, f.to, true);
  const records = format === "legacy-serving" ? [a, b, c].map(legacyRecord) : [a, b, c];
  const raw = records.map((record) => storeRaw(f, record));
  const before = closedSnapshot(f);
  const inspected = inspectUpdateRecoveries(f.options);
  expect(inspected).toHaveLength(3);
  records.forEach((record, i) =>
    expect(inspected.find((entry) => entry.record.runId === record.runId)).toEqual({
      format,
      raw: raw[i],
      record,
    }),
  );
  expect(
    inspected
      .filter((entry) => entry.record.retainedPair?.state === "selected")
      .map((entry) => entry.record.runId),
  ).toEqual([b.runId]);
  if (format === "current") {
    records.forEach((record) =>
      expect(loadUpdateRecovery(record.runId, f.options)).toEqual(record),
    );
  } else {
    records.forEach((record) =>
      expect(() => loadUpdateRecovery(record.runId, f.options)).toThrow(/legacy.*readiness/i),
    );
  }
  expect(() => assertNoPendingUpdateRecovery(f.options)).not.toThrow();
  expect(snapshot(f.root)).toEqual(before);
});

function source() {
  const { options, run, record } = setup();
  record.handoff = { handoffId: randomUUID(), state: "prepared" };
  storeRetainedUpdateRecovery(record, options);
  const pathname = openOpenClawStateDatabase(options).path;
  closeOpenClawStateDatabaseForTest();
  using legacy = openNodeSqliteDatabase(pathname);
  // Older markers on current layout, not a v15 migration fixture.
  legacy.exec(`PRAGMA foreign_keys=OFF;
      PRAGMA user_version=15;
      UPDATE schema_meta SET schema_version=15 WHERE meta_key='primary';`);
  return { options, run, record, pathname };
}
function shape(pathname: string) {
  using db = openNodeSqliteDatabase(pathname, { readOnly: true });
  return {
    version: db.prepare("PRAGMA user_version").get(),
    schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
    metadata: db.prepare("SELECT * FROM schema_meta ORDER BY meta_key").all(),
    recovery: db
      .prepare(
        "SELECT value_json FROM config_machine_state WHERE state_key LIKE 'update.recovery.%'",
      )
      .get(),
  };
}
it("refuses existing-state writes while another connection holds the native transaction", () => {
  const f = source();
  const before = fs.readFileSync(f.pathname);
  using writer = openNodeSqliteDatabase(f.pathname);
  writer.exec("BEGIN IMMEDIATE");
  expect(() => probeExistingWriter(f, 0)).toThrow(/locked/);
  expect(fs.readFileSync(f.pathname)).toEqual(before);
  writer.exec("ROLLBACK");
});

it.each([
  [
    "future",
    "PRAGMA user_version=2147483647; UPDATE schema_meta SET schema_version=2147483647 WHERE meta_key='primary'",
  ],
  ["metadata", "UPDATE schema_meta SET schema_version=14 WHERE meta_key='primary'"],
  [
    "trigger",
    "CREATE TRIGGER unexpected_recovery_write AFTER UPDATE ON update_runs BEGIN UPDATE schema_meta SET app_version='unexpected'; END;",
  ],
])("refuses %s state without changing a retained handoff", (_scenario, sql) => {
  const f = source();
  {
    using db = openNodeSqliteDatabase(f.pathname);
    db.exec(sql);
  }
  const before = shape(f.pathname);
  expect(() => probeExistingWriter(f)).toThrow();
  expect(shape(f.pathname)).toEqual(before);
  expect(before.recovery).toBeDefined();
  expect(JSON.parse(String(before.recovery?.value_json))).toEqual(f.record);
});

it.each(["before admission", "before tracked open"])(
  "does not recreate state displaced %s",
  (when) => {
    const f = source();
    const before = shape(f.pathname);
    const open = handles.openTrackedStateDatabase;
    if (when === "before admission") {
      fs.renameSync(f.pathname, f.pathname + ".retained");
    }
    using _ =
      when === "before tracked open"
        ? vi.spyOn(handles, "openTrackedStateDatabase").mockImplementation((pathname, options) => {
            fs.renameSync(pathname, pathname + ".retained");
            return open(pathname, options);
          })
        : undefined;
    expect(() => probeExistingWriter(f)).toThrow();
    expect(fs.existsSync(f.pathname)).toBe(false);
    expect(shape(f.pathname + ".retained")).toEqual(before);
    expect(before.version).toEqual({ user_version: 15 });
  },
);

function probeExistingWriter(f: ReturnType<typeof source>, busyTimeoutMs?: number) {
  return runExistingOpenClawStateWriteTransaction(() => undefined, f.options, {
    schemaSql: updateRunLedgerSchema,
    operationLabel: "retained-test-owner",
    busyTimeoutMs,
  });
}
it("preserves the previous runtime schema during ledger bookkeeping", () => {
  const f = source();
  const before = shape(f.pathname);
  expect(recordUpdateRunPhase(f.run.runId, "verifying", {}, f.options).phase).toBe("verifying");
  closeOpenClawStateDatabaseForTest();
  expect(shape(f.pathname)).toEqual(before);
});
