import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import * as pluginState from "../plugin-state/plugin-state-store.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  clearMemoryArtifactProvenance as clear,
  listMemoryArtifactProvenance as list,
  normalizeMemoryArtifactRelativePath as normalizePath,
  readMemoryArtifactProvenance as read,
  recordMemoryArtifactWriteProvenance as recordWrite,
} from "./memory-artifact-provenance.js";

const test = it.extend<{ tempRoot: string }>({
  tempRoot: async ({ task }, use) =>
    withStateDirEnv(`openclaw-memory-artifact-${task.id}-`, ({ tempRoot }) => use(tempRoot)),
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
});

function write(
  address: { workspaceDir: string; relativePath: string },
  contentBefore: string,
  contentAfter: string,
  observedAt: number,
  originClass: "agent" | "untrusted" = "agent",
) {
  return recordWrite({ ...address, contentBefore, contentAfter, observedAt, originClass });
}

function beforePersist(before: () => Promise<void>) {
  const createStore = pluginState.createCorePluginStateKeyedStore;
  vi.spyOn(pluginState, "createCorePluginStateKeyedStore").mockImplementation((options) => {
    const store = createStore(options);
    return {
      ...store,
      compareAndApply: async (...args) => {
        await before();
        return store.compareAndApply(...args);
      },
    };
  });
}

type Address = Parameters<typeof read>[0];
async function expectOrigin(address: Address, originClass: string, observedAt: number) {
  await expect(read(address)).resolves.toMatchObject({ originClass, observedAt });
}

test("lists one workspace in order and preserves corruption", async ({ tempRoot }) => {
  const workspaceDir = path.join(tempRoot, "workspace");
  for (const relativePath of [
    "memory/late.md",
    "MEMORY.md",
    "memory/first.md",
    "memory/expired.md",
  ]) {
    await write({ workspaceDir, relativePath }, "", "synthetic note", 1, "untrusted");
  }
  const other = { workspaceDir: path.join(tempRoot, "other"), relativePath: "memory/other.md" };
  await write(other, "", "synthetic other note", 1);
  const { db } = openOpenClawStateDatabase();
  // sqlite-allow-raw -- Seed historical ordering, expiry, and corruption at the storage boundary.
  db.prepare(
    `UPDATE plugin_state_entries SET
         created_at = CASE json_extract(value_json, '$.relativePath') WHEN 'memory/late.md' THEN 20 ELSE 10 END,
         expires_at = CASE json_extract(value_json, '$.relativePath') WHEN 'memory/expired.md' THEN 1 ELSE NULL END
         WHERE plugin_id = ? AND namespace = ?`,
  ).run("core:memory-artifact-provenance", "workspace-files");
  const materializedKeys: string[] = [];
  const createStore = pluginState.createCorePluginStateKeyedStore;
  vi.spyOn(pluginState, "createCorePluginStateKeyedStore").mockImplementation((options) => {
    const store = createStore(options);
    const capture = <T extends { key: string }>(entries: T[]) => {
      materializedKeys.push(...entries.map((entry) => entry.key));
      return entries;
    };
    return {
      ...store,
      entries: async () => capture(await store.entries()),
      entriesInKeyRange: async (range) => capture(await store.entriesInKeyRange(range)),
    };
  });
  const selected = await list({ workspaceDir });
  expect(selected.map((entry) => entry.relativePath)).toEqual([
    "memory/first.md",
    "MEMORY.md",
    "memory/late.md",
  ]);
  expect(materializedKeys).toHaveLength(3);
  const selectedKey = expectDefined(materializedKeys[0], "selected provenance key");
  // sqlite-allow-raw -- Unrelated and expired malformed JSON must not poison this workspace.
  db.prepare(
    "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key NOT IN (?, ?, ?)",
  ).run("{malformed", "core:memory-artifact-provenance", "workspace-files", ...materializedKeys);
  await expect(list({ workspaceDir })).resolves.toEqual(selected);
  // sqlite-allow-raw -- A selected corrupt row must still fail through the real worker reader.
  db.prepare(
    "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
  ).run("{malformed", "core:memory-artifact-provenance", "workspace-files", selectedKey);
  await expect(list({ workspaceDir })).rejects.toMatchObject({
    code: "PLUGIN_STATE_CORRUPT",
  });
});

