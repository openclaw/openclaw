import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  fileIdentity as identity,
  immutableDescriptor,
  ownImmutableFixture,
  withDatabase,
} from "./package-update-activation-fixtures.test-support.js";
import {
  publishImmutablePointer,
  reconcileImmutablePointer,
} from "./package-update-activation-immutable-pointer.js";
import { readImmutableInstallRecordForRecovery } from "./package-update-activation-immutable-recovery.js";
import {
  createImmutableInstallRecord,
  immutableInstallReadOperations,
  recordImmutablePreparedGeneration,
  updateImmutableInstallRecord,
} from "./package-update-activation-immutable.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";
import {
  syntheticActivationCustody,
  syntheticImmutableProtection,
} from "./update-immutable-activation.test-support.js";
import { readImmutableInstallRecord } from "./update-immutable-install-record.js";
import type {
  ImmutableActivationOperation,
  ImmutableInstallDescriptor,
  ImmutableInstallRecord,
  ImmutablePreparedGeneration,
} from "./update-immutable-install-schema.js";
import { projectImmutableInstall } from "./update-immutable-install.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const sha = "a".repeat(40);
const candidateSha = "b".repeat(40);
let parent: string;
let root: string;
let descriptor: ImmutableInstallDescriptor;
let prepared: ImmutablePreparedGeneration;
const controlPath = () => resolvePackageActivationControl(resolvePackageActivationAnchor(root));
const journalPath = () => resolvePackageActivationJournalPath(resolvePackageActivationAnchor(root));
const currentPointer = () => path.join(root, "current");
const selectedRelease = () => fs.readlinkSync(currentPointer());
const adopt = (value = descriptor) => createImmutableInstallRecord(value, () => {});
const update = (
  record: ImmutableInstallRecord,
  change: Parameters<typeof updateImmutableInstallRecord>[1],
) => updateImmutableInstallRecord(record, change, () => {});
const prepare = (record: ImmutableInstallRecord, generation = prepared) =>
  recordImmutablePreparedGeneration(record, generation, () => {});
const publish = (record: ImmutableInstallRecord, target: "candidate" | "previous") =>
  publishImmutablePointer(record, target, () => {});
const reconcile = (record: ImmutableInstallRecord) => reconcileImmutablePointer(record, () => {});
function retentionDescriptor(
  pins: NonNullable<ImmutableInstallDescriptor["releaseRetention"]>["pins"] = [],
): ImmutableInstallDescriptor {
  return {
    ...descriptor,
    version: 3,
    activationEnabled: true,
    releaseRetention: { version: 1, mode: "inspect", keepVerifiedGenerations: 3, pins },
  };
}
const read = () =>
  immutableInstallReadOperations["immutableInstall.read"](
    { root },
    { path: journalPath(), env: process.env },
  );
const controlFiles = () =>
  fs
    .readdirSync(controlPath())
    .toSorted()
    .map((name) => {
      const file = path.join(controlPath(), name);
      const stat = fs.lstatSync(file, { bigint: true });
      return {
        name,
        identity: `${stat.dev}:${stat.ino}`,
        mode: stat.mode,
        mtime: stat.mtimeNs,
        bytes: fs.readFileSync(file),
      };
    });

beforeEach(() => {
  parent = fs.realpathSync(dirs.make("immutable-install-control-"));
  root = path.join(parent, "installation");
  const current = path.join(root, "releases", sha);
  const candidate = path.join(root, "releases", candidateSha);
  fs.mkdirSync(current, { recursive: true, mode: 0o755 });
  fs.mkdirSync(candidate, { mode: 0o755 });
  fs.symlinkSync(`releases/${sha}`, currentPointer());
  ownImmutableFixture(parent, true);
  descriptor = immutableDescriptor(root, sha, "1".repeat(64), {
    unit: "openclaw-fixture.service",
    scope: "system",
    account: "openclaw-fixture",
    stateDir: path.join(parent, "state"),
    configPath: path.join(parent, "state", "openclaw.json"),
    profile: null,
  });
  prepared = {
    sha: candidateSha,
    path: candidate,
    identity: identity(candidate),
    buildDigest: "2".repeat(64),
    preparedAtMs: 1234,
  };
});

