import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as openclawRoot from "./openclaw-root.js";
import {
  fileIdentity as identity,
  readText,
  immutableDescriptor,
  ownImmutableFixture,
  withDatabase,
} from "./package-update-activation-fixtures.test-support.js";
import {
  publishImmutablePointer,
  reconcileImmutablePointer,
} from "./package-update-activation-immutable-pointer.js";
import {
  prepareImmutableRecoveryRuntime,
  verifyImmutableRecoveryRuntime,
  readImmutableInstallRecordForRecovery,
} from "./package-update-activation-immutable-recovery.js";
import * as immutableActivation from "./package-update-activation-immutable.js";
import {
  createImmutableInstallRecord,
  immutableInstallReadOperations,
  recordImmutablePreparedGeneration,
  updateImmutableInstallRecord,
} from "./package-update-activation-immutable.js";
import { snapshotActivationFiles } from "./package-update-activation-lifetime.test-support.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";
import {
  syntheticActivationCustody,
  syntheticImmutableProtection,
} from "./update-immutable-activation.test-support.js";
import * as immutableGeneration from "./update-immutable-generation.js";
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
  change: Partial<Parameters<typeof updateImmutableInstallRecord>[1]>,
) => updateImmutableInstallRecord(record, { ...record, ...change }, () => {});
const updateDescriptor = (
  record: ImmutableInstallRecord,
  patch: Partial<ImmutableInstallDescriptor>,
) => update(record, { descriptor: { ...record.descriptor, ...patch } });
const prepare = (record: ImmutableInstallRecord, generation = prepared) =>
  recordImmutablePreparedGeneration(record, generation, () => {});
const publish = (record: ImmutableInstallRecord, target: "candidate" | "previous") =>
  publishImmutablePointer(record, target, () => {});
const reconcile = (record: ImmutableInstallRecord) => reconcileImmutablePointer(record, () => {});
const updateOperation = (
  record: ImmutableInstallRecord,
  patch: Partial<ImmutableActivationOperation>,
) =>
  update(record, {
    activation: {
      ...record.activation,
      operation: { ...record.activation!.operation!, ...patch },
    },
  });
function expectSelection(record: ImmutableInstallRecord, selected = sha, pointerIdentity?: string) {
  expect(selectedRelease()).toBe(`releases/${selected}`);
  expect(read()).toEqual(record);
  if (pointerIdentity !== undefined) {
    expect(identity(currentPointer())).toBe(pointerIdentity);
  }
}
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
const controlFiles = () => snapshotActivationFiles(controlPath());
const getOperation = (record: ImmutableInstallRecord) => record.activation!.operation!;
const expectUnchanged = (record: ImmutableInstallRecord, action: () => unknown, error: string) => {
  expect(action).toThrow(error);
  expectSelection(record);
};
function createGeneration(nextSha: string): ImmutablePreparedGeneration {
  const directory = path.join(root, "releases", nextSha);
  fs.mkdirSync(directory, { mode: 0o755 });
  return {
    sha: nextSha,
    path: directory,
    identity: identity(directory),
    buildDigest: "2".repeat(64),
    preparedAtMs: 1234,
  };
}

