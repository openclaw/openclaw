import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  publishImmutablePointer,
  reconcileImmutablePointer,
} from "./package-update-activation-immutable-pointer.js";
import {
  createImmutableInstallRecord,
  immutableInstallReadOperations,
  recordImmutablePreparedGeneration,
  readImmutableInstallRecordForRecovery,
  updateImmutableInstallRecord,
} from "./package-update-activation-immutable.js";
import {
  packageActivationRuntimeIdentity,
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-paths.js";
import { readImmutableInstallRecord } from "./update-immutable-install-record.js";
import type {
  ImmutableActivationOperation,
  ImmutableInstallDescriptor,
  ImmutableInstallRecord,
  ImmutablePreparedGeneration,
} from "./update-immutable-install-schema.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const sha = "a".repeat(40);
const candidateSha = "b".repeat(40);
let parent: string;
let root: string;
let descriptor: ImmutableInstallDescriptor;
let prepared: ImmutablePreparedGeneration;
const identity = (file: string) => {
  const stat = fs.lstatSync(file, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};
const controlPath = () => resolvePackageActivationControl(resolvePackageActivationAnchor(root));
const journalPath = () => resolvePackageActivationJournalPath(resolvePackageActivationAnchor(root));
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
  fs.symlinkSync(`releases/${sha}`, path.join(root, "current"));
  // Simulate root-owned release fixtures on unprivileged CI; SQLite and physical
  // inode, pointer, permission, and transaction behavior remain real.
  const lstat = fs.lstatSync;
  vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
    const stat = lstat(...args);
    if (
      stat &&
      (String(args[0]) === parent || String(args[0]).startsWith(`${parent}${path.sep}`))
    ) {
      Object.defineProperty(stat, "uid", { value: typeof stat.uid === "bigint" ? 0n : 0 });
    }
    return stat;
  });
  descriptor = {
    version: 1,
    kind: "immutable",
    root,
    rootIdentity: identity(root),
    releasesIdentity: identity(path.join(root, "releases")),
    current: {
      sha,
      path: current,
      identity: identity(current),
      pointerIdentity: identity(path.join(root, "current")),
      buildDigest: "1".repeat(64),
    },
    service: {
      unit: "openclaw-fixture.service",
      scope: "system",
      account: "openclaw-fixture",
      stateDir: path.join(parent, "state"),
      configPath: path.join(parent, "state", "openclaw.json"),
      profile: null,
    },
    runtime: {
      path: fs.realpathSync(process.execPath),
      identity: packageActivationRuntimeIdentity(fs.realpathSync(process.execPath)),
    },
    source: "https://github.com/openclaw/openclaw.git",
  };
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
  const adopted = createImmutableInstallRecord(descriptor, () => {});
  fs.mkdirSync(descriptor.service.stateDir, { mode: 0o700 });
  const statePath = path.join(descriptor.service.stateDir, "openclaw.db");
  fs.writeFileSync(statePath, "synthetic state identity", { mode: 0o600 });
  fs.writeFileSync(descriptor.service.configPath, "{}", { mode: 0o600 });
  const fileIdentity = (file: string) => {
    const stat = fs.lstatSync(file);
    return {
      dev: String(stat.dev),
      ino: String(stat.ino),
      mode: stat.mode,
      nlink: 1 as const,
      uid: stat.uid,
      gid: stat.gid,
    };
  };
  const operation: ImmutableActivationOperation = {
    version: 1,
    operationId: randomUUID(),
    authority: {
      databasePath: journalPath(),
      databaseIdentity: identity(journalPath()),
      parentIdentity: identity(controlPath()),
      installKey: root,
      owner: randomUUID(),
    },
    phase: "publishing",
    previous: descriptor.current,
    candidate: prepared,
    serviceDigest: "3".repeat(64),
    recovery: {
      root,
      path: path.join(controlPath(), `recovery-${sha}`),
      sha,
      identity: "1:9",
      buildDigest: descriptor.current.buildDigest,
      helperPath: path.join(controlPath(), "recovery.mjs"),
      helperIdentity: "1:10",
      helperDigest: "6".repeat(64),
    },
    protection: {
      capturedAtMs: 1,
      auditBoundary: null,
      state: {
        path: statePath,
        identity: fileIdentity(statePath),
        pathProof: { targetPath: statePath, entries: [] },
        key: "synthetic-state-key",
      },
      config: [
        {
          path: descriptor.service.configPath,
          identity: fileIdentity(descriptor.service.configPath),
          pathProof: { targetPath: descriptor.service.configPath, entries: [] },
          hash: "4".repeat(64),
          fingerprint: {},
          policyFingerprint: "5".repeat(64),
        },
      ],
    },
    startedAtMs: 2,
  };
  return updateImmutableInstallRecord(
    adopted,
    {
      descriptor: { ...descriptor, version: 2, activationEnabled: true },
      prepared,
      activation: { operation },
    },
    () => {},
  );
}

