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

describe("memory artifact provenance", () => {
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

  it("clears only the record matching the deleted file content", async () => {
    await withStateDirEnv("openclaw-memory-artifact-", async ({ tempRoot }) => {
      const address = { workspaceDir: tempRoot, relativePath: "USER.md" };
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
  });

  it("accepts only host-owned memory artifact paths", () => {
    expect(normalizeMemoryArtifactRelativePath("memory/2026-08-20.md")).toBe(
      "memory/2026-08-20.md",
    );
    expect(normalizeMemoryArtifactRelativePath("MEMORY.md")).toBe("MEMORY.md");
    expect(normalizeMemoryArtifactRelativePath("memory/dreaming/state.md")).toBeUndefined();
    expect(normalizeMemoryArtifactRelativePath("../memory/escape.md")).toBeUndefined();
  });
});
