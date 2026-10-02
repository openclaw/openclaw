import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { mockLargeDirectoryId } from "../../test/helpers/fs-large-directory-id.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  childLineageDigest,
  type UpdateCommandChildGrant,
} from "../cli/update-cli/update-command-executor-children.js";
import { resolveUpdateCommandChildBinding } from "../cli/update-cli/update-command-executor-grant.js";
import { nativeBoundaryTestEntrypoints } from "./native-boundary-runtime.test-support.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "./update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
const databaseUrl = resolveRuntimeWorkerUrl(nativeBoundaryTestEntrypoints.handoffDatabase);
const databaseModule = databaseUrl.href;
const repoRoot = process.cwd();
let root: string;
let databasePath: string;

beforeEach(() => {
  root = fs.realpathSync(dirs.make("handoff-publication-"));
  fs.chmodSync(root, 0o700);
  databasePath = path.join(root, "managed-update-handoffs.sqlite");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function insertRow(db: DatabaseSync, key: string, owner: string): void {
  db.prepare(
    "INSERT INTO managed_update_handoffs " +
      "(install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
  ).run(key, owner, "{}", 1);
}

function readOwners(): string[] {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return db
      .prepare("SELECT owner FROM managed_update_handoffs ORDER BY owner")
      .all()
      .map((row) => String(row.owner));
  } finally {
    db.close();
  }
}

type RunningChild = {
  child: ReturnType<typeof spawn>;
  closed: Promise<unknown[]>;
  output: () => { stdout: string; stderr: string };
  waitForMarker: (marker: string) => Promise<void>;
};

function spawnFixture(script: string, args: string[] = []): RunningChild {
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      ...resolveRuntimeWorkerArgv(databaseUrl).slice(0, -1),
      "--input-type=module",
      "--eval",
      script,
      ...args,
    ],
    { cwd: repoRoot, env: {}, stdio: ["ignore", "pipe", "pipe"] },
  );
  const closed = once(child, "close");
  void closed.catch(() => undefined);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout = (stdout + chunk.toString()).slice(-64 * 1024);
  });
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-64 * 1024);
  });
  return {
    child,
    closed,
    output: () => ({ stdout, stderr }),
    waitForMarker: async (marker) => {
      const deadline = Date.now() + 10_000;
      while (!stdout.includes(marker)) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`fixture exited before ${marker}: ${JSON.stringify({ stdout, stderr })}`);
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `fixture timed out before ${marker}: ${JSON.stringify({ stdout, stderr })}`,
          );
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 10);
        });
      }
    },
  };
}

async function killFixture(fixture: RunningChild): Promise<void> {
  if (fixture.child.exitCode === null && fixture.child.signalCode === null) {
    fixture.child.kill("SIGKILL");
  }
  await Promise.race([
    fixture.closed,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("fixture did not close after SIGKILL")), 5_000);
    }),
  ]);
}