afterEach(() => vi.restoreAllMocks());

function beginActivation(): ImmutableInstallRecord {
  const adopted = adopt();
  const custody = syntheticActivationCustody(descriptor, ["1:9", "1:10"]);
  custody.authority.owner = randomUUID();
  const operation: ImmutableActivationOperation = {
    version: 1,
    operationId: randomUUID(),
    ...custody,
    phase: "publishing",
    previous: descriptor.current,
    candidate: prepared,
    serviceDigest: "3".repeat(64),
    protection: syntheticImmutableProtection(descriptor, {
      key: "synthetic-state-key",
      hash: "4".repeat(64),
      policyFingerprint: "5".repeat(64),
    }),
    startedAtMs: 2,
  };
  return update(adopted, {
    descriptor: { ...descriptor, version: 2, activationEnabled: true },
    prepared,
    activation: { operation },
  });
}

function retainUnpublishedIntent(record: ImmutableInstallRecord) {
  const operation = record.activation!.operation!;
  const temporary = path.join(root, `.openclaw-current-${operation.operationId}`);
  fs.symlinkSync(`releases/${candidateSha}`, temporary);
  return update(record, {
    ...record,
    activation: {
      ...record.activation,
      operation: {
        ...operation,
        pointerIntent: {
          fromIdentity: descriptor.current.pointerIdentity,
          targetSha: candidateSha,
          temporaryIdentity: identity(temporary),
        },
      },
    },
  });
}

it("does not adopt a release layout when inspecting an absent record", async () => {
  expect(await readImmutableInstallRecord(root)).toBeNull();
  expect(fs.readdirSync(parent)).toEqual(["installation"]);
});

it("persists adoption and preparation without changing the selected generation", () => {
  const adopted = adopt();
  expect(read()).toEqual({ revision: 0, descriptor, prepared: null });
  const receipt = prepare(adopted, prepared);
  expect(receipt).toEqual({ revision: 1, descriptor, prepared });
  expect(read()).toEqual(receipt);
  expect(selectedRelease()).toBe(`releases/${sha}`);
  expect(fs.statSync(controlPath()).mode & 0o777).toBe(0o755);
  expect(fs.statSync(journalPath()).mode & 0o777).toBe(0o644);
});

it.each(["candidate-verification-pending", "private error: token=fixture-secret /private/state"])(
  "projects retained recovery after a fresh record read without disclosing private state (%s)",
  (failure) => {
    const record = beginActivation();
    const operation = record.activation!.operation!;
    update(record, {
      ...record,
      activation: { operation: { ...operation, failure } },
    });
    const before = controlFiles();
    const projection = projectImmutableInstall(read());
    expect(projection.activation).toEqual({
      operationId: operation.operationId,
      phase: "publishing",
      previousSha: sha,
      candidateSha,
      failure: failure === "candidate-verification-pending" ? failure : "details-withheld",
      recoveryCommand: `${descriptor.runtime.path} ${operation.recovery.helperPath}`,
    });
    expect(projection.prepared).toEqual({
      sha: candidateSha,
      path: prepared.path,
      buildDigest: prepared.buildDigest,
      preparedAtMs: 1234,
    });
    expect(projection).not.toHaveProperty("lastActivation");
    expect(JSON.stringify(projection)).not.toContain("fixture-secret");
    expect(JSON.stringify(projection)).not.toContain("synthetic-state-key");
    expect(controlFiles()).toEqual(before);
  },
);

