import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
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
  getUpdateRun,
  recordUpdateRunStep,
} from "./update-run-ledger.js";
import { legacyRecord } from "./update-run-recovery-legacy.test-support.js";
import {
  decodeUpdateRecovery,
  inspectUpdateRecovery,
  type UpdateRecoveryRecord,
} from "./update-run-recovery-schema.js";
import {
  assertNoPendingUpdateRecovery,
  inspectUpdateRecoveries,
  loadUpdateRecovery,
  UpdateRecoveryRequiredError,
} from "./update-run-recovery.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => closeOpenClawStateDatabaseForTest());
function setup() {
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
  return { root, options, run, from, to, record };
}
function snapshot(root: string): unknown {
  return fs
    .readdirSync(root)
    .toSorted()
    .map((name) => {
      const file = path.join(root, name);
      const stat = fs.lstatSync(file);
      return {
        name,
        ino: stat.ino,
        mtime: stat.mtimeMs,
        ctime: stat.ctimeMs,
        content: stat.isDirectory()
          ? snapshot(file)
          : createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
      };
    });
}
function nativeRecord(record: UpdateRecoveryRecord): UpdateRecoveryRecord {
  const preimages = { ...retainedCheckpointBinding(record), boundAtRevision: 0 };
  const next = { ...record, preimages };
  delete next.checkpoint;
  next.nativeManager = {
    identity: {
      platform: "linux",
      scope: "user",
      uid: 1000,
      unitName: "openclaw.service",
      runId: record.runId,
      stateDir: record.source!.stateDir,
      configPath: record.source!.configPath,
      profile: record.source!.profile!,
    },
    original: { exists: true, enabled: true, loaded: true, stopped: false },
    boundAtRevision: 0,
    effects: [],
  };
  return next;
}

