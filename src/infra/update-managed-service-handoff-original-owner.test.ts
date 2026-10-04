import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processGroups from "../process/child-process-tree.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import { createManagedCommandProcessCustody } from "./update-managed-command-custody.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "./update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const directory = fs.realpathSync(dirs.make("original-update-owner-"));
  const root = path.join(directory, "install");
  fs.mkdirSync(root);
  const { databasePath } = installPrivateUpdateHandoffStore(directory);
  const options = { databasePath, serviceManagerEnv: process.env, originalUpdateKey: root };
  const acquired = createManagedHandoffLeaseStore(options).acquire(root, "original", {
    kind: "update",
  });
  if (acquired.kind !== "acquired" || !acquired.originalDatabaseIdentity) {
    throw new Error("Missing original acquisition");
  }
  const store = createManagedHandoffLeaseStore({
    ...options,
    existingIdentity: acquired.originalDatabaseIdentity,
  });
  return { root, databasePath, original: acquired.lease, store };
}

it("accepts cancellation only from the unchanged original acquisition object", () => {
  const { original, store } = fixture();
  expect(store.cancelUpdate(structuredClone(original))).toBeNull();
  const owner = original.owner;
  original.owner = "changed";
  expect(store.cancelUpdate(original)).toBeNull();
  original.owner = owner;
  expect(store.current(original)).toBe(true);

  const cancelled = store.cancelUpdate(original);
  expect(cancelled).not.toBeNull();
  expect(store.current(original)).toBe(false);
  expect(store.cancelUpdate(original)).toBe(cancelled);
  expect(cancelled?.release()).toBe(true);
});

it("refuses cancellation through a replacement physical database", () => {
  const { databasePath, original, store } = fixture();
  const saved = databasePath + ".saved";
  fs.renameSync(databasePath, saved);
  fs.copyFileSync(saved, databasePath);
  try {
    expect(() => store.cancelUpdate(original)).toThrow(/identity/);
  } finally {
    fs.rmSync(databasePath);
    fs.renameSync(saved, databasePath);
  }
  expect(store.current(original)).toBe(true);
  expect(store.cancelUpdate(original)?.release()).toBe(true);
});

it("keeps cancellation custody until its descendant row settles", () => {
  const { root, original, store } = fixture();
  const child = store.acquire(root + "/.openclaw-update-child-test", "descendant", {
    kind: "update",
    mutationProtocol: "original-cancellation-v1",
  });
  if (child.kind !== "acquired") {
    throw new Error("Missing descendant");
  }
  const cancelled = store.cancelUpdate(original);
  expect(cancelled).not.toBeNull();
  expect(cancelled?.release()).toBe(false);
  expect(store.release(child.lease)).toBe(true);
  expect(cancelled?.release()).toBe(true);
});

function nativeCommandFixture() {
  const f = fixture();
  const retainedRoot = path.join(path.dirname(f.root), "retained");
  fs.mkdirSync(retainedRoot);
  const retained = f.store.acquire(retainedRoot, "retained", { kind: "update" });
  if (retained.kind !== "acquired") {
    throw new Error("Missing retained owner");
  }
  const native = createManagedCommandProcessCustody({
    roots: [f.root, retainedRoot],
    parents: [f.original, retained.lease],
    databasePath: f.databasePath,
    runId: "native-command",
  });
  return { ...f, retained: retained.lease, native };
}

it("refuses cancellation until a reserved command has confirmed its non-start", () => {
  const f = nativeCommandFixture();
  const reservation = f.native.custody.reserve([process.execPath]);
  const commands = f.store.readCommandChildren([f.root, f.retained.key]);
  expect(commands).toHaveLength(2);
  expect(f.store.cancelUpdate(f.original, f.retained)).toBeNull();
  expect(f.store.current(f.original)).toBe(true);
  expect(f.store.current(f.retained)).toBe(true);
  expect(commands.map((command) => f.store.current(command))).toEqual([true, true]);
  reservation.settled();
  expect(f.store.readCommandChildren([f.root, f.retained.key])).toEqual([]);
  const cancelled = f.store.cancelUpdate(f.original, f.retained);
  expect(cancelled).not.toBeNull();
  expect(cancelled?.release()).toBe(true);
});