it.each([
  {
    outcome: "succeeded",
    gateway: { pid: 4242, bootId: "fixture-boot", version: "2026.10.1", buildId: "fixture-build" },
  },
  {
    outcome: "rolled-back",
    gateway: {
      pid: 4243,
      bootId: "restored-boot",
      version: "2026.10.1",
      buildId: "restored-build",
    },
  },
  { outcome: "succeeded", gateway: undefined },
] as const)(
  "projects a historical $outcome receipt from a fresh observer",
  ({ outcome, gateway }) => {
    const record = beginActivation();
    const lastResult = {
      operationId: record.activation!.operation!.operationId,
      outcome,
      selectedSha: sha,
      verifiedAtMs: 1000,
      ...(gateway ? { gateway } : {}),
    };
    update(record, { ...record, activation: { lastResult } });
    const projection = projectImmutableInstall(read());
    expect(projection.lastActivation).toEqual(lastResult);
    expect(projection).not.toHaveProperty("activation");
  },
);
it("retains publication provenance across preparations without backfilling older releases", () => {
  const adopted = adopt();
  const legacy = prepare(adopted, prepared);
  const enabled = update(legacy, {
    ...legacy,
    descriptor: retentionDescriptor([{ sha, identity: descriptor.current.identity }]),
  });
  expect(enabled.releases).toEqual([]);
  const publishGeneration = (previous: ImmutableInstallRecord, nextSha: string) => {
    const nextPath = path.join(root, "releases", nextSha);
    fs.mkdirSync(nextPath, { mode: 0o755 });
    return prepare(previous, {
      ...prepared,
      sha: nextSha,
      path: nextPath,
      identity: identity(nextPath),
    });
  };
  const first = publishGeneration(enabled, "c".repeat(40));
  const second = publishGeneration(first, "d".repeat(40));
  expect(
    second.releases?.map((entry) => [entry.sha, entry.publishedRevision, entry.verifiedRevision]),
  ).toEqual([
    ["c".repeat(40), first.revision, null],
    ["d".repeat(40), second.revision, null],
  ]);
  expect(read()).toEqual(second);
  expect(fs.readdirSync(path.join(root, "releases")).toSorted()).toEqual([
    sha,
    candidateSha,
    "c".repeat(40),
    "d".repeat(40),
  ]);
  expect(selectedRelease()).toBe(`releases/${sha}`);
  expect(() => prepare(first, prepared)).toThrow("no longer current");
  expect(read()).toEqual(second);
});

it("rolls back inventory publication with a failed preparation receipt", () => {
  const adopted = adopt(retentionDescriptor());
  withDatabase(journalPath(), (db) => {
    db.exec(
      "CREATE TRIGGER fail_receipt BEFORE UPDATE ON immutable_installation BEGIN SELECT RAISE(ABORT, 'synthetic receipt failure'); END",
    );
  });
  expect(() => prepare(adopted, prepared)).toThrow("synthetic receipt failure");
  expect(read()).toEqual(adopted);
  expect(read().releases).toEqual([]);
  expect(fs.existsSync(prepared.path)).toBe(true);
});

it("refuses conflicting publication identities instead of rewriting owned provenance", () => {
  const adopted = adopt(retentionDescriptor());
  const published = prepare(adopted, prepared);
  expect(() =>
    prepare(published, {
      ...prepared,
      buildDigest: "9".repeat(64),
    }),
  ).toThrow("conflicts with its retained identity");
  expect(read()).toEqual(published);
});

it("rejects a stale preparation instead of replacing a newer receipt", () => {
  const adopted = createImmutableInstallRecord(descriptor, () => {});
  const receipt = recordImmutablePreparedGeneration(adopted, prepared, () => {});
  expect(() =>
    recordImmutablePreparedGeneration(
      adopted,
      {
        ...prepared,
        buildDigest: "3".repeat(64),
      },
      () => {},
    ),
  ).toThrow("no longer current");
  expect(read()).toEqual(receipt);
});

it("rolls back a preparation when executor authority is lost before commit", () => {
  const adopted = adopt();
  let admissions = 0;
  expect(() =>
    recordImmutablePreparedGeneration(adopted, prepared, () => {
      if (++admissions === 3) {
        throw new Error("executor ended");
      }
    }),
  ).toThrow("executor ended");
  expect(read()).toEqual(adopted);
  expect(selectedRelease()).toBe(`releases/${sha}`);
});

it("preserves existing package journals for their original recovery owner", () => {
  fs.mkdirSync(controlPath(), { mode: 0o755 });
  withDatabase(journalPath(), (db) =>
    db.exec(
      "CREATE TABLE package_activation (phase TEXT); INSERT INTO package_activation VALUES ('publishing')",
    ),
  );
  fs.chmodSync(journalPath(), 0o644);
  const digest = () => createHash("sha256").update(fs.readFileSync(journalPath())).digest("hex");
  const before = digest();
  expect(read).toThrow("remains with its recovery owner");
  expect(() => adopt()).toThrow("no existing control");
  expect(digest()).toBe(before);
});

