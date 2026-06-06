// Regression for #90814: sessions.list per-row plugin-metadata lookup must
// see a stable workspaceDir snapshot for the duration of the batch, even when
// a concurrent agent-turn/cron mutates the global active-registry workspace
// across the loop's `setImmediate` yields.
import { afterEach, describe, expect, it } from "vitest";
import {
  getActivePluginRegistryWorkspaceDirFromState,
  withPinnedActivePluginRegistryWorkspaceDir,
} from "./runtime-workspace-state.js";

const PLUGIN_REGISTRY_STATE = Symbol.for("openclaw.pluginRegistryState");

type GlobalWithRegistry = typeof globalThis & {
  [PLUGIN_REGISTRY_STATE]?: { workspaceDir?: string | null };
};

function setGlobalWorkspaceDir(workspaceDir: string | undefined): void {
  const g = globalThis as GlobalWithRegistry;
  const existing = g[PLUGIN_REGISTRY_STATE];
  if (existing) {
    existing.workspaceDir = workspaceDir ?? null;
  } else {
    g[PLUGIN_REGISTRY_STATE] = { workspaceDir: workspaceDir ?? null };
  }
}

function clearGlobalWorkspaceDir(): void {
  const g = globalThis as GlobalWithRegistry;
  delete g[PLUGIN_REGISTRY_STATE];
}

describe("withPinnedActivePluginRegistryWorkspaceDir", () => {
  afterEach(() => {
    clearGlobalWorkspaceDir();
  });

  it("keeps the workspaceDir stable across yields while the global is mutated", async () => {
    setGlobalWorkspaceDir("/wsA");

    const readsInsidePin: (string | undefined)[] = [];

    const result = await withPinnedActivePluginRegistryWorkspaceDir(async () => {
      // Simulate a concurrent agent-turn/cron mutating the global active
      // plugin-registry workspace dir between row batches.
      for (let i = 0; i < 5; i++) {
        readsInsidePin.push(getActivePluginRegistryWorkspaceDirFromState());
        setGlobalWorkspaceDir(`/wsConcurrent-${i}`);
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      readsInsidePin.push(getActivePluginRegistryWorkspaceDirFromState());
      return readsInsidePin.slice();
    });

    // Every read inside the pinned scope must return the snapshot captured
    // at entry, regardless of concurrent global mutations.
    expect(result.every((v) => v === "/wsA")).toBe(true);

    // Outside the pin, reads observe the live (mutated) global.
    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/wsConcurrent-4");
  });

  it("nested calls reuse the outer pin snapshot", async () => {
    setGlobalWorkspaceDir("/outer");

    await withPinnedActivePluginRegistryWorkspaceDir(async () => {
      expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/outer");
      // Mutate global while inside the outer pin.
      setGlobalWorkspaceDir("/changed");
      await withPinnedActivePluginRegistryWorkspaceDir(() => {
        // Nested call must keep the outer snapshot, not re-read the (now
        // mutated) global.
        expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/outer");
      });
      expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/outer");
    });

    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/changed");
  });

  it("returns undefined when no global workspaceDir is set and no pin is active", () => {
    clearGlobalWorkspaceDir();
    expect(getActivePluginRegistryWorkspaceDirFromState()).toBeUndefined();
  });
});
