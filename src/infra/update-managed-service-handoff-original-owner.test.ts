import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as processGroups from "../process/child-process-tree.js";
import { createManagedCommandProcessCustody } from "./update-managed-command-custody.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const test = it.skipIf(process.platform === "win32");
const update = { kind: "update" } as const;
type Store = ReturnType<typeof createManagedHandoffLeaseStore>;
function claim(store: Store, ...args: Parameters<Store["acquire"]>) {
  const result = store.acquire(...args);
  assert(result.kind === "acquired", "Missing fixture acquisition");
  return result;
}

function fixture() {
  const root = fs.realpathSync(dirs.make("original-update-owner-"));
  const { databasePath } = installPrivateUpdateHandoffStore(root);
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
  assert(cancelled);
  const { release } = cancelled;
  expect(store.current(original)).toBe(false);
  expect(store.cancelUpdate(original)).toBe(cancelled);
  expect([release(), store.release(child), release()]).toEqual([false, true, true]);
});

it("refuses cancellation through a replacement physical database", () => {
  const { databasePath, original, current, cancelUpdate } = fixture();
  const saved = databasePath + ".saved";
  fs.renameSync(databasePath, saved);
  fs.copyFileSync(saved, databasePath);
  try {
    expect(() => cancelUpdate(original)).toThrow(/identity/);
  } finally {
    fs.rmSync(databasePath);
    fs.renameSync(saved, databasePath);
  }
  expect([current(original), cancelUpdate(original)?.release()]).toEqual([true, true]);
});

async function nativeCommandFixture() {
  const f = fixture();
  const { lease: retained } = claim(f, path.join(f.root, "retained"), "retained", update);
  const roots = [f.root, retained.key];
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
  expect(f.cancelUpdate(f.original, f.retained)?.release()).toBe(true);
});

test.each([false, true])("joins bound commands before release (paired=%s)", async (bothRoots) => {
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
    const fenced = { kind: "current", lease: { version: 4 } };
    expect(f.roots.map(f.read)).toMatchObject([fenced, fenced]);
    expect(() => f.custody.reserve([process.execPath])).toThrow();
    expect(f.releaseAll(commands)).toBe(false);
  } else {
    const peer = f.readCommandChildren([f.retained.key])[0];
    assert(peer, "Missing retained command alias");
    expect([f.current(f.retained), f.current(peer)]).toEqual([true, false]);
    const { custody } = await createManagedCommandProcessCustody({
      roots: [peer.key],
      parents: [peer],
      databasePath: f.databasePath,
      runId: "retained-only-descendant",
    });
    expect(() => custody.reserve([process.execPath])).toThrow(
      "Managed command custody reservation is busy",
    );
  }
  groupAlive = false;
  if (bothRoots) {
    expect([f.release(commands[0]!), f.readCommandChildren(f.roots)]).toEqual([false, commands]);
  }
  reservation.settled();
  expect(f.readCommandChildren(f.roots)).toEqual([]);
  expect(cancelled?.release()).toBe(true);
  if (!bothRoots) {
    expect([f.current(f.retained), f.release(f.retained)]).toEqual([true, true]);
  }
});

it("refuses cancellation over a legacy receiver", () => {
  const { childKey, original, ...store } = fixture();
  const { lease: child } = claim(store, childKey, "unknown", update);
  expect([store.cancelUpdate(original), store.current(original)]).toEqual([null, true]);
  expect(store.read(child.key)).toEqual({ kind: "current", lease: child });
});

test.each(["unrecognized", "foreign"] as const)("refuses %s command ownership", async (kind) => {
  const f = await nativeCommandFixture();
  if (kind === "unrecognized") {
    const { lease: child } = claim(f, f.childKey, "unknown", { ...update, custody: "reserved" });
    const bound = f.bindUpdateChildren([child], f.processIdentity(process.ppid));
    assert(bound, "Missing bound child fixture");
    expect(f.cancelUpdate(f.original)).toBeNull();
    expect(f.read(bound[0]!.key)).toEqual({ kind: "current", lease: bound[0] });
  } else {
    f.custody.reserve([process.execPath]).spawned({ pid: process.ppid, startedAt: null });
    const commands = f.readCommandChildren([f.retained.key]);
    expect(commands).toHaveLength(1);
    const key = commands[0]!.key;
    // Corrupt only the alias owner; cancellation must preserve the foreign row.
    using db = new DatabaseSync(f.databasePath);
    db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run("other", key);
    expect(f.cancelUpdate(f.original, f.retained)).toBeNull();
    expect(f.read(key)).toMatchObject({ kind: "current", lease: { owner: "other" } });
  }
  expect([f.original, f.retained].map(f.current)).toEqual([true, true]);
});
