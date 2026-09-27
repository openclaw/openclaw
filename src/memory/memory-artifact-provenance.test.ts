import { mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as pluginState from "../plugin-state/plugin-state-store.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { createDeferredCore } from "../shared/deferred.js";
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
            update: (...args) => delay(() => store.update(...args)),
            deleteIf: (...args) => delay(() => store.deleteIf(...args)),
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