test.for(["write", "restore", "remove", "clear"] as const)(
  "awaits %s persistence and propagates rejection",
  async (operation, { tempRoot }) => {
    const address = { workspaceDir: tempRoot, relativePath: "MEMORY.md" };
    let rollback: (() => Promise<void>) | undefined;
    if (operation !== "write") {
      rollback = await write(address, "", "first", 1);
      if (operation === "restore") {
        rollback = await write(address, "first", "second", 2);
      }
    }
    const entered = createDeferredCore();
    const release = createDeferredCore();
    beforePersist(async () => {
      entered.resolve();
      await release.promise;
    });
    const pending =
      operation === "write"
        ? write(address, "", "first", 1)
        : operation === "clear"
          ? clear({ ...address, contentBefore: "first" })
          : expectDefined(rollback, "provenance rollback")();
    const settled = pending.catch(() => undefined);
    try {
      expect(await Promise.race([entered.promise.then(() => "waiting"), settled])).toBe("waiting");
      const error = new Error("synthetic persistence rejection");
      release.reject(error);
      await expect(pending).rejects.toBe(error);
    } finally {
      release.resolve();
      await settled;
    }
  },
);

test("uses the same workspace identity through symlink aliases", async ({ tempRoot }) => {
  const workspaceDir = path.join(tempRoot, "workspace");
  const workspaceAlias = path.join(tempRoot, "workspace-alias");
  const relativePath = "memory/2026-08-20.md";
  await mkdir(workspaceDir);
  await symlink(workspaceDir, workspaceAlias, process.platform === "win32" ? "junction" : "dir");
  await write({ workspaceDir: workspaceAlias, relativePath }, "", "restricted", 1, "untrusted");
  await expect(read({ workspaceDir, relativePath })).resolves.toMatchObject({
    originClass: "untrusted",
  });
  await expect(list({ workspaceDir })).resolves.toEqual([
    expect.objectContaining({ relativePath }),
  ]);
});

test("keeps the least-trusted origin sticky across later writes", async ({ tempRoot }) => {
  const address = { workspaceDir: tempRoot, relativePath: "memory/2026-08-20.md" };
  await write(address, "", "restricted", 1, "untrusted");
  await write(address, "restricted", "restricted\ntrusted", 2);
  resetPluginStateStoreForTests();
  await expectOrigin(address, "untrusted", 2);
});

test("does not let an older rollback erase a later reservation", async ({ tempRoot }) => {
  const address = { workspaceDir: tempRoot, relativePath: "MEMORY.md" };
  const rollback = await write(address, "", "first", 1);
  await write(address, "first", "second", 2);
  await rollback?.();
  await expectOrigin(address, "agent", 2);
});

test.for(["write", "rollback", "clear"] as const)(
  "preserves concurrent provenance when %s conflicts",
  async (operation, { tempRoot }) => {
    const address = { workspaceDir: tempRoot, relativePath: "MEMORY.md" };
    const firstRollback = expectDefined(await write(address, "", "first", 1), "first rollback");
    let replaceBeforeCommit = true;
    beforePersist(async () => {
      if (replaceBeforeCommit) {
        replaceBeforeCommit = false;
        await write(address, "first", "concurrent", 3, "untrusted");
      }
    });
    if (operation === "write") {
      const rollback = expectDefined(await write(address, "first", "second", 2), "rollback");
      await expectOrigin(address, "untrusted", 2);
      await rollback();
    } else if (operation === "rollback") {
      await firstRollback();
    } else {
      await clear({ ...address, contentBefore: "first" });
    }
    await expectOrigin(address, "untrusted", 3);
  },
);

test("clears only matching deleted content", async ({ tempRoot }) => {
  const address = { workspaceDir: tempRoot, relativePath: "users/person/USER.md" };
  await write(address, "", "current", 1);
  await clear({ ...address, contentBefore: "stale" });
  await expect(read(address)).resolves.toBeDefined();
  await clear({ ...address, contentBefore: "current" });
  await expect(read(address)).resolves.toBeUndefined();
});

it("accepts only host-owned memory artifact paths", () => {
  for (const valid of ["memory/2026-08-20.md", "MEMORY.md", "USER.md", "users/person/USER.md"]) {
    expect(normalizePath(valid)).toBe(valid);
  }
  for (const invalid of [
    "users/../USER.md",
    "users/person/nested/USER.md",
    "users/person/notes.md",
    "memory/dreaming/state.md",
    "../memory/escape.md",
  ]) {
    expect(normalizePath(invalid)).toBeUndefined();
  }
});
