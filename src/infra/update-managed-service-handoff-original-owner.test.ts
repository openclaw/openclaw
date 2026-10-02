import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { installPrivateUpdateHandoffStore } from "../../test/helpers/private-update-handoff-store.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