describe("managed handoff database publication", () => {
  it("does not create a database for an absent read", () => {
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
    expect(() => withDatabase(false, () => undefined)).toThrow();
    expect(fs.existsSync(databasePath)).toBe(false);
  });

  it("publishes a complete private single-link database", () => {
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
    const umask = process.umask(0o777);
    try {
      withDatabase(true, (db) => insertRow(db, root, "first"));
    } finally {
      process.umask(umask);
    }

    const stat = fs.statSync(databasePath);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
    expect(stat.nlink).toBe(1);
    expect(readOwners()).toEqual(["first"]);
    expect(fs.readdirSync(root)).toEqual([path.basename(databasePath)]);
  });

  it("uses synchronous directory spelling for synchronous durability receipts", () => {
    // Windows native realpath expands short aliases that ordinary realpath may preserve.
    // Model that spelling difference without replacing the directory or its identity.
    const nativeRealpath = fs.realpathSync.native;
    vi.spyOn(fs.realpathSync, "native").mockImplementation((...args) => {
      const result = nativeRealpath(...args);
      return args[0] === root && typeof result === "string" ? result + path.sep + "." : result;
    });

    createManagedHandoffLeaseDatabase(databasePath)(true, (db) =>
      insertRow(db, root, "alias-owner"),
    );

    expect(readOwners()).toEqual(["alias-owner"]);
    expect(fs.statSync(databasePath).nlink).toBe(1);
  });

  it("publishes when the parent file ID exceeds Number's exact range", () => {
    mockLargeDirectoryId(root);

    createManagedHandoffLeaseDatabase(databasePath)(true, (db) =>
      insertRow(db, root, "exact-owner"),
    );

    expect(readOwners()).toEqual(["exact-owner"]);
    expect(fs.statSync(databasePath).nlink).toBe(1);
  });

  it.skipIf(process.platform === "win32")(
    "repairs an interrupted legacy initializer that wins exclusive creation",
    () => {
      const open = fs.openSync;
      let winnerInode: number | undefined;
      vi.spyOn(fs, "openSync").mockImplementationOnce((pathname, flags, mode) => {
        fs.writeFileSync(databasePath, "", { mode: 0o600 });
        fs.chmodSync(databasePath, 0o644);
        winnerInode = fs.statSync(databasePath).ino;
        return open(pathname, flags, mode);
      });

      createManagedHandoffLeaseDatabase(databasePath)(true, (db) => insertRow(db, root, "winner"));

      expect(fs.statSync(databasePath).ino).toBe(winnerInode);
      expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
      expect(fs.statSync(databasePath).nlink).toBe(1);
      expect(readOwners()).toEqual(["winner"]);
    },
  );

  it("preserves an existing malformed database", () => {
    const malformed = Buffer.from("not a sqlite database");
    fs.writeFileSync(databasePath, malformed, { mode: 0o600 });
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);

    expect(() => withDatabase(true, () => undefined)).toThrow();
    expect(fs.readFileSync(databasePath)).toEqual(malformed);
    expect(fs.statSync(databasePath).nlink).toBe(1);
  });

  it("retains an exclusively created inode after a durability failure for ordinary recovery", () => {
    vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw new Error("fixture sync failed");
    });
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
    expect(() => withDatabase(true, () => undefined)).toThrow("fixture sync failed");
    const before = fs.statSync(databasePath);
    expect(before.size).toBe(0);
    expect(before.nlink).toBe(1);
    vi.restoreAllMocks();
    withDatabase(true, (db) => insertRow(db, root, "recovered"));
    expect(fs.statSync(databasePath).ino).toBe(before.ino);
    expect(readOwners()).toEqual(["recovered"]);
  });

  it.each(["file", "parent"] as const)(
    "preserves initialization ownership when %s replacement is attempted",
    (target) => {
      const sync = fs.fsyncSync;
      const retained = dirs.make("retained-initialization-");
      const originalParent = fs.statSync(root);
      let originalFile: fs.Stats | undefined;
      vi.spyOn(fs, "fsyncSync").mockImplementationOnce((descriptor) => {
        originalFile = fs.fstatSync(descriptor);
        if (target === "file") {
          fs.renameSync(databasePath, path.join(retained, "original.sqlite"));
          fs.writeFileSync(databasePath, "replacement", { mode: 0o600 });
        } else {
          fs.renameSync(root, path.join(retained, "original-parent"));
          fs.mkdirSync(root, { mode: 0o700 });
          fs.renameSync(
            path.join(retained, "original-parent", path.basename(databasePath)),
            databasePath,
          );
        }
        sync(descriptor);
      });
      const initialize = () =>
        createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
      if (process.platform === "win32" && target === "parent") {
        expect(initialize).toThrow(expect.objectContaining({ code: "EPERM" }));
        if (!originalFile) {
          throw new Error("fixture did not capture the created descriptor");
        }
        expect(fs.statSync(root)).toMatchObject({
          dev: originalParent.dev,
          ino: originalParent.ino,
        });
        expect(fs.statSync(databasePath)).toMatchObject({
          dev: originalFile.dev,
          ino: originalFile.ino,
          size: 0,
          nlink: 1,
        });
        expect(fs.readFileSync(databasePath, "utf8")).toBe("");
        vi.restoreAllMocks();
        createManagedHandoffLeaseDatabase(databasePath)(true, (db) =>
          insertRow(db, root, "recovered"),
        );
        expect(fs.statSync(databasePath)).toMatchObject({
          dev: originalFile.dev,
          ino: originalFile.ino,
          nlink: 1,
        });
        expect(readOwners()).toEqual(["recovered"]);
      } else {
        expect(initialize).toThrow(/changed during initialization/);
        expect(fs.readFileSync(databasePath, "utf8")).toBe(target === "file" ? "replacement" : "");
        expect(fs.statSync(databasePath).nlink).toBe(1);
      }
    },
  );

  it.each(["empty-file", "empty-schema", "foreign-schema", "wrong-table", "malformed"] as const)(
    "ordinary observation preserves an existing %s",
    (state) => {
      fs.writeFileSync(databasePath, state === "malformed" ? "not SQLite" : "", { mode: 0o600 });
      if (state !== "empty-file" && state !== "malformed") {
        const db = new DatabaseSync(databasePath);
        try {
          db.exec(
            state === "empty-schema"
              ? "VACUUM"
              : state === "foreign-schema"
                ? "CREATE TABLE unrelated(value TEXT)"
                : "CREATE TABLE managed_update_handoffs(wrong TEXT)",
          );
        } finally {
          db.close();
        }
      }
      const bytes = fs.readFileSync(databasePath);
      const before = fs.statSync(databasePath);
      const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: {} });
      expect(store.read(root)).toEqual(
        state === "empty-file" || state === "empty-schema"
          ? { kind: "absent" }
          : { kind: "unreadable", error: expect.any(Error) },
      );
      expect(fs.readFileSync(databasePath)).toEqual(bytes);
      expect(fs.statSync(databasePath).ino).toBe(before.ino);
      expect(fs.readdirSync(root)).toEqual([path.basename(databasePath)]);
    },
  );

  it("admits nested reads after first publication", () => {
    const withDatabase = createManagedHandoffLeaseDatabase(databasePath);
    withDatabase(true, (writer) => {
      insertRow(writer, root, "writer");
      expect(
        withDatabase(false, (reader) =>
          reader.prepare("SELECT owner FROM managed_update_handoffs").get(),
        ),
      ).toEqual({ owner: "writer" });
    });
  });

  it("lets competing first writers converge on one complete database", async () => {
    const script = `
      const { createManagedHandoffLeaseDatabase } = await import(${JSON.stringify(databaseModule)});
      const withDatabase = createManagedHandoffLeaseDatabase(process.argv[1]);
      withDatabase(true, (db) => db.prepare(
        "INSERT INTO managed_update_handoffs " +
        "(install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)"
      ).run(process.argv[2], process.argv[2], "{}", 1));
      process.stdout.write("done");
    `;
    const first = spawnFixture(script, [databasePath, "first"]);
    const second = spawnFixture(script, [databasePath, "second"]);
    try {
      expect(await first.closed).toEqual([0, null]);
      expect(await second.closed).toEqual([0, null]);
      expect(first.output()).toEqual({ stdout: "done", stderr: "" });
      expect(second.output()).toEqual({ stdout: "done", stderr: "" });
      expect(readOwners()).toEqual(["first", "second"]);
      expect(fs.statSync(databasePath).nlink).toBe(1);
    } finally {
      await stopChildProcess(first.child, 5_000);
      await stopChildProcess(second.child, 5_000);
    }
  });

  it("ordinary readers observe no lease while a real peer initializes the schema", async () => {
    const script = `
      const { createManagedHandoffLeaseDatabase } = await import(${JSON.stringify(databaseModule)});
      createManagedHandoffLeaseDatabase(process.argv[1])(true, () => undefined);
    `;
    const writer = spawnFixture(script, [databasePath]);
    const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: {} });
    try {
      do {
        expect(store.read(root)).toEqual({ kind: "absent" });
        if (fs.existsSync(databasePath)) {
          const stat = fs.statSync(databasePath);
          if (process.platform !== "win32") {
            expect(stat.mode & 0o777).toBe(0o600);
          }
          expect(stat.nlink).toBe(1);
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 1);
        });
      } while (writer.child.exitCode === null && writer.child.signalCode === null);
      expect(await writer.closed).toEqual([0, null]);
      expect(writer.output().stderr).toBe("");
      expect(readOwners()).toEqual([]);
    } finally {
      await stopChildProcess(writer.child, 5_000);
    }
  });

  it("recovers the same inode when its first writer crashes before schema initialization", async () => {
    const script = `
      import fs from "node:fs";
      fs.fsyncSync = () => {
        fs.writeSync(1, "before-schema\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      };
      const { createManagedHandoffLeaseDatabase } = await import(${JSON.stringify(databaseModule)});
      createManagedHandoffLeaseDatabase(process.argv[1])(true, () => undefined);
    `;
    const writer = spawnFixture(script, [databasePath]);
    try {
      await writer.waitForMarker("before-schema");
      const before = fs.statSync(databasePath);
      expect(before.size).toBe(0);
      expect(before.nlink).toBe(1);
      expect(
        createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: {} }).read(root),
      ).toEqual({
        kind: "absent",
      });
      await killFixture(writer);
      createManagedHandoffLeaseDatabase(databasePath)(true, (db) =>
        insertRow(db, root, "recovered"),
      );
      expect(fs.statSync(databasePath).ino).toBe(before.ino);
      expect(readOwners()).toEqual(["recovered"]);
    } finally {
      await stopChildProcess(writer.child, 5_000);
    }
  });

  it.each(["reader", "writer"] as const)(
    "waits for a held SQLite %s before writing",
    async (kind) => {
      createManagedHandoffLeaseDatabase(databasePath)(true, (db) =>
        insertRow(db, root, "original"),
      );
      const script = `
      import { DatabaseSync } from "node:sqlite";
      import fs from "node:fs";
      const db = new DatabaseSync(process.argv[1]);
      db.exec(process.argv[2] === "writer" ? "BEGIN IMMEDIATE" : "BEGIN");
      db.prepare("SELECT * FROM managed_update_handoffs").all();
      fs.writeSync(1, "held\\n");
      setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, 300);
    `;
      const holder = spawnFixture(script, [databasePath, kind]);
      try {
        await holder.waitForMarker("held");
        createManagedHandoffLeaseDatabase(databasePath)(true, (db) =>
          insertRow(db, "next", "next"),
        );
        expect(await holder.closed).toEqual([0, null]);
        expect(holder.output().stderr).toBe("");
        expect(readOwners()).toEqual(["next", "original"]);
      } finally {
        await stopChildProcess(holder.child, 5_000);
      }
    },
  );
});