it("rejects a replacement installation and writable control without mutation", () => {
  const adopted = adopt();
  fs.chmodSync(journalPath(), 0o666);
  expect(() => prepare(adopted, prepared)).toThrow("unsafe ownership or permissions");
  fs.chmodSync(journalPath(), 0o644);
  expect(read()).toEqual(adopted);
  fs.renameSync(root, `${root}.retained`);
  fs.mkdirSync(root, { mode: 0o755 });
  expect(read).toThrow("does not match the installation");
});

it("refuses a prepared receipt outside its adopted release root", () => {
  const adopted = adopt();
  expect(() => prepare(adopted, { ...prepared, path: path.join(parent, candidateSha) })).toThrow(
    "outside its recorded release root",
  );
  expect(read()).toEqual(adopted);
});

it("upgrades a slice-1 control in place only with explicit activation consent", () => {
  fs.mkdirSync(controlPath(), { mode: 0o755 });
  withDatabase(journalPath(), (db) => {
    db.exec(`CREATE TABLE immutable_installation (
    slot INTEGER PRIMARY KEY NOT NULL CHECK (slot = 1),
    revision INTEGER NOT NULL,
    descriptor_json TEXT NOT NULL,
    prepared_json TEXT NOT NULL
  ) STRICT`);
    db.prepare("INSERT INTO immutable_installation VALUES (1, 0, ?, ?)").run(
      JSON.stringify(descriptor),
      JSON.stringify(prepared),
    );
  });
  fs.chmodSync(journalPath(), 0o644);
  const journalIdentity = identity(journalPath());
  const original = read();
  expect(original.descriptor.activationEnabled).toBeUndefined();
  expect(() =>
    update(original, {
      ...original,
      descriptor: { ...descriptor, version: 2 },
    }),
  ).toThrow("explicitly enabled");
  expect(read()).toEqual(original);

  const enabled = update(original, {
    ...original,
    descriptor: { ...descriptor, version: 2, activationEnabled: true },
  });
  expect(read()).toEqual(enabled);
  expect(enabled.prepared).toEqual(prepared);
  expect(identity(journalPath())).toBe(journalIdentity);
  expect(selectedRelease()).toBe(`releases/${sha}`);
  expect(() =>
    update(original, {
      ...original,
      descriptor: { ...descriptor, version: 2, activationEnabled: true },
    }),
  ).toThrow("no longer current");
  expect(read()).toEqual(enabled);
});

it("retains a renamed pointer intent until recovery durably syncs it, then reconciles once", () => {
  const admitted = beginActivation();
  expect(() =>
    publishImmutablePointer(admitted, "candidate", () => {
      if (selectedRelease() === `releases/${candidateSha}`) {
        throw new Error("executor ended after rename");
      }
    }),
  ).toThrow("executor ended after rename");
  const interrupted = read();
  expect(interrupted.descriptor.current.sha).toBe(sha);
  expect(interrupted.activation?.operation?.pointerIntent?.targetSha).toBe(candidateSha);
  const selectedIdentity = identity(currentPointer());

  const fsync = fs.fsyncSync;
  let allowSync = false;
  let rootSyncs = 0;
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (stat.isDirectory() && `${stat.dev}:${stat.ino}` === descriptor.rootIdentity) {
      rootSyncs++;
      expect(read()).toEqual(interrupted);
      if (!allowSync) {
        throw new Error("synthetic pointer directory sync failed");
      }
    }
    fsync(fd);
  });
  expect(() => reconcile(interrupted)).toThrow("synthetic pointer directory sync failed");
  expect(read()).toEqual(interrupted);
  expect(identity(currentPointer())).toBe(selectedIdentity);
  allowSync = true;

  const recovered = reconcile(interrupted);
  expect(rootSyncs).toBe(2);
  expect(recovered.descriptor.current).toMatchObject({
    sha: candidateSha,
    pointerIdentity: selectedIdentity,
    buildDigest: prepared.buildDigest,
  });
  expect(recovered.activation?.operation?.pointerIntent).toBeUndefined();
  expect(recovered.activation?.operation?.operationId).toBe(
    admitted.activation?.operation?.operationId,
  );
  expect(recovered.revision).toBe(interrupted.revision + 1);
  expect(publish(recovered, "candidate")).toEqual(recovered);
  expect(read()).toEqual(recovered);
  expect(identity(currentPointer())).toBe(selectedIdentity);
});