beforeEach(() => {
  parent = fs.realpathSync(dirs.make("immutable-install-control-"));
  root = path.join(parent, "installation");
  const current = path.join(root, "releases", sha);
  fs.mkdirSync(current, { recursive: true, mode: 0o755 });
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
  prepared = createGeneration(candidateSha);
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
  const temporary = temporaryPointer(record);
  fs.symlinkSync(`releases/${candidateSha}`, temporary);
  return updateOperation(record, {
    pointerIntent: {
      fromIdentity: descriptor.current.pointerIdentity,
      targetSha: candidateSha,
      temporaryIdentity: identity(temporary),
    },
  });
}

const temporaryPointer = (record: ImmutableInstallRecord) =>
  path.join(root, `.openclaw-current-${record.activation!.operation!.operationId}`);
const hotJournal = () =>
  createHotSqliteRollbackJournal({
    path: journalPath(),
    mutationSql: "UPDATE immutable_installation SET revision = revision + 100",
  });

it("does not adopt a release layout when inspecting an absent record", async () => {
  expect(await readImmutableInstallRecord(root)).toBeNull();
  expect(fs.readdirSync(parent)).toEqual(["installation"]);
});

it.each(["candidate-verification-pending", "private error: token=fixture-secret /private/state"])(
  "projects retained recovery after a fresh record read without disclosing private state (%s)",
  (failure) => {
    const record = beginActivation();
    const operation = record.activation!.operation!;
    updateOperation(record, { failure });
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
    const { identity: _identity, ...projectedPrepared } = prepared;
    expect(projection.prepared).toEqual(projectedPrepared);
    expect(projection).not.toHaveProperty("lastActivation");
    expect(JSON.stringify(projection)).not.toMatch(/fixture-secret|synthetic-state-key/u);
    expect(controlFiles()).toEqual(before);
  },
);

it.each([
  undefined,
  { pid: 4242, bootId: "fixture-boot", version: "2026.10.1", buildId: "fixture-build" },
])("projects a historical receipt from a fresh observer (%j)", (gateway) => {
  const record = beginActivation();
  const lastResult = {
    operationId: getOperation(record).operationId,
    outcome: "succeeded" as const,
    selectedSha: sha,
    verifiedAtMs: 1000,
    ...(gateway ? { gateway } : {}),
  };
  update(record, { activation: { lastResult } });
  const projection = projectImmutableInstall(read());
  expect(projection.lastActivation).toEqual(lastResult);
  expect(projection).not.toHaveProperty("activation");
});
it("retains publication provenance across preparations without backfilling older releases", () => {
  const adopted = adopt();
  expect(read()).toEqual({ revision: 0, descriptor, prepared: null });
  const legacy = prepare(adopted, prepared);
  expect(legacy).toEqual({ revision: 1, descriptor, prepared });
  expectSelection(legacy);
  expect(fs.statSync(controlPath()).mode & 0o777).toBe(0o755);
  expect(fs.statSync(journalPath()).mode & 0o777).toBe(0o644);
  const enabled = updateDescriptor(
    legacy,
    retentionDescriptor([{ sha, identity: descriptor.current.identity }]),
  );
  expect(enabled.releases).toEqual([]);
  const first = prepare(enabled, createGeneration("c".repeat(40)));
  const second = prepare(first, createGeneration("d".repeat(40)));
  expect(
    second.releases?.map((entry) => [entry.sha, entry.publishedRevision, entry.verifiedRevision]),
  ).toEqual([
    ["c".repeat(40), first.revision, null],
    ["d".repeat(40), second.revision, null],
  ]);
  expectSelection(second);
  expect(fs.readdirSync(path.join(root, "releases")).toSorted()).toEqual([
    sha,
    candidateSha,
    "c".repeat(40),
    "d".repeat(40),
  ]);
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
  expectUnchanged(
    published,
    () => prepare(published, { ...prepared, buildDigest: "9".repeat(64) }),
    "conflicts with its retained identity",
  );
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
  expectUnchanged(
    adopted,
    () =>
      recordImmutablePreparedGeneration(adopted, prepared, () => {
        if (++admissions === 3) {
          throw new Error("executor ended");
        }
      }),
    "executor ended",
  );
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
  expectUnchanged(
    adopted,
    () => prepare(adopted, { ...prepared, path: path.join(parent, candidateSha) }),
    "outside its recorded release root",
  );
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
  expect(() => updateDescriptor(original, { version: 2 })).toThrow("explicitly enabled");
  expect(read()).toEqual(original);

  const enabled = updateDescriptor(original, { version: 2, activationEnabled: true });
  expectSelection(enabled);
  expect(enabled.prepared).toEqual(prepared);
  expect(identity(journalPath())).toBe(journalIdentity);
  expect(() => updateDescriptor(original, { version: 2, activationEnabled: true })).toThrow(
    "no longer current",
  );
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
  vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (stat.isDirectory() && `${stat.dev}:${stat.ino}` === descriptor.rootIdentity) {
      expect(read()).toEqual(interrupted);
      if (!allowSync) {
        throw new Error("synthetic pointer directory sync failed");
      }
    }
    fsync(fd);
  });
  expect(() => reconcile(interrupted)).toThrow("synthetic pointer directory sync failed");
  expectSelection(interrupted, candidateSha, selectedIdentity);
  allowSync = true;

  const recovered = reconcile(interrupted);
  expect(recovered.descriptor.current).toMatchObject({
    sha: candidateSha,
    pointerIdentity: selectedIdentity,
    buildDigest: prepared.buildDigest,
  });
  expect(getOperation(recovered).pointerIntent).toBeUndefined();
  expect(getOperation(recovered).operationId).toBe(getOperation(admitted).operationId);
  expect(recovered.revision).toBe(interrupted.revision + 1);
  expect(publish(recovered, "candidate")).toEqual(recovered);
  expectSelection(recovered, candidateSha, selectedIdentity);
});

it("refuses an old durable intent before publishing after its SQLite revision advances", () => {
  const intent = retainUnpublishedIntent(beginActivation());
  const newer = updateOperation(intent, { phase: "recovery-required" });
  expectUnchanged(newer, () => publish(intent, "candidate"), "no longer current");
});