it.skipIf(process.platform === "win32")(
  "fences both roots while retaining bound native command custody through settlement",
  () => {
    const f = nativeCommandFixture();
    const reservation = f.native.custody.reserve([process.execPath, "--version"]);
    let groupAlive = true;
    const actualGroupAlive = processGroups.isChildProcessTreeAlive;
    vi.spyOn(processGroups, "isChildProcessTreeAlive").mockImplementation((child) =>
      child.pid === process.ppid ? groupAlive : actualGroupAlive(child),
    );
    reservation.spawned({ pid: process.ppid, startedAt: null });
    const commands = f.store.readCommandChildren([f.root, f.retained.key]);
    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.action)).toEqual([
      { kind: "update" },
      { kind: "update" },
    ]);

    const cancelled = f.store.cancelUpdate(f.original, f.retained);
    expect(cancelled).not.toBeNull();
    expect(f.store.read(f.root)).toMatchObject({ kind: "current", lease: { version: 4 } });
    expect(f.store.read(f.retained.key)).toMatchObject({
      kind: "current",
      lease: { version: 4 },
    });
    expect(commands.map((command) => f.store.current(command))).toEqual([false, false]);
    expect(() => f.native.custody.reserve([process.execPath])).toThrow();
    expect(cancelled?.release()).toBe(false);
    expect(f.store.releaseAll(commands)).toBe(false);
    groupAlive = false;
    expect(f.store.release(commands[0]!)).toBe(false);
    expect(f.store.readCommandChildren([f.root, f.retained.key])).toEqual(commands);
    reservation.settled();
    expect(f.store.readCommandChildren([f.root, f.retained.key])).toEqual([]);
    expect(cancelled?.release()).toBe(true);
  },
);

it.skipIf(process.platform === "win32")(
  "revokes retained-only native admission when its original alias is cancelled",
  () => {
    const f = nativeCommandFixture();
    const reservation = f.native.custody.reserve([process.execPath]);
    let groupAlive = true;
    const actualGroupAlive = processGroups.isChildProcessTreeAlive;
    vi.spyOn(processGroups, "isChildProcessTreeAlive").mockImplementation((child) =>
      child.pid === process.ppid ? groupAlive : actualGroupAlive(child),
    );
    reservation.spawned({ pid: process.ppid, startedAt: null });
    const peer = f.store.readCommandChildren([f.retained.key])[0];
    if (!peer) {
      throw new Error("Missing retained command alias");
    }
    const cancelled = f.store.cancelUpdate(f.original);
    expect(cancelled).not.toBeNull();
    expect(f.store.current(f.retained)).toBe(true);
    expect(f.store.current(peer)).toBe(false);
    const descendant = createManagedCommandProcessCustody({
      roots: [peer.key],
      parents: [peer],
      databasePath: f.databasePath,
      runId: "retained-only-descendant",
    });
    expect(() => descendant.custody.reserve([process.execPath])).toThrow(
      "Managed command custody reservation is busy",
    );
    expect(cancelled?.release()).toBe(false);
    groupAlive = false;
    reservation.settled();
    expect(cancelled?.release()).toBe(true);
    expect(f.store.current(f.retained)).toBe(true);
    expect(f.store.release(f.retained)).toBe(true);
  },
);

it("refuses cancellation over a legacy receiver", () => {
  const { root, original, store } = fixture();
  const child = store.acquire(`${root}/.openclaw-update-child-unknown`, "unknown", {
    kind: "update",
  });
  if (child.kind !== "acquired") {
    throw new Error("Missing refused child fixture");
  }
  expect(store.cancelUpdate(original)).toBeNull();
  expect(store.current(original)).toBe(true);
  expect(store.read(child.lease.key)).toEqual({ kind: "current", lease: child.lease });
});

it.skipIf(process.platform === "win32")("refuses cancellation over a bound command child", () => {
  const { root, original, store } = fixture();
  const child = store.acquire(
    `${root}/.openclaw-update-child-00000000-0000-4000-8000-000000000001-command`,
    "unknown",
    { kind: "update" },
  );
  if (child.kind !== "acquired") {
    throw new Error("Missing refused child fixture");
  }
  const bound = store.bindUpdateChildren([child.lease], process.ppid);
  if (!bound) {
    throw new Error("Missing bound child fixture");
  }
  expect(store.cancelUpdate(original)).toBeNull();
  expect(store.current(original)).toBe(true);
  expect(store.read(bound[0]!.key)).toEqual({ kind: "current", lease: bound[0] });
});

it.skipIf(process.platform === "win32")(
  "refuses cancellation when a native command alias belongs to another owner",
  () => {
    const f = nativeCommandFixture();
    f.native.custody.reserve([process.execPath]).spawned({ pid: process.ppid, startedAt: null });
    const commands = f.store.readCommandChildren([f.retained.key]);
    expect(commands).toHaveLength(1);
    createManagedHandoffLeaseDatabase(f.databasePath)(true, (db) => {
      executeSqliteQuerySync(
        db,
        leaseQueries(db)
          .updateTable("managed_update_handoffs")
          .set({ owner: "foreign-command-owner" })
          .where("install_root", "=", commands[0]!.key),
      );
    });
    expect(f.store.cancelUpdate(f.original, f.retained)).toBeNull();
    expect(f.store.current(f.original)).toBe(true);
    expect(f.store.current(f.retained)).toBe(true);
    expect(f.store.read(commands[0]!.key)).toMatchObject({
      kind: "current",
      lease: { owner: "foreign-command-owner" },
    });
  },
);