it("refuses an old durable intent before publishing after its SQLite revision advances", () => {
  const intent = retainUnpublishedIntent(beginActivation());
  const newer = update(intent, {
    ...intent,
    activation: {
      ...intent.activation,
      operation: { ...intent.activation!.operation!, phase: "recovery-required" },
    },
  });
  expect(() => publish(intent, "candidate")).toThrow("no longer current");
  expect(selectedRelease()).toBe(`releases/${sha}`);
  expect(read()).toEqual(newer);
});

it("refuses a foreign current pointer and leaves its retained intent intact", () => {
  const intent = retainUnpublishedIntent(beginActivation());
  const foreign = path.join(root, ".foreign-current");
  fs.symlinkSync(`releases/${candidateSha}`, foreign);
  fs.renameSync(foreign, currentPointer());
  const foreignIdentity = identity(currentPointer());
  expect(() => reconcile(intent)).toThrow("differs from its durable publication intent");
  expect(identity(currentPointer())).toBe(foreignIdentity);
  expect(read()).toEqual(intent);
});

it("refuses a replaced prepared generation before selecting its directory", () => {
  const intent = retainUnpublishedIntent(beginActivation());
  fs.renameSync(prepared.path, `${prepared.path}.retained`);
  fs.mkdirSync(prepared.path, { mode: 0o755 });
  expect(() => publish(intent, "candidate")).toThrow("target generation changed");
  expect(selectedRelease()).toBe(`releases/${sha}`);
  expect(read()).toEqual(intent);
});

it("rolls back to the recorded sealed predecessor while retaining recovery evidence", () => {
  const admitted = beginActivation();
  const activated = publish(admitted, "candidate");
  expect(selectedRelease()).toBe(`releases/${candidateSha}`);
  const rolledBack = publish(activated, "previous");
  expect(selectedRelease()).toBe(`releases/${sha}`);
  expect(rolledBack.descriptor.current).toMatchObject({
    sha,
    identity: descriptor.current.identity,
    buildDigest: descriptor.current.buildDigest,
  });
  expect(rolledBack.activation?.operation).toEqual(admitted.activation?.operation);
  expect(rolledBack.activation?.operation?.pointerIntent).toBeUndefined();
  expect(read()).toEqual(rolledBack);
  expect(fs.existsSync(prepared.path)).toBe(true);
});

it("recovers the predecessor after rollback stops before its pointer intent commits", () => {
  const activated = publish(beginActivation(), "candidate");
  const temporary = path.join(
    root,
    `.openclaw-current-${activated.activation?.operation?.operationId}`,
  );
  let ended = false;
  const createLink = fs.symlinkSync;
  const create = vi.spyOn(fs, "symlinkSync").mockImplementation((...args) => {
    const result = createLink(...args);
    if (String(args[1]) === temporary) {
      ended = true;
    }
    return result;
  });
  expect(() =>
    publishImmutablePointer(activated, "previous", () => {
      if (ended) {
        throw new Error("executor ended before pointer intent");
      }
    }),
  ).toThrow("executor ended before pointer intent");
  create.mockRestore();

  expect(read()).toEqual(activated);
  expect(selectedRelease()).toBe(`releases/${candidateSha}`);
  const retainedIdentity = identity(temporary);
  const recovered = publish(read(), "previous");
  expect(selectedRelease()).toBe(`releases/${sha}`);
  expect(identity(currentPointer())).toBe(retainedIdentity);
  expect(fs.existsSync(temporary)).toBe(false);
  expect(recovered.activation?.operation?.pointerIntent).toBeUndefined();
  expect(publish(recovered, "previous")).toEqual(recovered);
  expect(read()).toEqual(recovered);
});

