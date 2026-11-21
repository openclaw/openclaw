import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { afterEach, assert, beforeEach, expect, it, vi } from "vitest";
import { mockLargeDirectoryId } from "../../test/helpers/fs-large-directory-id.js";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { stopChildProcess } from "../../test/helpers/stop-child-process.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
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
import type { ManagedHandoffLease } from "./update-managed-service-handoff-lease-types.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const dirs = createTempDirTracker();
const children = new Set<ReturnType<typeof spawn>>();
const databaseUrl = resolveRuntimeWorkerUrl(nativeBoundaryTestEntrypoints.handoffDatabase);
const databaseModule = databaseUrl.href;
const insertSql =
  "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)";
const inodeOf = ({ dev, ino }: fs.Stats) => ({ dev, ino });
let root: string;
let databasePath: string;
let withDatabase: ReturnType<typeof createManagedHandoffLeaseDatabase>;
let store: ReturnType<typeof createManagedHandoffLeaseStore>;

beforeEach(() => {
  root = fs.realpathSync(dirs.make("handoff-publication-"));
  fs.chmodSync(root, 0o700);
  databasePath = path.join(root, "managed-update-handoffs.sqlite");
  withDatabase = createManagedHandoffLeaseDatabase(databasePath);
  store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: {} });
});

afterEach(async () => {
  try {
    await Promise.all([...children].map((child) => stopChildProcess(child, 5_000)));
  } finally {
    children.clear();
    vi.restoreAllMocks();
    dirs.cleanup();
  }
});

function insertRow(db: DatabaseSync, key: string, owner: string, payload = "{}", updatedAt = 1) {
  db.prepare(insertSql).run(key, owner, payload, updatedAt);
}

function withSqlite<T>(run: (db: DatabaseSync) => T, readOnly = false): T {
  using db = new DatabaseSync(databasePath, { readOnly });
  return run(db);
}

function readOwners(): string[] {
  return withSqlite(
    (db) =>
      db
        .prepare("SELECT owner FROM managed_update_handoffs ORDER BY owner")
        .all()
        .map((row) => String(row.owner)),
    true,
  );
}

function publish(owner: string, key = root): void {
  withDatabase(true, (db) => insertRow(db, key, owner));
}

function expectSingleLink(owners: string[]): void {
  expect(readOwners()).toEqual(owners);
  expect(fs.statSync(databasePath).nlink).toBe(1);
}

function spawnFixture(script: string, args: string[] = []) {
  const child = spawn(
    process.execPath,
    [
      "--no-warnings",
      ...resolveRuntimeWorkerArgv(databaseUrl).slice(0, -1),
      "--input-type=module",
      "--eval",
      `import fs from "node:fs";
      import { DatabaseSync } from "node:sqlite";
      const openDatabase = async () => (await import(${JSON.stringify(databaseModule)}))
        .createManagedHandoffLeaseDatabase(process.argv[1]);
      ${script}`,
      databasePath,
      ...args,
    ],
    { cwd: process.cwd(), env: {}, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.add(child);
  const closed = once(child, "close");
  void closed.catch(() => undefined);
  const output = { stdout: "", stderr: "" };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]?.on("data", (chunk) => {
      output[stream] = (output[stream] + chunk.toString()).slice(-64 * 1024);
    });
  }
  return {
    child,
    closed,
    output,
    waitForMarker: async (marker: string) => {
      const deadline = Date.now() + 10_000;
      while (!output.stdout.includes(marker)) {
        const exited = child.exitCode !== null || child.signalCode !== null;
        if (exited || Date.now() >= deadline) {
          throw new Error(
            `fixture ${exited ? "exited" : "timed out"} before ${marker}: ${JSON.stringify(output)}`,
          );
        }
        await delay(10);
      }
    },
  };
}

async function expectSuccessfulExit(fixture: ReturnType<typeof spawnFixture>): Promise<void> {
  expect(await fixture.closed).toEqual([0, null]);
  expect(fixture.output.stderr).toBe("");
}

it("does not create a database for an absent read", () => {
  expect(() => withDatabase(false, () => undefined)).toThrow();
  expect(fs.existsSync(databasePath)).toBe(false);
});