describe("retained recovery read-only compatibility", () => {
  it.each(["candidate", "previous"] as const)(
    "reopens private %s proof without exposing it in history",
    (runtime) => {
      const f = setup();
      const record = retainedReadinessRecord(f.record, runtime);
      storeRetainedUpdateRecovery(record, f.options);
      closeOpenClawStateDatabaseForTest();
      const before = snapshot(f.root);
      expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(record);
      expect(snapshot(f.root)).toEqual(before);
      expect(JSON.stringify(getUpdateRun(f.run.runId, f.options))).not.toContain("retained-boot");
    },
  );
  it.each([
    "run",
    "version",
    "build",
    "boot",
    "runtime",
    "transaction",
    "claim",
    "revision",
    "effect",
  ] as const)(
    "rejects retained readiness from a different %s without changing stored state",
    (mismatch) => {
      const f = setup();
      const record = retainedReadinessRecord(f.record);
      const receipt = record.verification!.receipt;
      if (mismatch === "run") {
        receipt.runId = randomUUID();
      }
      if (mismatch === "version") {
        receipt.gateway.version = "3.0.0";
      }
      if (mismatch === "build") {
        receipt.gateway.buildId = null;
      }
      if (mismatch === "boot") {
        receipt.gateway.bootId = "other-boot";
      }
      if (mismatch === "runtime") {
        record.verification!.runtime = "previous";
      }
      if (mismatch === "transaction") {
        receipt.transactionId = randomUUID();
      }
      if (mismatch === "claim") {
        receipt.claimId = randomUUID();
      }
      if (mismatch === "revision") {
        receipt.revision++;
      }
      if (mismatch === "effect") {
        receipt.effectId = randomUUID();
      }
      expect(() => decodeUpdateRecovery(JSON.stringify(record), record.runId)).toThrow();
      expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(f.record);
    },
  );
  it.each(["serviceRunning", "pluginsReady", "channelsReady", "settled", "readyz"] as const)(
    "refuses incomplete retained %s evidence",
    (check) => {
      const f = setup();
      const record = retainedReadinessRecord(f.record);
      for (const value of [false, undefined]) {
        const invalid = {
          ...record,
          verification: {
            ...record.verification,
            receipt: {
              ...record.verification!.receipt,
              checks: { ...record.verification!.receipt.checks, [check]: value },
            },
          },
        };
        expect(() => decodeUpdateRecovery(JSON.stringify(invalid), record.runId)).toThrow();
        expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(f.record);
      }
    },
  );
  it("inspects retained legacy transcript verification without rewriting or admitting work", () => {
    const f = setup();
    const record = retainedReadinessRecord(f.record);
    const raw = JSON.stringify(legacyRecord(record), null, 2);
    const db = openOpenClawStateDatabase(f.options).db;
    const key = "update.recovery." + record.runId;
    db.prepare("UPDATE config_machine_state SET value_json=? WHERE state_key=?").run(raw, key);
    closeOpenClawStateDatabaseForTest();
    const before = snapshot(f.root);
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
    expect(JSON.stringify(decodeUpdateRecovery(JSON.stringify(f.record), f.record.runId))).toBe(
      JSON.stringify(f.record),
    );
  });
  it("keeps missing-state reads non-creating", () => {
    const root = dirs.make("retained-empty-");
    const options = { env: { OPENCLAW_STATE_DIR: root } };
    expect(loadUpdateRecovery("missing-run", options)).toBeUndefined();
    expect(inspectUpdateRecoveries(options)).toEqual([]);
    expect(() => assertNoPendingUpdateRecovery(options)).not.toThrow();
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("reopens exact interrupted identity without writing database artifacts or exposing source paths", () => {
    const f = setup();
    const record = {
      ...f.record,
      primaryFailure: { code: "candidate-failed", effectId: null },
      effects: [
        {
          effectId: randomUUID(),
          kind: "package-activation" as const,
          resourceId: f.from.root,
          runtime: "candidate" as const,
          state: "intent" as const,
          observedIdentity: null,
        },
      ],
    };
    storeRetainedUpdateRecovery(record, f.options);
    recordUpdateRunStep(
      f.run.runId,
      { step: "private", status: "completed", detail: f.from.root },
      f.options,
    );
    closeOpenClawStateDatabaseForTest();
    const before = snapshot(f.root);
    expect(loadUpdateRecovery(record.runId, f.options)).toEqual(record);
    expect(() => assertNoPendingUpdateRecovery(f.options)).toThrow(UpdateRecoveryRequiredError);
    expect(snapshot(f.root)).toEqual(before);
    expect(JSON.stringify(getUpdateRun(record.runId, f.options))).not.toContain(f.from.root);
  });
  it("does not retire recovery through diagnostic terminal writes", () => {
    const f = setup();
    finishUpdateRun(f.run.runId, { status: "failed", reason: "interrupted" }, f.options);
    expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(f.record);
    expect(() => assertNoPendingUpdateRecovery(f.options)).toThrow(UpdateRecoveryRequiredError);
  });
  it("preserves schema, version and history during retained reads", () => {
    const f = setup();
    const db = openOpenClawStateDatabase(f.options).db;
    const schema = () => db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
    const before = schema();
    const version = db.prepare("PRAGMA user_version").get();
    const history = getUpdateRun(f.run.runId, f.options);
    expect(loadUpdateRecovery(f.run.runId, f.options)).toEqual(f.record);
    expect(schema()).toEqual(before);
    expect(db.prepare("PRAGMA user_version").get()).toEqual(version);
    expect(getUpdateRun(f.run.runId, f.options)).toEqual(history);
  });
  it("refuses corrupt records without erasing them or admitting new work", () => {
    const f = setup();
    const db = openOpenClawStateDatabase(f.options).db;
    const key = "update.recovery." + f.run.runId;
    db.prepare("UPDATE config_machine_state SET value_json=? WHERE state_key=?").run(
      '{"revision":1}',
      key,
    );
    expect(() => assertNoPendingUpdateRecovery(f.options)).toThrow();
    expect(
      db.prepare("SELECT value_json FROM config_machine_state WHERE state_key=?").get(key)
        ?.value_json,
    ).toBe('{"revision":1}');
  });
  it("requires a numeric user-manager UID and forbids it on system scope in retained records", () => {
    const f = setup();
    const record = nativeRecord(f.record);
    const identity = record.nativeManager!.identity;
    for (const uid of [undefined, null, "0", -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const invalid = {
        ...record,
        nativeManager: { ...record.nativeManager, identity: { ...identity, uid } },
      };
      expect(() => decodeUpdateRecovery(JSON.stringify(invalid), record.runId)).toThrow();
    }
    expect(() =>
      decodeUpdateRecovery(
        JSON.stringify({
          ...record,
          nativeManager: { ...record.nativeManager, identity: { ...identity, scope: "system" } },
        }),
        record.runId,
      ),
    ).toThrow();
    const { uid: _uid, ...withoutUid } = identity as typeof identity & { uid: number };
    expect(() =>
      decodeUpdateRecovery(
        JSON.stringify({
          ...record,
          nativeManager: { ...record.nativeManager, identity: { ...withoutUid, scope: "system" } },
        }),
        record.runId,
      ),
    ).not.toThrow();
  });
  it.each(["run", "state", "config", "profile", "revision"] as const)(
    "rejects misbound retained native %s facts",
    (mismatch) => {
      const f = setup();
      const record = nativeRecord(f.record);
      const native = record.nativeManager!;
      if (mismatch === "run") {
        native.identity.runId = randomUUID();
      }
      if (mismatch === "state") {
        native.identity.stateDir += "-different";
      }
      if (mismatch === "config") {
        native.identity.configPath += "-different";
      }
      if (mismatch === "profile") {
        native.identity.profile = "different";
      }
      if (mismatch === "revision") {
        native.boundAtRevision++;
      }
      expect(() => decodeUpdateRecovery(JSON.stringify(record), record.runId)).toThrow();
    },
  );
  it.each([false, true])(
    "inspects legacy terminal roles without granting readiness (rollback=%s)",
    (rollback) => {
      const f = setup();
      const record = retainedTerminalRecord(f.record, rollback);
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
    },
  );
});

// Retained decoder negatives migrated from the removed journal writer tests.
it.each([
  "facts",
  "revision",
  "action",
  "original-after",
  "missing-marker",
  "intent-marker",
  "missing-failure",
] as const)("rejects corrupt retained suppression reconciliation: %s", (change) => {
  const f = setup();
  const record = nativeRecord(f.record);
  const native = record.nativeManager!;
  const running = native.original;
  const stopped = { ...running, stopped: true };
  const suppressed = { ...running, enabled: false };
  const restartId = randomUUID();
  native.effects = [
    {
      effectId: randomUUID(),
      action: "stop",
      before: running,
      after: stopped,
      state: "observed",
      intentRevision: 1,
      observedRevision: 2,
    },
    {
      effectId: restartId,
      action: "restore",
      before: stopped,
      after: running,
      state: "observed",
      intentRevision: 3,
      observedRevision: 4,
    },
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
  record.effects = [
    {
      effectId: restartId,
      kind: "service-restart",
      runtime: "candidate",
      resourceId: "gateway",
      state: "intent",
      observedIdentity: null,
    },
  ];
  expect(() => decodeUpdateRecovery(JSON.stringify(record), record.runId)).not.toThrow();
  const invalid = structuredClone(record);
  const effect = invalid.nativeManager!.effects.at(-1)!;
  if (change === "facts") {
    effect.reconciledStop!.facts.stopped = false;
  }
  if (change === "revision") {
    effect.reconciledStop!.revision = effect.intentRevision;
  }
  if (change === "action") {
    effect.action = "restore";
  }
  if (change === "original-after") {
    effect.after.loaded = false;
  }
  if (change === "missing-marker") {
    effect.state = "reconciled";
    delete effect.reconciledStop;
  }
  if (change === "intent-marker") {
    effect.state = "intent";
  }
  if (change === "missing-failure") {
    invalid.primaryFailure = null;
  }
  expect(() => decodeUpdateRecovery(JSON.stringify(invalid), record.runId)).toThrow();
});
it("refuses a retained not-applied native effect without failure or with an unchanged target", () => {
  const f = setup();
  const record = nativeRecord(f.record);
  const native = record.nativeManager!;
  const before = { ...native.original, stopped: true };
  native.original = before;
  native.effects = [
    {
      effectId: randomUUID(),
      action: "restore",
      before,
      after: { ...before, stopped: false },
      state: "not-applied",
      intentRevision: 1,
      observedRevision: 2,
    },
  ];
  // Restoration target must equal the captured running job; keep the earlier stop in history.
  native.original = { ...before, stopped: false };
  native.effects.unshift({
    effectId: randomUUID(),
    action: "stop",
    before: native.original,
    after: before,
    state: "observed",
    intentRevision: 1,
    observedRevision: 2,
  });
  native.effects[1]!.intentRevision = 3;
  native.effects[1]!.observedRevision = 4;
  record.revision = 4;
  record.primaryFailure = { code: "failed-start", effectId: null };
  expect(() => decodeUpdateRecovery(JSON.stringify(record), record.runId)).not.toThrow();
  expect(() =>
    decodeUpdateRecovery(JSON.stringify({ ...record, primaryFailure: null }), record.runId),
  ).toThrow();
  const impossible = structuredClone(record);
  impossible.nativeManager!.effects.at(-1)!.after = { ...before };
  expect(() => decodeUpdateRecovery(JSON.stringify(impossible), record.runId)).toThrow();
});
it.each(["run", "state", "config", "root", "node", "version", "revision"] as const)(
  "rejects retained preimage misbinding: %s",
  (field) => {
    const f = setup();
    const record = nativeRecord(f.record);
    delete record.nativeManager;
    const early = record.preimages!;
    expect(() => decodeUpdateRecovery(JSON.stringify(record), record.runId)).not.toThrow();
    if (field === "run") {
      early.binding.runId = randomUUID();
    }
    if (field === "state") {
      early.binding.stateDir += "-other";
    }
    if (field === "config") {
      early.binding.configPath += "-other";
    }
    if (field === "root") {
      early.binding.fromRuntime.root += "-other";
    }
    if (field === "node") {
      early.binding.fromRuntime.nodePath += "-other";
    }
    if (field === "version") {
      early.binding.fromRuntime.version = "0.0.0";
    }
    if (field === "revision") {
      early.boundAtRevision++;
    }
    expect(() => decodeUpdateRecovery(JSON.stringify(record), record.runId)).toThrow();
  },
);
it("rejects early-file references reused as a full checkpoint", () => {
  const f = setup();
  const record = nativeRecord(f.record);
  delete record.nativeManager;
  const early = record.preimages!;
  record.checkpoint = { ref: early.ref, binding: early.binding, preimageRef: early.ref };
  expect(() => decodeUpdateRecovery(JSON.stringify(record), record.runId)).toThrow();
});
it("inspects selected and superseded legacy pairs byte-exactly without admitting work", () => {
  const f = setup();
  const nextRun = createUpdateRun({ trigger: "cli" }, f.options);
  const a = retainedTerminalRecord(f.record);
  const b = retainedTerminalRecord(
    createRetainedUpdateRecovery(
      { runId: nextRun.runId, from: f.to, to: { ...f.to, version: "3.0.0" } },
      f.options,
    ),
  );
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
  const records = [a, b].map(legacyRecord);
  const raw = records.map((record) => JSON.stringify(record, null, 2));
  const db = openOpenClawStateDatabase(f.options).db;
  records.forEach((record, i) =>
    db
      .prepare("UPDATE config_machine_state SET value_json=? WHERE state_key=?")
      .run(raw[i]!, "update.recovery." + record.runId),
  );
  closeOpenClawStateDatabaseForTest();
  const before = snapshot(f.root);
  const inspected = inspectUpdateRecoveries(f.options);
  expect(inspected).toHaveLength(2);
  records.forEach((record, i) =>
    expect(inspected.find((entry) => entry.record.runId === record.runId)).toEqual({
      format: "legacy-serving",
      raw: raw[i],
      record,
    }),
  );
  expect(
    inspected
      .filter((entry) => entry.record.retainedPair?.state === "selected")
      .map((entry) => entry.record.runId),
  ).toEqual([b.runId]);
  expect(() => assertNoPendingUpdateRecovery(f.options)).toThrow(/legacy.*readiness/i);
  expect(snapshot(f.root)).toEqual(before);
});