it.each(["9.4 identity-less", "9.6 numeric", "9.6 bridge", "9.7 exact"] as const)(
  "admits a %s grant and fences parent replacement",
  (version) => {
    const identityLess = version === "9.4 identity-less";
    const numeric = version === "9.6 numeric" || version === "9.6 bridge";
    const directory = root;
    const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: {} });
    const executor = store.processIdentity(process.ppid);
    const owner = randomUUID();
    const runId = randomUUID();
    const spawnerKey =
      version === "9.6 bridge" ? `${root}/.openclaw-update-child-${randomUUID()}` : root;
    const payload = JSON.stringify({
      version: 2,
      helper: executor,
      executor,
      action: {
        kind: "update",
        ...(version === "9.7 exact" ? { mutationProtocol: "original-cancellation-v1" } : {}),
      },
    });
    const write = createManagedHandoffLeaseDatabase(databasePath);
    write(true, (db) => {
      db.prepare(
        "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
      ).run(root, owner, payload, 1);
      if (spawnerKey !== root) {
        db.prepare(
          "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
        ).run(spawnerKey, runId, payload, 1);
      }
    });
    const parent = store.read(root);
    assert(parent.kind === "current");
    const spawner = store.read(spawnerKey);
    assert(spawner.kind === "current");

    // Model NTFS metadata only; the grant, live rows and candidate admission are real.
    const lstat = fs.lstatSync;
    const initialInode = identityLess ? 9007199254740992n : 168040561096346671n;
    let parentInode = initialInode;
    let readError: Error | undefined;
    vi.spyOn(fs, "lstatSync").mockImplementation((...args) => {
      if (String(args[0]) === directory && readError) {
        throw readError;
      }
      const stat = lstat(...args);
      if (stat && String(args[0]) === directory) {
        Object.defineProperty(stat, "ino", {
          value: typeof stat.ino === "bigint" ? parentInode : Number(parentInode),
        });
      }
      return stat;
    });
    // Published v2026.9.6 used numeric lstatSync for both transported identities.
    const numericIdentity = (pathname: string) => {
      const stat = fs.lstatSync(pathname);
      return `${stat.dev}:${stat.ino}`;
    };
    const databaseIdentity = numeric
      ? {
          databasePath,
          databaseIdentity: numericIdentity(databasePath),
          parentIdentity: numericIdentity(directory),
        }
      : captureManagedUpdateLeaseDatabaseIdentity(databasePath);
    expect(databaseIdentity.parentIdentity).toMatch(
      numeric ? /:168040561096346660$/ : new RegExp(`:${initialInode}$`),
    );
    const childKey = `${spawnerKey}/.openclaw-update-child-${randomUUID()}${identityLess ? "" : `-lineage-${childLineageDigest(parent.lease, spawner.lease, parent.lease, databaseIdentity)}`}`;
    const childPayload = identityLess
      ? JSON.stringify({
          version: 2,
          helper: executor,
          executor: store.processIdentity(process.pid),
          action: { kind: "update" },
        })
      : payload;
    const db = new DatabaseSync(databasePath);
    try {
      db.prepare(
        "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
      ).run(childKey, runId, childPayload, 2);
    } finally {
      db.close();
    }
    const grant: UpdateCommandChildGrant = {
      runId,
      root,
      databasePath,
      parent: parent.lease,
      childKey,
      ...(identityLess
        ? {}
        : {
            databaseIdentity,
            originalParent: parent.lease,
            spawner: spawner.lease,
            originalChildKey: childKey,
          }),
    };
    const admitted = resolveUpdateCommandChildBinding(grant, runId, root);
    assert(admitted.databaseIdentity);
    expect(admitted.databaseIdentity.parentIdentity).toMatch(new RegExp(`^\\d+:${initialInode}$`));
    expect(admitted.store.read(root)).toMatchObject({ kind: "current" });
    const descendantKey = `${childKey}/.openclaw-update-child-${randomUUID()}-lineage-${childLineageDigest(parent.lease, admitted.child, parent.lease, admitted.databaseIdentity)}`;
    const descendants = new DatabaseSync(databasePath);
    try {
      descendants
        .prepare(
          "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run(
          descendantKey,
          runId,
          JSON.stringify({
            version: 2,
            helper: admitted.child.executor,
            executor: admitted.child.executor,
            action: admitted.child.action,
          }),
          3,
        );
    } finally {
      descendants.close();
    }
    const descendantGrant = {
      ...grant,
      originalParent: parent.lease,
      spawner: admitted.child,
      databaseIdentity: admitted.databaseIdentity,
      originalChildKey: descendantKey,
      childKey: descendantKey,
    };
    const resolveDescendant = () => {
      // Model the next receiver's parent PID without booting another source runtime.
      const descriptor = Object.getOwnPropertyDescriptor(process, "ppid");
      assert(descriptor);
      Object.defineProperty(process, "ppid", {
        configurable: true,
        value: admitted.child.executor.pid,
      });
      try {
        return resolveUpdateCommandChildBinding(descendantGrant, runId, root);
      } finally {
        Object.defineProperty(process, "ppid", descriptor);
      }
    };
    expect(resolveDescendant().child.key).toBe(descendantKey);
    parentInode += identityLess ? 1n : -1n;
    expect(numericIdentity(directory)).toMatch(
      identityLess ? /:9007199254740992$/ : /:168040561096346660$/,
    );
    expect(() => admitted.store.acquire(root, "replacement", { kind: "update" })).toThrow(
      "identity changed",
    );
    expect(resolveDescendant).toThrow("identity changed");
    if (version === "9.7 exact") {
      expect(() => resolveUpdateCommandChildBinding(grant, runId, root)).toThrow(
        "identity changed",
      );
    }
    parentInode += 4096n;
    if (!identityLess) {
      expect(() => resolveUpdateCommandChildBinding(grant, runId, root)).toThrow(
        "identity changed",
      );
    }
    readError = new Error("lease parent metadata unavailable");
    expect(() => resolveUpdateCommandChildBinding(grant, runId, root)).toThrow(readError.message);
    readError = undefined;
    parentInode = initialInode;
    const damaged = new DatabaseSync(databasePath);
    try {
      damaged.exec("DROP TABLE managed_update_handoffs");
    } finally {
      damaged.close();
    }
    expect(() => resolveUpdateCommandChildBinding(grant, runId, root)).toThrow(
      /lease is unreadable:.*no such table/i,
    );
  },
);
