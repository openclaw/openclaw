import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as pluginState from "../plugin-state/plugin-state-store.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import {
  clearMemoryArtifactProvenance,
  listMemoryArtifactProvenance,
  normalizeMemoryArtifactRelativePath,
  readMemoryArtifactProvenance,
  recordMemoryArtifactWriteProvenance,
} from "./memory-artifact-provenance.js";

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
  return recordMemoryArtifactWriteProvenance({
    ...address,
    contentBefore,
    contentAfter,
    observedAt,
    originClass,
  });
}

describe("memory artifact provenance", () => {
  it("reads only the selected workspace while preserving order and corruption errors", async () => {
    await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
      const workspaceDir = path.join(tempRoot, "workspace");
      for (const relativePath of [
        "memory/late.md",
        "MEMORY.md",
        "memory/first.md",
        "memory/expired.md",
      ]) {
        await recordMemoryArtifactWriteProvenance({
          workspaceDir,
          relativePath,
          contentBefore: "",
          contentAfter: "synthetic note",
          originClass: "untrusted",
          observedAt: 1,
        });
      }
      await recordMemoryArtifactWriteProvenance({
        workspaceDir: path.join(tempRoot, "other-workspace"),
        relativePath: "memory/other.md",
        contentBefore: "",
        contentAfter: "synthetic other note",
        originClass: "agent",
        observedAt: 1,
      });
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
        return {
          ...store,
          entries: async () => {
            const entries = await store.entries();
            materializedKeys.push(...entries.map((entry) => entry.key));
            return entries;
          },
          entriesInKeyRange: async (range) => {
            const entries = await store.entriesInKeyRange(range);
            materializedKeys.push(...entries.map((entry) => entry.key));
            return entries;
          },
        };
      });
      const selected = await listMemoryArtifactProvenance({ workspaceDir });
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
      ).run(
        "{malformed",
        "core:memory-artifact-provenance",
        "workspace-files",
        ...materializedKeys,
      );
      await expect(listMemoryArtifactProvenance({ workspaceDir })).resolves.toEqual(selected);
      // sqlite-allow-raw -- A selected corrupt row must still fail through the real worker reader.
      db.prepare(
        "UPDATE plugin_state_entries SET value_json = ? WHERE plugin_id = ? AND namespace = ? AND entry_key = ?",
      ).run("{malformed", "core:memory-artifact-provenance", "workspace-files", selectedKey);
      await expect(listMemoryArtifactProvenance({ workspaceDir })).rejects.toMatchObject({
        code: "PLUGIN_STATE_CORRUPT",
      });
    });
  });

  it.each(["write", "restore", "remove", "clear"] as const)(
    "awaits %s persistence and propagates rejection",
    async (operation) => {
      await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
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
        const createStore = pluginState.createCorePluginStateKeyedStore;
        vi.spyOn(pluginState, "createCorePluginStateKeyedStore").mockImplementation((options) => {
          const store = createStore(options);
          const delay = async <T>(persist: () => Promise<T>) => {
            entered.resolve();
            await release.promise;
            return persist();
          };
          return {
            ...store,
            compareAndApply: (...args) => delay(() => store.compareAndApply(...args)),
          };
        });
        const pending =
          operation === "write"
            ? write(address, "", "first", 1)
            : operation === "clear"
              ? clearMemoryArtifactProvenance({ ...address, contentBefore: "first" })
              : expectDefined(rollback, "provenance rollback")();
        const settled = pending.then(
          () => "settled",
          () => "settled",
        );
        try {
          expect(await Promise.race([entered.promise.then(() => "waiting"), settled])).toBe(
            "waiting",
          );
          const error = new Error("synthetic persistence rejection");
          release.reject(error);
          await expect(pending).rejects.toBe(error);
        } finally {
          release.resolve();
          await settled;
        }
      });
    },
  );

  it("restores the previous provenance on rollback", async () => {
    await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
      const address = { workspaceDir: tempRoot, relativePath: "MEMORY.md" };
      await write(address, "", "first", 1);
      const rollback = await write(address, "first", "second", 2);
      await expectDefined(rollback, "provenance rollback")();
      await expect(readMemoryArtifactProvenance(address)).resolves.toMatchObject({ observedAt: 1 });
    });
  });

  it("uses the same workspace identity through symlink aliases", async () => {
    await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
      const workspaceDir = path.join(tempRoot, "workspace");
      const workspaceAlias = path.join(tempRoot, "workspace-alias");
      const relativePath = "memory/2026-08-20.md";
      await mkdir(workspaceDir);
      await symlink(
        workspaceDir,
        workspaceAlias,
        process.platform === "win32" ? "junction" : "dir",
      );

      await write({ workspaceDir: workspaceAlias, relativePath }, "", "restricted", 1, "untrusted");

      await expect(
        readMemoryArtifactProvenance({ workspaceDir, relativePath }),
      ).resolves.toMatchObject({ originClass: "untrusted" });
      await expect(listMemoryArtifactProvenance({ workspaceDir })).resolves.toEqual([
        expect.objectContaining({ relativePath }),
      ]);
    });
  });

  it("keeps the least-trusted origin sticky across later writes", async () => {
    await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
      const address = { workspaceDir: tempRoot, relativePath: "memory/2026-08-20.md" };
      await write(address, "", "restricted", 1, "untrusted");
      await write(address, "restricted", "restricted\ntrusted", 2);

      resetPluginStateStoreForTests();

      await expect(readMemoryArtifactProvenance(address)).resolves.toMatchObject({
        originClass: "untrusted",
        observedAt: 2,
      });
    });
  });

  it("does not let an older rollback erase a later reservation", async () => {
    await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
      const address = { workspaceDir: tempRoot, relativePath: "MEMORY.md" };
      const rollback = await write(address, "", "first", 1);
      await write(address, "first", "second", 2);

      await rollback?.();

      await expect(readMemoryArtifactProvenance(address)).resolves.toMatchObject({
        originClass: "agent",
        observedAt: 2,
      });
    });
  });

  it.each(["write", "rollback", "clear"] as const)(
    "preserves concurrent provenance when %s conflicts",
    async (operation) => {
      await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
        const address = { workspaceDir: tempRoot, relativePath: "MEMORY.md" };
        const firstRollback = expectDefined(
          await write(address, "", "first", 1),
          "first provenance rollback",
        );
        const createStore = pluginState.createCorePluginStateKeyedStore;
        let replaceBeforeCommit = true;
        vi.spyOn(pluginState, "createCorePluginStateKeyedStore").mockImplementation((options) => {
          const store = createStore(options);
          return {
            ...store,
            compareAndApply: async (...args) => {
              if (replaceBeforeCommit) {
                replaceBeforeCommit = false;
                await write(address, "first", "concurrent", 3, "untrusted");
              }
              return store.compareAndApply(...args);
            },
          };
        });

        if (operation === "write") {
          const rollback = expectDefined(
            await write(address, "first", "second", 2),
            "replacement provenance rollback",
          );
          await expect(readMemoryArtifactProvenance(address)).resolves.toMatchObject({
            originClass: "untrusted",
            observedAt: 2,
          });
          await rollback();
        } else if (operation === "rollback") {
          await firstRollback();
        } else {
          await clearMemoryArtifactProvenance({ ...address, contentBefore: "first" });
        }

        await expect(readMemoryArtifactProvenance(address)).resolves.toMatchObject({
          originClass: "untrusted",
          observedAt: 3,
        });
      });
    },
  );

  it("clears only matching deleted content", async () => {
    await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
      const address = { workspaceDir: tempRoot, relativePath: "users/person/USER.md" };
      await write(address, "", "current", 1);

      await clearMemoryArtifactProvenance({ ...address, contentBefore: "stale" });
      await expect(readMemoryArtifactProvenance(address)).resolves.toBeDefined();
      await clearMemoryArtifactProvenance({ ...address, contentBefore: "current" });
      await expect(readMemoryArtifactProvenance(address)).resolves.toBeUndefined();
    });
  });

  it("accepts only host-owned memory artifact paths", () => {
    expect(normalizeMemoryArtifactRelativePath("memory/2026-08-20.md")).toBe(
      "memory/2026-08-20.md",
    );
    expect(normalizeMemoryArtifactRelativePath("MEMORY.md")).toBe("MEMORY.md");
    expect(normalizeMemoryArtifactRelativePath("USER.md")).toBe("USER.md");
    expect(normalizeMemoryArtifactRelativePath("users/person/USER.md")).toBe(
      "users/person/USER.md",
    );
    for (const invalid of [
      "users/../USER.md",
      "users/person/nested/USER.md",
      "users/person/notes.md",
    ]) {
      expect(normalizeMemoryArtifactRelativePath(invalid)).toBeUndefined();
    }
    expect(normalizeMemoryArtifactRelativePath("memory/dreaming/state.md")).toBeUndefined();
    expect(normalizeMemoryArtifactRelativePath("../memory/escape.md")).toBeUndefined();
  });
});