function retainUnpublishedIntent(record: ImmutableInstallRecord) {
  const operation = record.activation?.operation;
  if (!operation) {
    throw new Error("Missing fixture activation");
  }
  const temporary = path.join(root, `.openclaw-current-${operation.operationId}`);
  fs.symlinkSync(`releases/${candidateSha}`, temporary);
  return updateImmutableInstallRecord(
    record,
    {
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
    },
    () => {},
  );
}

it("does not adopt a release layout when inspecting an absent record", async () => {
  expect(await readImmutableInstallRecord(root)).toBeNull();
  expect(fs.readdirSync(parent)).toEqual(["installation"]);
});

it("persists adoption and preparation without changing the selected generation", () => {
  const adopted = createImmutableInstallRecord(descriptor, () => {});
  expect(read()).toEqual({ revision: 0, descriptor, prepared: null });
  const receipt = recordImmutablePreparedGeneration(adopted, prepared, () => {});
  expect(receipt).toEqual({ revision: 1, descriptor, prepared });
  expect(read()).toEqual(receipt);
  expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${sha}`);
  expect(fs.statSync(controlPath()).mode & 0o777).toBe(0o755);
  expect(fs.statSync(journalPath()).mode & 0o777).toBe(0o644);
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
  const adopted = createImmutableInstallRecord(descriptor, () => {});
  let admissions = 0;
  expect(() =>
    recordImmutablePreparedGeneration(adopted, prepared, () => {
      if (++admissions === 3) {
        throw new Error("executor ended");
      }
    }),
  ).toThrow("executor ended");
  expect(read()).toEqual(adopted);
  expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${sha}`);
});

it("preserves existing package journals for their original recovery owner", () => {
  fs.mkdirSync(controlPath(), { mode: 0o755 });
  const db = new DatabaseSync(journalPath());
  db.exec(
    "CREATE TABLE package_activation (phase TEXT); INSERT INTO package_activation VALUES ('publishing')",
  );
  db.close();
  fs.chmodSync(journalPath(), 0o644);
  const digest = () => createHash("sha256").update(fs.readFileSync(journalPath())).digest("hex");
  const before = digest();
  expect(read).toThrow("remains with its recovery owner");
  expect(() => createImmutableInstallRecord(descriptor, () => {})).toThrow("no existing control");
  expect(digest()).toBe(before);
});

it("rejects a replacement installation and writable control without mutation", () => {
  const adopted = createImmutableInstallRecord(descriptor, () => {});
  fs.chmodSync(journalPath(), 0o666);
  expect(() => recordImmutablePreparedGeneration(adopted, prepared, () => {})).toThrow(
    "unsafe ownership or permissions",
  );
  fs.chmodSync(journalPath(), 0o644);
  expect(read()).toEqual(adopted);
  fs.renameSync(root, `${root}.retained`);
  fs.mkdirSync(root, { mode: 0o755 });
  expect(read).toThrow("does not match the installation");
});

