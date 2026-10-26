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

type Address = Parameters<typeof read>[0];
const test = it.extend<{ tempRoot: string; address: Address }>({
  tempRoot: async ({ task }, use) =>
    withStateDirEnv(`openclaw-memory-artifact-${task.id}-`, ({ tempRoot }) => use(tempRoot)),
  address: async ({ tempRoot }, use) => use({ workspaceDir: tempRoot, relativePath: "MEMORY.md" }),
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
});

function write(
  address: Address,
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

async function expectOrigin(address: Address, originClass: string, observedAt: number) {
  await expect(read(address)).resolves.toMatchObject({ originClass, observedAt });
}

test("lists one workspace in order and preserves corruption", async ({ tempRoot }) => {
  const workspaceDir = path.join(tempRoot, "workspace");
  const expectedPaths = ["memory/first.md", "MEMORY.md", "memory/late.md"];
  for (const relativePath of [...expectedPaths.toReversed(), "memory/expired.md"]) {
    await write({ workspaceDir, relativePath }, "", "synthetic note", 1, "untrusted");
  }
  await write(
    { workspaceDir: path.join(tempRoot, "other"), relativePath: "memory/other.md" },
    "",
    "other",
    1,
  );
  const { db } = openOpenClawStateDatabase();
  const update = (assignment: string, condition = "") =>
    // sqlite-allow-raw -- Seed ordering, expiry, and corruption at the storage boundary.
    db
      .prepare(`UPDATE plugin_state_entries SET ${assignment}
      WHERE plugin_id = ? AND namespace = ? ${condition}`)
      .run("core:memory-artifact-provenance", "workspace-files");
  update(`
         created_at = CASE json_extract(value_json, '$.relativePath') WHEN 'memory/late.md' THEN 20 ELSE 10 END,
         expires_at = CASE json_extract(value_json, '$.relativePath') WHEN 'memory/expired.md' THEN 1 ELSE NULL END
  `);
  const selected = await list({ workspaceDir });
  expect(selected.map((entry) => entry.relativePath)).toEqual(expectedPaths);
  update(
    "value_json = '{malformed'",
    "AND (expires_at = 1 OR json_extract(value_json, '$.relativePath') = 'memory/other.md')",
  );
  await expect(list({ workspaceDir })).resolves.toEqual(selected);
  update("value_json = '{malformed'", "AND json_valid(value_json)");
  await expect(list({ workspaceDir })).rejects.toMatchObject({ code: "PLUGIN_STATE_CORRUPT" });
});

test.for(["write", "restore", "remove", "clear"] as const)(
  "awaits %s persistence and propagates rejection",
  async (operation, { address }) => {
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
  await expect(list({ workspaceDir })).resolves.toMatchObject([{ relativePath }]);
});

test("keeps the least-trusted origin sticky across later writes", async ({ address }) => {
  await write(address, "", "restricted", 1, "untrusted");
  await write(address, "restricted", "restricted\ntrusted", 2);
  resetPluginStateStoreForTests();
  await expectOrigin(address, "untrusted", 2);
});

test("does not let an older rollback erase a later reservation", async ({ address }) => {
  const rollback = await write(address, "", "first", 1);
  await write(address, "first", "second", 2);
  await rollback?.();
  await expectOrigin(address, "agent", 2);
});

test.for(["write", "rollback", "clear"] as const)(
  "preserves concurrent provenance when %s conflicts",
  async (operation, { address }) => {
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