it.each(["private", "directory-alias", "large-file-id"] as const)(
  "publishes a complete private single-link database (%s)",
  (mode) => {
    const umask = process.umask();
    try {
      if (mode === "private") {
        // Windows privacy comes from the DACL; owner-write must survive the umask.
        process.umask(process.platform === "win32" ? 0o077 : 0o777);
      } else if (mode === "directory-alias") {
        // Model Windows short-alias spelling without replacing the directory identity.
        const nativeRealpath = fs.realpathSync.native;
        vi.spyOn(fs.realpathSync, "native").mockImplementation((...args) => {
          const result = nativeRealpath(...args);
          return args[0] === root && typeof result === "string" ? result + path.sep + "." : result;
        });
      } else {
        mockLargeDirectoryId(root);
      }
      publish(mode);
    } finally {
      process.umask(umask);
    }
    if (process.platform !== "win32") {
      expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
    }
    expectSingleLink([mode]);
    expect(fs.readdirSync(root)).toEqual([path.basename(databasePath)]);
  },
);

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

    publish("winner");

    expect(fs.statSync(databasePath).ino).toBe(winnerInode);
    expect(fs.statSync(databasePath).mode & 0o777).toBe(0o600);
    expectSingleLink(["winner"]);
  },
);

it.each(["file", "parent"] as const)(
  "preserves initialization ownership when %s replacement is attempted",
  (target) => {
    const sync = fs.fsyncSync;
    const retained = dirs.make("retained-initialization-");
    const originalParent = fs.statSync(root);
    let originalFile: fs.Stats | undefined;
    vi.spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
      if (
        originalFile ||
        !fs.existsSync(databasePath) ||
        fs.fstatSync(descriptor, { bigint: true }).ino !==
          fs.statSync(databasePath, { bigint: true }).ino
      ) {
        sync(descriptor);
        return;
      }
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
    const initialize = () => withDatabase(true, () => undefined);
    if (process.platform === "win32" && target === "parent") {
      expect(initialize).toThrow(expect.objectContaining({ code: "EPERM" }));
      assert(originalFile, "fixture did not capture the created descriptor");
      const fileIdentity = { ...inodeOf(originalFile), nlink: 1 };
      expect(fs.statSync(root)).toMatchObject(inodeOf(originalParent));
      expect(fs.statSync(databasePath)).toMatchObject({ ...fileIdentity, size: 0 });
      expect(fs.readFileSync(databasePath, "utf8")).toBe("");
      vi.restoreAllMocks();
      publish("recovered");
      expect(fs.statSync(databasePath)).toMatchObject(fileIdentity);
      expect(readOwners()).toEqual(["recovered"]);
    } else {
      expect(initialize).toThrow(/changed during initialization/);
      expect(fs.readFileSync(databasePath, "utf8")).toBe(target === "file" ? "replacement" : "");
      expect(fs.statSync(databasePath).nlink).toBe(1);
    }
  },
);

it.each([
  ["empty-file", null],
  ["empty-schema", "VACUUM"],
  ["foreign-schema", "CREATE TABLE unrelated(value TEXT)"],
  ["wrong-table", "CREATE TABLE managed_update_handoffs(wrong TEXT)"],
  ["malformed", null],
] as const)("ordinary observation preserves an existing %s", (state, schema) => {
  fs.writeFileSync(databasePath, state === "malformed" ? "not SQLite" : "", { mode: 0o600 });
  if (schema) {
    withSqlite((db) => db.exec(schema));
  }
  const bytes = fs.readFileSync(databasePath);
  const before = fs.statSync(databasePath);
  expect(store.read(root)).toEqual(
    state === "empty-file" || state === "empty-schema"
      ? { kind: "absent" }
      : { kind: "unreadable", error: expect.any(Error) },
  );
  if (state === "malformed") {
    expect(() => withDatabase(true, () => undefined)).toThrow();
  }
  expect(fs.readFileSync(databasePath)).toEqual(bytes);
  expect(fs.statSync(databasePath)).toMatchObject({ ino: before.ino, nlink: 1 });
  expect(fs.readdirSync(root)).toEqual([path.basename(databasePath)]);
});

