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

  it.each(
    (["write", "restore", "remove", "clear"] as const).flatMap((operation) =>
      (["resolve", "reject"] as const).map((outcome) => ({ operation, outcome })),
    ),
  )("awaits $operation persistence through $outcome", async ({ operation, outcome }) => {
    await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
      const address = { workspaceDir: tempRoot, relativePath: "MEMORY.md" };
      const write = (contentBefore: string, contentAfter: string, observedAt: number) =>
        recordMemoryArtifactWriteProvenance({
          ...address,
          contentBefore,
          contentAfter,
          originClass: "agent",
          observedAt,
        });
      let rollback: (() => Promise<void>) | undefined;
      if (operation !== "write") {
        rollback = await write("", "first", 1);
        if (operation === "restore") {
          rollback = await write("first", "second", 2);
        }
      }
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const createStore = pluginState.createCorePluginStateKeyedStore;
      vi.spyOn(pluginState, "createCorePluginStateKeyedStore").mockImplementation((options) => {
        const store = createStore(options);
        const delay = async () => {
          entered.resolve();
          await release.promise;
        };
        return {
          ...store,
          update: async (...args) => {
            await delay();
            return store.update(...args);
          },
          deleteIf: async (...args) => {
            await delay();
            return store.deleteIf(...args);
          },
        };
      });
      const pending =
        operation === "write"
          ? write("", "first", 1)
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
        if (outcome === "reject") {
          const error = new Error("synthetic persistence rejection");
          release.reject(error);
          await expect(pending).rejects.toBe(error);
        } else {
          release.resolve();
          await pending;
          const stored = await readMemoryArtifactProvenance(address);
          if (operation === "write" || operation === "restore") {
            expect(stored).toMatchObject({ observedAt: 1 });
          } else {
            expect(stored).toBeUndefined();
          }
        }
      } finally {
        release.resolve();
        await settled;
      }
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

      await recordMemoryArtifactWriteProvenance({
        workspaceDir: workspaceAlias,
        relativePath,
        contentBefore: "",
        contentAfter: "restricted",
        originClass: "untrusted",
        observedAt: 1,
      });

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
      await recordMemoryArtifactWriteProvenance({
        ...address,
        contentBefore: "",
        contentAfter: "restricted",
        originClass: "untrusted",
        observedAt: 1,
      });
      await recordMemoryArtifactWriteProvenance({
        ...address,
        contentBefore: "restricted",
        contentAfter: "restricted\ntrusted",
        originClass: "agent",
        observedAt: 2,
      });

      resetPluginStateStoreForTests();

      await expect(readMemoryArtifactProvenance(address)).resolves.toMatchObject({
        originClass: "untrusted",
        observedAt: 2,
      });
      await expect(listMemoryArtifactProvenance({ workspaceDir: tempRoot })).resolves.toEqual([
        expect.objectContaining({ relativePath: address.relativePath }),
      ]);
    });
  });

  it("does not let an older rollback erase a later reservation", async () => {
    await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
      const address = { workspaceDir: tempRoot, relativePath: "MEMORY.md" };
      const rollback = await recordMemoryArtifactWriteProvenance({
        ...address,
        contentBefore: "",
        contentAfter: "first",
        originClass: "agent",
        observedAt: 1,
      });
      await recordMemoryArtifactWriteProvenance({
        ...address,
        contentBefore: "first",
        contentAfter: "second",
        originClass: "agent",
        observedAt: 2,
      });

      await rollback?.();

      await expect(readMemoryArtifactProvenance(address)).resolves.toMatchObject({
        originClass: "agent",
        observedAt: 2,
      });
    });
  });

  it.each(["USER.md", "users/person/USER.md"])(
    "clears only matching deleted content: %s",
    async (relativePath) => {
      await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
        const address = { workspaceDir: tempRoot, relativePath };
        await recordMemoryArtifactWriteProvenance({
          ...address,
          contentBefore: "",
          contentAfter: "current",
          originClass: "agent",
          observedAt: 1,
        });

        await clearMemoryArtifactProvenance({ ...address, contentBefore: "stale" });
        await expect(readMemoryArtifactProvenance(address)).resolves.toBeDefined();
        await clearMemoryArtifactProvenance({ ...address, contentBefore: "current" });
        await expect(readMemoryArtifactProvenance(address)).resolves.toBeUndefined();
      });
    },
  );

  it("accepts only host-owned memory artifact paths", () => {
    expect(normalizeMemoryArtifactRelativePath("memory/2026-08-20.md")).toBe(
      "memory/2026-08-20.md",
    );
    expect(normalizeMemoryArtifactRelativePath("MEMORY.md")).toBe("MEMORY.md");
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