it("refuses a prepared receipt outside its adopted release root", () => {
  const adopted = createImmutableInstallRecord(descriptor, () => {});
  expect(() =>
    recordImmutablePreparedGeneration(
      adopted,
      {
        ...prepared,
        path: path.join(parent, candidateSha),
      },
      () => {},
    ),
  ).toThrow("outside its recorded release root");
  expect(read()).toEqual(adopted);
});

it("upgrades a slice-1 control in place only with explicit activation consent", () => {
  fs.mkdirSync(controlPath(), { mode: 0o755 });
  const db = new DatabaseSync(journalPath());
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
  db.close();
  fs.chmodSync(journalPath(), 0o644);
  const journalIdentity = identity(journalPath());
  const original = read();
  expect(original.descriptor.activationEnabled).toBeUndefined();
  expect(() =>
    updateImmutableInstallRecord(
      original,
      {
        ...original,
        descriptor: { ...descriptor, version: 2 },
      },
      () => {},
    ),
  ).toThrow("explicitly enabled");
  expect(read()).toEqual(original);

  const enabled = updateImmutableInstallRecord(
    original,
    {
      ...original,
      descriptor: { ...descriptor, version: 2, activationEnabled: true },
    },
    () => {},
  );
  expect(read()).toEqual(enabled);
  expect(enabled.prepared).toEqual(prepared);
  expect(identity(journalPath())).toBe(journalIdentity);
  expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${sha}`);
  expect(() =>
    updateImmutableInstallRecord(
      original,
      {
        ...original,
        descriptor: { ...descriptor, version: 2, activationEnabled: true },
      },
      () => {},
    ),
  ).toThrow("no longer current");
  expect(read()).toEqual(enabled);
});

it("retains a renamed pointer intent until recovery durably syncs it, then reconciles once", () => {
  const admitted = beginActivation();
  expect(() =>
    publishImmutablePointer(admitted, "candidate", () => {
      if (fs.readlinkSync(path.join(root, "current")) === `releases/${candidateSha}`) {
        throw new Error("executor ended after rename");
      }
    }),
  ).toThrow("executor ended after rename");
  const interrupted = read();
  expect(interrupted.descriptor.current.sha).toBe(sha);
  expect(interrupted.activation?.operation?.pointerIntent?.targetSha).toBe(candidateSha);
  const selectedIdentity = identity(path.join(root, "current"));

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
  expect(() => reconcileImmutablePointer(interrupted, () => {})).toThrow(
    "synthetic pointer directory sync failed",
  );
  expect(read()).toEqual(interrupted);
  expect(identity(path.join(root, "current"))).toBe(selectedIdentity);
  allowSync = true;

  const recovered = reconcileImmutablePointer(interrupted, () => {});
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
  expect(publishImmutablePointer(recovered, "candidate", () => {})).toEqual(recovered);
  expect(read()).toEqual(recovered);
  expect(identity(path.join(root, "current"))).toBe(selectedIdentity);
});

it("refuses an old durable intent before publishing after its SQLite revision advances", () => {
  const intent = retainUnpublishedIntent(beginActivation());
  const newer = updateImmutableInstallRecord(
    intent,
    {
      ...intent,
      activation: {
        ...intent.activation,
        operation: { ...intent.activation!.operation!, phase: "recovery-required" },
      },
    },
    () => {},
  );
  expect(() => publishImmutablePointer(intent, "candidate", () => {})).toThrow("no longer current");
  expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${sha}`);
  expect(read()).toEqual(newer);
});

