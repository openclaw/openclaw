import assert from "node:assert/strict";
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
const update = { kind: "update" } as const;
type Store = ReturnType<typeof createManagedHandoffLeaseStore>;
function claim(store: Store, ...args: Parameters<Store["acquire"]>) {
  const result = store.acquire(...args);
  assert(result.kind === "acquired", "Missing fixture acquisition");
  return result;
}

function fixture() {
  const directory = fs.realpathSync(dirs.make("original-update-owner-"));
  const root = path.join(directory, "install");
  fs.mkdirSync(root);
  const { databasePath } = installPrivateUpdateHandoffStore(directory);
  const options = { databasePath, serviceManagerEnv: process.env, originalUpdateKey: root };
  const acquired = claim(createManagedHandoffLeaseStore(options), root, "original", update);
  assert(acquired.originalDatabaseIdentity, "Missing original acquisition");
  const store = createManagedHandoffLeaseStore({
    ...options,
    existingIdentity: acquired.originalDatabaseIdentity,
  });
  const childKey = `${root}/.openclaw-update-child-unknown`;
  return { root, childKey, databasePath, original: acquired.lease, ...store };
}

it("accepts cancellation only from the unchanged original acquisition object", () => {
  const { childKey, original, ...store } = fixture();
  expect(store.cancelUpdate(structuredClone(original))).toBeNull();
  const owner = original.owner;
  original.owner = "changed";
  expect(store.cancelUpdate(original)).toBeNull();
  original.owner = owner;
  expect(store.current(original)).toBe(true);

  const { lease: child } = claim(store, childKey, "descendant", {
    ...update,
    mutationProtocol: "original-cancellation-v1",
  });
  const cancelled = store.cancelUpdate(original);
  expect(cancelled).not.toBeNull();
  expect(store.current(original)).toBe(false);
  expect(store.cancelUpdate(original)).toBe(cancelled);
  expect(cancelled?.release()).toBe(false);
  expect(store.release(child)).toBe(true);
  expect(cancelled?.release()).toBe(true);
});

it("refuses cancellation through a replacement physical database", () => {
  const { databasePath, original, ...store } = fixture();
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

async function nativeCommandFixture() {
  const f = fixture();
  const retainedRoot = path.join(path.dirname(f.root), "retained");
  fs.mkdirSync(retainedRoot);
  const { lease: retained } = claim(f, retainedRoot, "retained", update);
  const roots = [f.root, retainedRoot];
  const { custody } = await createManagedCommandProcessCustody({
    roots,
    parents: [f.original, retained],
    databasePath: f.databasePath,
    runId: "native-command",
  });
  return { ...f, retained, custody, roots };
}

it("refuses cancellation until a reserved command has confirmed its non-start", async () => {
  const f = await nativeCommandFixture();
  const reservation = f.custody.reserve([process.execPath]);
  const commands = f.readCommandChildren(f.roots);
  expect(f.cancelUpdate(f.original, f.retained)).toBeNull();
  expect([f.original, f.retained, ...commands].map(f.current)).toEqual([true, true, true, true]);
  reservation.settled();
  expect(f.readCommandChildren(f.roots)).toEqual([]);
  const cancelled = f.cancelUpdate(f.original, f.retained);
  expect(cancelled).not.toBeNull();
  expect(cancelled?.release()).toBe(true);
});

it.skipIf(process.platform === "win32").each([false, true])(
  "retains native command custody through original cancellation (both roots=%s)",
  async (bothRoots) => {
    const f = await nativeCommandFixture();
    const reservation = f.custody.reserve([process.execPath, "--version"]);
    let groupAlive = true;
    const actualGroupAlive = processGroups.isChildProcessTreeAlive;
    vi.spyOn(processGroups, "isChildProcessTreeAlive").mockImplementation((child) =>
      child.pid === process.ppid ? groupAlive : actualGroupAlive(child),
    );
    reservation.spawned({ pid: process.ppid, startedAt: null });
    const commands = f.readCommandChildren(f.roots);
    const bound = { ...update, custody: "bound" };
    expect(commands.map((command) => command.action)).toEqual([bound, bound]);
    const cancelled = f.cancelUpdate(f.original, bothRoots ? f.retained : undefined);
    expect(cancelled).not.toBeNull();
    expect(commands.map(f.current)).toEqual([false, false]);
    expect(cancelled?.release()).toBe(false);
    if (bothRoots) {
      for (const root of f.roots) {
        expect(f.read(root)).toMatchObject({ kind: "current", lease: { version: 4 } });
      }
      expect(() => f.custody.reserve([process.execPath])).toThrow();
      expect(f.releaseAll(commands)).toBe(false);
    } else {
      expect(f.current(f.retained)).toBe(true);
      const peer = f.readCommandChildren([f.retained.key])[0];
      assert(peer, "Missing retained command alias");
      expect(f.current(peer)).toBe(false);
      const descendant = await createManagedCommandProcessCustody({
        roots: [peer.key],
        parents: [peer],
        databasePath: f.databasePath,
        runId: "retained-only-descendant",
      });
      expect(() => descendant.custody.reserve([process.execPath])).toThrow(
        "Managed command custody reservation is busy",
      );
    }
    groupAlive = false;
    if (bothRoots) {
      expect(f.release(commands[0]!)).toBe(false);
      expect(f.readCommandChildren(f.roots)).toEqual(commands);
    }
    reservation.settled();
    expect(f.readCommandChildren(f.roots)).toEqual([]);
    expect(cancelled?.release()).toBe(true);
    if (!bothRoots) {
      expect(f.current(f.retained)).toBe(true);
      expect(f.release(f.retained)).toBe(true);
    }
  },
);

it("refuses cancellation over a legacy receiver", () => {
  const { childKey, original, ...store } = fixture();
  const { lease: child } = claim(store, childKey, "unknown", update);
  expect(store.cancelUpdate(original)).toBeNull();
  expect(store.current(original)).toBe(true);
  expect(store.read(child.key)).toEqual({ kind: "current", lease: child });
});

it.skipIf(process.platform === "win32").each(["unrecognized child", "foreign alias"] as const)(
  "refuses cancellation over a bound command with an %s",
  async (kind) => {
    const f = await nativeCommandFixture();
    if (kind === "unrecognized child") {
      const { lease: child } = claim(f, f.childKey, "unknown", { ...update, custody: "reserved" });
      const bound = f.bindUpdateChildren([child], f.processIdentity(process.ppid));
      assert(bound, "Missing bound child fixture");
      expect(f.cancelUpdate(f.original)).toBeNull();
      expect(f.read(bound[0]!.key)).toEqual({ kind: "current", lease: bound[0] });
    } else {
      f.custody.reserve([process.execPath]).spawned({ pid: process.ppid, startedAt: null });
      const commands = f.readCommandChildren([f.retained.key]);
      expect(commands).toHaveLength(1);
      const commandKey = commands[0]!.key;
      createManagedHandoffLeaseDatabase(f.databasePath)(true, (db) => {
        executeSqliteQuerySync(
          db,
          leaseQueries(db)
            .updateTable("managed_update_handoffs")
            .set({ owner: "foreign-command-owner" })
            .where("install_root", "=", commandKey),
        );
      });
      expect(f.cancelUpdate(f.original, f.retained)).toBeNull();
      expect(f.read(commandKey)).toMatchObject({
        kind: "current",
        lease: { owner: "foreign-command-owner" },
      });
    }
    expect([f.original, f.retained].map(f.current)).toEqual([true, true]);
  },
);