it.each(["wrong-target", "regular-file"] as const)(
  "preserves a %s occupying the rollback operation's temporary pointer",
  (kind) => {
    const activated = publish(beginActivation(), "candidate");
    const temporary = path.join(
      root,
      `.openclaw-current-${activated.activation?.operation?.operationId}`,
    );
    if (kind === "wrong-target") {
      fs.symlinkSync(`releases/${candidateSha}`, temporary);
    } else {
      fs.writeFileSync(temporary, "unrelated fixture file");
    }
    const retainedIdentity = identity(temporary);
    expect(() => publish(activated, "previous")).toThrow("differs from this operation");
    expect(identity(temporary)).toBe(retainedIdentity);
    expect(
      kind === "wrong-target" ? fs.readlinkSync(temporary) : fs.readFileSync(temporary, "utf8"),
    ).toBe(kind === "wrong-target" ? `releases/${candidateSha}` : "unrelated fixture file");
    expect(selectedRelease()).toBe(`releases/${candidateSha}`);
    expect(read()).toEqual(activated);
  },
);

it.skipIf(process.platform === "win32")(
  "recovers committed activation control only after explicit native rollback admission",
  async () => {
    const committed = beginActivation();
    createHotSqliteRollbackJournal({
      path: journalPath(),
      mutationSql: "UPDATE immutable_installation SET revision = revision + 100",
    });
    const before = controlFiles();
    expect(read).toThrow(expect.objectContaining({ errcode: 776 }));
    const recovery = await readImmutableInstallRecordForRecovery(root);
    expect(recovery.record).toEqual(committed);
    expect(controlFiles()).toEqual(before);
    expect(read).toThrow(expect.objectContaining({ errcode: 776 }));
    let checks = 0;
    expect(() =>
      recovery.admit(() => {
        if (++checks === 1) {
          const beforeTouch = fs.statSync(journalPath(), { bigint: true });
          fs.chmodSync(journalPath(), 0o644);
          const afterTouch = fs.statSync(journalPath(), { bigint: true });
          expect(afterTouch.ctimeNs).not.toBe(beforeTouch.ctimeNs);
          expect(afterTouch.mtimeNs).toBe(beforeTouch.mtimeNs);
        } else {
          recovery.assertUnchanged();
          throw new Error("executor revoked before rollback");
        }
      }),
    ).toThrow("executor revoked before rollback");
    expect(controlFiles()).toEqual(before);
    recovery.admit(() => {});
    expect(read()).toEqual(committed);
    expect(fs.readdirSync(controlPath())).toEqual(["operation.sqlite"]);
    expect(selectedRelease()).toBe(`releases/${sha}`);
  },
);

it.skipIf(process.platform === "win32").each([
  ["database", "inode"],
  ["journal", "inode"],
  ["database", "bytes"],
  ["journal", "bytes"],
  ["database", "size"],
  ["journal", "size"],
] as const)(
  "preserves immutable %s with changed %s instead of admitting old recovery evidence",
  async (changed, mutation) => {
    beginActivation();
    createHotSqliteRollbackJournal({
      path: journalPath(),
      mutationSql: "UPDATE immutable_installation SET revision = revision + 100",
    });
    const recovery = await readImmutableInstallRecordForRecovery(root);
    const source = changed === "database" ? journalPath() : `${journalPath()}-journal`;
    if (mutation === "inode") {
      const replacement = path.join(parent, "replacement-control-bytes");
      fs.copyFileSync(source, replacement);
      fs.renameSync(replacement, source);
    } else if (mutation === "bytes") {
      const bytes = fs.readFileSync(source);
      bytes[bytes.length - 1] = bytes.readUInt8(bytes.length - 1) ^ 1;
      fs.writeFileSync(source, bytes);
    } else {
      fs.appendFileSync(source, "changed size");
    }
    const before = controlFiles();
    expect(recovery.assertUnchanged).toThrow(/changed/u);
    expect(() => recovery.admit(() => {})).toThrow(/changed/u);
    expect(controlFiles()).toEqual(before);
    expect(selectedRelease()).toBe(`releases/${sha}`);
  },
);