it("refuses a foreign current pointer and leaves its retained intent intact", () => {
  const intent = retainUnpublishedIntent(beginActivation());
  const foreign = path.join(root, ".foreign-current");
  fs.symlinkSync(`releases/${candidateSha}`, foreign);
  fs.renameSync(foreign, path.join(root, "current"));
  const foreignIdentity = identity(path.join(root, "current"));
  expect(() => reconcileImmutablePointer(intent, () => {})).toThrow(
    "differs from its durable publication intent",
  );
  expect(identity(path.join(root, "current"))).toBe(foreignIdentity);
  expect(read()).toEqual(intent);
});

it("refuses a replaced prepared generation before selecting its directory", () => {
  const intent = retainUnpublishedIntent(beginActivation());
  fs.renameSync(prepared.path, `${prepared.path}.retained`);
  fs.mkdirSync(prepared.path, { mode: 0o755 });
  expect(() => publishImmutablePointer(intent, "candidate", () => {})).toThrow(
    "target generation changed",
  );
  expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${sha}`);
  expect(read()).toEqual(intent);
});

it("rolls back to the recorded sealed predecessor while retaining recovery evidence", () => {
  const admitted = beginActivation();
  const activated = publishImmutablePointer(admitted, "candidate", () => {});
  expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${candidateSha}`);
  const rolledBack = publishImmutablePointer(activated, "previous", () => {});
  expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${sha}`);
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
  const activated = publishImmutablePointer(beginActivation(), "candidate", () => {});
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
  expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${candidateSha}`);
  const retainedIdentity = identity(temporary);
  const recovered = publishImmutablePointer(read(), "previous", () => {});
  expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${sha}`);
  expect(identity(path.join(root, "current"))).toBe(retainedIdentity);
  expect(fs.existsSync(temporary)).toBe(false);
  expect(recovered.activation?.operation?.pointerIntent).toBeUndefined();
  expect(publishImmutablePointer(recovered, "previous", () => {})).toEqual(recovered);
  expect(read()).toEqual(recovered);
});

it.each(["wrong-target", "regular-file"] as const)(
  "preserves a %s occupying the rollback operation's temporary pointer",
  (kind) => {
    const activated = publishImmutablePointer(beginActivation(), "candidate", () => {});
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
    expect(() => publishImmutablePointer(activated, "previous", () => {})).toThrow(
      "differs from this operation",
    );
    expect(identity(temporary)).toBe(retainedIdentity);
    expect(
      kind === "wrong-target" ? fs.readlinkSync(temporary) : fs.readFileSync(temporary, "utf8"),
    ).toBe(kind === "wrong-target" ? `releases/${candidateSha}` : "unrelated fixture file");
    expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${candidateSha}`);
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
        if (++checks === 2) {
          throw new Error("executor revoked before rollback");
        }
      }),
    ).toThrow("executor revoked before rollback");
    expect(controlFiles()).toEqual(before);
    recovery.admit(() => {});
    expect(read()).toEqual(committed);
    expect(fs.readdirSync(controlPath())).toEqual(["operation.sqlite"]);
    expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${sha}`);
  },
);

it.skipIf(process.platform === "win32").each(["database", "journal"] as const)(
  "preserves a changed immutable %s family member instead of admitting old recovery evidence",
  async (changed) => {
    beginActivation();
    createHotSqliteRollbackJournal({
      path: journalPath(),
      mutationSql: "UPDATE immutable_installation SET revision = revision + 100",
    });
    const recovery = await readImmutableInstallRecordForRecovery(root);
    const source = changed === "database" ? journalPath() : `${journalPath()}-journal`;
    const replacement = path.join(parent, "replacement-control-bytes");
    fs.copyFileSync(source, replacement);
    fs.renameSync(replacement, source);
    const before = controlFiles();
    expect(recovery.assertUnchanged).toThrow(/changed/u);
    expect(() => recovery.admit(() => {})).toThrow(/changed/u);
    expect(controlFiles()).toEqual(before);
    expect(fs.readlinkSync(path.join(root, "current"))).toBe(`releases/${sha}`);
  },
);
