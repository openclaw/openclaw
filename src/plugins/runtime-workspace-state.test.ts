// Verifies the active plugin-registry workspace dir pin is stable under concurrent mutation.
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  getActivePluginRegistryWorkspaceDirFromState,
  withPinnedActivePluginRegistryWorkspaceDir,
} from "./runtime-workspace-state.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

function setActiveWorkspace(workspaceDir: string): void {
  setActivePluginRegistry(
    createEmptyPluginRegistry(),
    workspaceDir,
    "gateway-bindable",
    workspaceDir,
  );
}

describe("runtime workspace state pin", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("reads the live global workspace dir when no pin is active", () => {
    setActiveWorkspace("/workspace/a");
    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/a");
    setActiveWorkspace("/workspace/b");
    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/b");
  });

  it("keeps the workspace dir stable inside a pinned scope despite concurrent mutation", async () => {
    setActiveWorkspace("/workspace/a");

    const observed: Array<string | undefined> = [];
    await withPinnedActivePluginRegistryWorkspaceDir(async () => {
      observed.push(getActivePluginRegistryWorkspaceDirFromState());
      // Simulate a concurrent agent-turn/cron mutating the global mid-batch,
      // across an event-loop yield like sessions.list performs between batches.
      setActiveWorkspace("/workspace/b");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      observed.push(getActivePluginRegistryWorkspaceDirFromState());
    });

    // Both reads inside the pinned scope return the value captured at scope entry,
    // immune to the mid-batch mutation.
    expect(observed).toEqual(["/workspace/a", "/workspace/a"]);
    // Once the scope exits, reads observe the live (mutated) global again.
    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/b");
  });

  it("reuses the outer pin for nested scopes", async () => {
    setActiveWorkspace("/workspace/a");

    await withPinnedActivePluginRegistryWorkspaceDir(async () => {
      setActiveWorkspace("/workspace/b");
      await withPinnedActivePluginRegistryWorkspaceDir(async () => {
        // Nested scope must reuse the outer pin, not re-capture the mutated global.
        expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/a");
      });
    });
  });

  it("propagates rejections and leaves no sticky pinned context", async () => {
    setActiveWorkspace("/workspace/a");

    await expect(
      withPinnedActivePluginRegistryWorkspaceDir(async () => {
        setActiveWorkspace("/workspace/b");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // After the failed scope exits, reads observe the live global again — no leak.
    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/b");
  });
});