it("refuses a foreign current pointer and leaves its retained intent intact", () => {
  const intent = retainUnpublishedIntent(beginActivation());
  const foreign = path.join(root, ".foreign-current");
  fs.symlinkSync(`releases/${candidateSha}`, foreign);
  fs.renameSync(foreign, currentPointer());
  const foreignIdentity = identity(currentPointer());
  expect(() => reconcile(intent)).toThrow("differs from its durable publication intent");
  expectSelection(intent, candidateSha, foreignIdentity);
});

it("refuses a replaced prepared generation before selecting its directory", () => {
  const intent = retainUnpublishedIntent(beginActivation());
  fs.renameSync(prepared.path, `${prepared.path}.retained`);
  fs.mkdirSync(prepared.path, { mode: 0o755 });
  expectUnchanged(intent, () => publish(intent, "candidate"), "target generation changed");
});

it("recovers the predecessor after rollback stops before its pointer intent commits", () => {
  const activated = publish(beginActivation(), "candidate");
  const temporary = temporaryPointer(activated);
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

  expectSelection(activated, candidateSha);
  const retainedIdentity = identity(temporary);
  const recovered = publish(read(), "previous");
  expectSelection(recovered, sha, retainedIdentity);
  expect(recovered.descriptor.current).toMatchObject({
    sha,
    identity: descriptor.current.identity,
    buildDigest: descriptor.current.buildDigest,
  });
  expect(getOperation(recovered)).toEqual(getOperation(activated));
  expect(fs.existsSync(prepared.path)).toBe(true);
  expect(fs.existsSync(temporary)).toBe(false);
  expect(getOperation(recovered).pointerIntent).toBeUndefined();
  expect(publish(recovered, "previous")).toEqual(recovered);
});

it.each(["wrong-target", "regular-file"] as const)(
  "preserves a %s occupying the rollback operation's temporary pointer",
  (kind) => {
    const activated = publish(beginActivation(), "candidate");
    const temporary = temporaryPointer(activated);
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
    expectSelection(activated, candidateSha);
  },
);

it.skipIf(process.platform === "win32")(
  "recovers committed activation control only after explicit native rollback admission",
  async () => {
    const committed = beginActivation();
    hotJournal();
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
    expectSelection(committed);
    expect(fs.readdirSync(controlPath())).toEqual(["operation.sqlite"]);
  },
);

it.skipIf(process.platform === "win32").each([
  ["database", "inode"],
  ["journal", "inode"],
  ["database", "bytes"],
  ["journal", "bytes"],
] as const)(
  "preserves immutable %s with changed %s instead of admitting old recovery evidence",
  async (changed, mutation) => {
    beginActivation();
    hotJournal();
    const recovery = await readImmutableInstallRecordForRecovery(root);
    const source = changed === "database" ? journalPath() : `${journalPath()}-journal`;
    if (mutation === "inode") {
      const replacement = path.join(parent, "replacement-control-bytes");
      fs.copyFileSync(source, replacement);
      fs.renameSync(replacement, source);
    } else {
      const bytes = fs.readFileSync(source);
      bytes[bytes.length - 1] = bytes.readUInt8(bytes.length - 1) ^ 1;
      fs.writeFileSync(source, bytes);
    }
    const before = controlFiles();
    expect(recovery.assertUnchanged).toThrow(/changed/u);
    expect(() => recovery.admit(() => {})).toThrow(/changed/u);
    expect(controlFiles()).toEqual(before);
    expect(selectedRelease()).toBe(`releases/${sha}`);
  },
);