it("admits nested reads after first publication", () => {
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
      (await openDatabase())(true, db => db.prepare(${JSON.stringify(insertSql)})
        .run(process.argv[2], process.argv[2], "{}", 1));
    `;
  const first = spawnFixture(script, ["first"]);
  const second = spawnFixture(script, ["second"]);
  await expectSuccessfulExit(first);
  await expectSuccessfulExit(second);
  expectSingleLink(["first", "second"]);
});

it.skipIf(process.platform !== "win32")(
  "waits for private publication before admitting a competing first writer",
  async ({ signal }) => {
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const source = `
        const fs = require("node:fs");
        const { parentPort, workerData } = require("node:worker_threads");
        (async () => {
          const { register } = await import(${JSON.stringify(import.meta.resolve("tsx/esm/api"))});
          register({ tsconfig: ${JSON.stringify(path.resolve("tsconfig.json"))} });
          const { createManagedHandoffLeaseDatabase } = await import(${JSON.stringify(databaseModule)});
          const target = ${JSON.stringify(databasePath)};
          const method = workerData.first ? "linkSync" : "openSync";
          const original = fs[method];
          fs[method] = (file, ...args) => {
            try {
              const result = original(file, ...args);
              if (workerData.first && args[0] === target) {
                parentPort.postMessage("published");
                Atomics.wait(new Int32Array(workerData.gate), 0, 0);
              }
              return result;
            } catch (error) {
              if (!workerData.first && file === target + ".lock" && error.code === "EEXIST") {
                parentPort.postMessage("contended");
              }
              throw error;
            }
          };
          const owner = workerData.first ? "first" : "second";
          createManagedHandoffLeaseDatabase(target)(true, db =>
            db.prepare(${JSON.stringify(insertSql)}).run(owner, owner, "{}", 1));
          parentPort.close();
        })().catch(error => { throw error; });
      `;
    const launch = (first: boolean) => {
      const worker = new Worker(source, {
        eval: true,
        execArgv: [],
        workerData: { first, gate: gate.buffer },
      });
      const exited = once(worker, "exit");
      void exited.catch(() => undefined);
      const ready = withinTest(
        awaitGateBeforeSettlement(once(worker, "message"), exited, "Publication worker exited"),
        signal,
      );
      return { worker, exited, ready };
    };
    const first = launch(true);
    let second: ReturnType<typeof launch> | undefined;
    try {
      expect(await first.ready).toEqual(["published"]);
      expect(fs.statSync(databasePath).nlink).toBe(2);
      second = launch(false);
      expect(await second.ready).toEqual(["contended"]);
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      expect(await Promise.all([first.exited, second.exited])).toEqual([[0], [0]]);
      expectSingleLink(["first", "second"]);
    } finally {
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      await Promise.all([first.worker.terminate(), second?.worker.terminate()]);
    }
  },
);

it("recovers the same inode when its first writer crashes before schema initialization", async ({
  signal,
}) => {
  const script = `
      const sync = fs.fsyncSync;
      fs.fsyncSync = (descriptor) => {
        if (!fs.existsSync(process.argv[1]) ||
            fs.fstatSync(descriptor, { bigint: true }).ino !==
            fs.statSync(process.argv[1], { bigint: true }).ino) {
          sync(descriptor);
          return;
        }
        fs.writeSync(1, "before-schema\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      };
      (await openDatabase())(true, () => undefined);
    `;
  const writer = spawnFixture(script);
  await writer.waitForMarker("before-schema");
  const before = fs.statSync(databasePath);
  expect(before).toMatchObject({ size: 0, nlink: 1 });
  if (process.platform !== "win32") {
    expect(before.mode & 0o777).toBe(0o600);
  }
  expect(store.read(root)).toEqual({ kind: "absent" });
  writer.child.kill("SIGKILL");
  await withinTest(writer.closed, signal);
  publish("recovered");
  expect(fs.statSync(databasePath).ino).toBe(before.ino);
  expect(readOwners()).toEqual(["recovered"]);
});

it.each(["reader", "writer"] as const)(
  "waits for a held SQLite %s before writing",
  async (kind) => {
    publish("original");
    const script = `
      const db = new DatabaseSync(process.argv[1]);
      db.exec(process.argv[2] === "writer" ? "BEGIN IMMEDIATE" : "BEGIN");
      db.prepare("SELECT * FROM managed_update_handoffs").all();
      fs.writeSync(1, "held\\n");
      setTimeout(() => { db.exec("ROLLBACK"); db.close(); }, 300);
    `;
    const holder = spawnFixture(script, [kind]);
    await holder.waitForMarker("held");
    publish("next", "next");
    await expectSuccessfulExit(holder);
    expect(readOwners()).toEqual(["next", "original"]);
  },
);
it.each(["9.4 identity-less", "9.6 numeric", "9.6 bridge", "9.7 exact"] as const)(
  "admits a %s grant and fences parent replacement",
  async (version) => {
    const identityLess = version === "9.4 identity-less";
    const numeric = version === "9.6 numeric" || version === "9.6 bridge";
    const executor = store.processIdentity(process.ppid);
    const runId = randomUUID();
    const spawnerKey =
      version === "9.6 bridge" ? `${root}/.openclaw-update-child-${randomUUID()}` : root;
    const action: ManagedHandoffLease["action"] = {
      kind: "update",
      ...(version === "9.7 exact" ? { mutationProtocol: "original-cancellation-v1" } : {}),
    };
    const payloadFor = (
      actor = executor,
      nextAction: ManagedHandoffLease["action"] = action,
      helper = actor,
    ) => JSON.stringify({ version: 2, helper, executor: actor, action: nextAction });
    withDatabase(true, (db) => {
      insertRow(db, root, "parent", payloadFor());
      if (spawnerKey !== root) {
        insertRow(db, spawnerKey, runId, payloadFor());
      }
    });
    const parent = store.read(root);
    assert(parent.kind === "current");
    const spawner = store.read(spawnerKey);
    assert(spawner.kind === "current");

    // Model NTFS metadata only; the grant, live rows and candidate admission are real.
    const initialInode = identityLess ? 9007199254740992n : 168040561096346671n;
    let parentInode = initialInode;
    let readError: Error | undefined;
    for (const method of ["lstatSync", "statSync"] as const) {
      const original = fs[method];
      vi.spyOn(fs, method).mockImplementation((...args) => {
        if (method === "lstatSync" && String(args[0]) === root && readError) {
          throw readError;
        }
        const stat = original(...args);
        if (stat && String(args[0]) === root) {
          Object.defineProperty(stat, "ino", {
            value: typeof stat.ino === "bigint" ? parentInode : Number(parentInode),
          });
        }
        return stat;
      });
    }
    // Published v2026.9.6 used numeric lstatSync for both transported identities.
    const numericIdentity = (pathname: string) => {
      const stat = fs.lstatSync(pathname);
      return `${stat.dev}:${stat.ino}`;
    };
    const databaseIdentity = numeric
      ? {
          databasePath,
          databaseIdentity: numericIdentity(databasePath),
          parentIdentity: numericIdentity(root),
        }
      : captureManagedUpdateLeaseDatabaseIdentity(databasePath);
    const makeGrant = (
      sender: ManagedHandoffLease,
      identity: typeof databaseIdentity,
      legacy = false,
    ): UpdateCommandChildGrant => {
      const childKey = `${sender.key}/.openclaw-update-child-${randomUUID()}${legacy ? "" : `-lineage-${childLineageDigest(parent.lease, sender, parent.lease, identity)}`}`;
      const childPayload = legacy
        ? payloadFor(store.processIdentity(process.pid), { kind: "update" }, executor)
        : payloadFor(sender.executor, sender.action);
      withSqlite((db) => insertRow(db, childKey, runId, childPayload, sender.updatedAt + 1));
      return {
        runId,
        root,
        databasePath,
        parent: parent.lease,
        childKey,
        ...(!legacy && {
          databaseIdentity: identity,
          originalParent: parent.lease,
          spawner: sender,
          originalChildKey: childKey,
        }),
      };
    };
    const grant = makeGrant(spawner.lease, databaseIdentity, identityLess);
    const resolve = () => resolveUpdateCommandChildBinding(grant, runId, root);
    const admitted = await resolve();
    assert(admitted.databaseIdentity);
    expect(admitted.databaseIdentity.parentIdentity).toMatch(new RegExp(`^\\d+:${initialInode}$`));
    const descendantGrant = makeGrant(admitted.child, admitted.databaseIdentity);
    const resolveDescendant = async () => {
      // Model the next receiver's parent PID without booting another source runtime.
      const descriptor = Object.getOwnPropertyDescriptor(process, "ppid");
      assert(descriptor);
      Object.defineProperty(process, "ppid", { value: admitted.child.executor.pid });
      try {
        return await resolveUpdateCommandChildBinding(descendantGrant, runId, root);
      } finally {
        Object.defineProperty(process, "ppid", descriptor);
      }
    };
    expect((await resolveDescendant()).child.key).toBe(descendantGrant.childKey);
    parentInode += identityLess ? 1n : -1n;
    expect(numericIdentity(root)).toMatch(
      identityLess ? /:9007199254740992$/ : /:168040561096346660$/,
    );
    expect(() => admitted.store.acquire(root, "replacement", { kind: "update" })).toThrow(
      "identity changed",
    );
    await expect(resolveDescendant()).rejects.toThrow("identity changed");
    if (version === "9.7 exact") {
      await expect(resolve()).rejects.toThrow("identity changed");
    }
    parentInode += 4096n;
    if (!identityLess) {
      await expect(resolve()).rejects.toThrow("identity changed");
    }
    readError = new Error("lease parent metadata unavailable");
    await expect(resolve()).rejects.toThrow(readError.message);
    readError = undefined;
    parentInode = initialInode;
    withSqlite((db) => db.exec("DROP TABLE managed_update_handoffs"));
    await expect(resolve()).rejects.toThrow(/lease is unreadable:.*no such table/i);
  },
);