describe("immutable retained recovery runtime", () => {
  const runtimeBytes = "built runtime";
  const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const recoveryArgs = ["--json", "--timeout", "10", "--drain-timeout", "30"];
  let recoveryRecord: ImmutableInstallRecord;
  let source: string;
  let control: string;
  let current: boolean;
  const assertRecoveryCurrent = () => {
    if (!current) {
      throw new Error("executor retired");
    }
  };
  const prepareRecovery = () =>
    prepareImmutableRecoveryRuntime({
      record: recoveryRecord,
      assertCurrent: assertRecoveryCurrent,
    });
  const verifyRecovery = (reference: Awaited<ReturnType<typeof prepareRecovery>>) =>
    verifyImmutableRecoveryRuntime({
      reference,
      descriptor: recoveryRecord.descriptor,
      assertCurrent: assertRecoveryCurrent,
    });
  const writeSource = (file: string, content: string) => {
    const target = path.join(source, file);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o755 });
    fs.writeFileSync(target, content);
  };

  beforeEach(() => {
    vi.mocked(fs.lstatSync).mockRestore();
    ownImmutableFixture(parent);
    vi.spyOn(immutableActivation, "assertImmutableInstallRecordCurrent").mockImplementation(
      (_record, check) => check(),
    );
    vi.spyOn(immutableGeneration, "sealImmutableGeneration").mockResolvedValue(undefined);
    vi.spyOn(immutableGeneration, "verifyImmutableGeneration");
    vi.spyOn(openclawRoot, "resolveOpenClawPackageRoot");
    current = true;
    source = descriptor.current.path;
    control = resolvePackageActivationControl(resolvePackageActivationAnchor(root));
    writeSource("dist/index.js", runtimeBytes);
    writeSource("dist/worker.js", "copied worker");
    writeSource("node_modules/fixture/index.cjs", "module.exports = 'copied dependency';");
    writeSource("node_modules/fixture/addon.node", "native artifact bytes");
    fs.mkdirSync(control, { mode: 0o755 });
    const dependencies = path.join(source, "node_modules");
    fs.symlinkSync(path.join(dependencies, "fixture"), path.join(dependencies, "absolute"));
    fs.symlinkSync("fixture", path.join(dependencies, "relative"));
    writeSource(
      "openclaw.mjs",
      `
import fs from 'node:fs';
import { createRequire } from 'node:module';
console.log(JSON.stringify({ args: process.argv.slice(2), dependency: createRequire(import.meta.url)('./node_modules/absolute/index.cjs'), worker: fs.readFileSync(new URL('./dist/worker.js', import.meta.url), 'utf8') }));
`,
    );
    vi.mocked(openclawRoot.resolveOpenClawPackageRoot).mockResolvedValue(source);
    vi.mocked(immutableGeneration.verifyImmutableGeneration).mockImplementation(
      async (directory, expectedSha) => {
        expect(expectedSha).toBe(sha);
        return {
          identity: identity(directory),
          buildDigest: digest(fs.readFileSync(path.join(directory, "dist", "index.js"))),
        };
      },
    );
    recoveryRecord = {
      revision: 1,
      prepared: null,
      descriptor: {
        ...descriptor,
        current: { ...descriptor.current, buildDigest: digest(runtimeBytes) },
        version: 2,
        activationEnabled: true,
      },
    };
  });

  it("runs retained recovery after the original generation is gone", async () => {
    const reference = await prepareRecovery();
    expect(await prepareRecovery()).toEqual(reference);
    fs.rmSync(source, { recursive: true });
    await verifyRecovery(reference);
    expect(readText(reference.path, "node_modules/fixture/addon.node")).toBe(
      "native artifact bytes",
    );
    expect(fs.realpathSync(path.join(reference.path, "node_modules", "relative"))).toBe(
      path.join(reference.path, "node_modules", "fixture"),
    );
    const result = spawnSync(process.execPath, [reference.helperPath, ...recoveryArgs], {
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      args: ["update", "recover", "--root", recoveryRecord.descriptor.root, ...recoveryArgs],
      dependency: "copied dependency",
      worker: "copied worker",
    });
  });

  it("rejects a foreign checkout before publication", async () => {
    vi.mocked(openclawRoot.resolveOpenClawPackageRoot).mockResolvedValue(path.dirname(source));
    await expect(prepareRecovery()).rejects.toThrow("sealed current or prepared generation");
    expect(fs.readdirSync(control)).toEqual([]);
  });

  it("preserves a recovery copy with a mismatched receipt", async () => {
    const destination = path.join(control, `recovery-${sha}`);
    fs.mkdirSync(path.join(destination, "dist"), { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(destination, "dist", "index.js"), "foreign runtime");
    await expect(prepareRecovery()).rejects.toThrow("differs; it was preserved");
    expect(readText(destination, "dist/index.js")).toBe("foreign runtime");
    expect(fs.existsSync(path.join(control, "recovery.mjs"))).toBe(false);
  });

  it("preserves the source on authority loss during copy verification", async () => {
    const verifyGeneration = vi
      .mocked(immutableGeneration.verifyImmutableGeneration)
      .getMockImplementation()!;
    vi.mocked(immutableGeneration.verifyImmutableGeneration).mockImplementation(async (...args) => {
      const result = await verifyGeneration(...args);
      if (args[0] !== source) {
        current = false;
      }
      return result;
    });
    await expect(prepareRecovery()).rejects.toThrow("executor retired");
    expect(readText(source, "dist/index.js")).toBe("built runtime");
    expect(fs.readdirSync(control)).toEqual([]);
  });

  it.each(["helper", "runtime"])("rejects changed %s bytes before recovery", async (changed) => {
    const reference = await prepareRecovery();
    const file =
      changed === "helper" ? reference.helperPath : path.join(reference.path, "dist", "index.js");
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, "foreign bytes");
    fs.chmodSync(file, 0o444);
    await expect(verifyRecovery(reference)).rejects.toThrow(/artifact identity|recorded artifact/u);
  });
});
