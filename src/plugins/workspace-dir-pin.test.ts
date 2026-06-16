// Verifies the active plugin-registry workspace dir pin is stable under
// concurrent mutation, matching the sessions.list concurrency scenario
// described in issue #90814.
import { afterEach, describe, expect, it } from "vitest";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  getActivePluginRegistryWorkspaceDirFromState,
} from "./runtime-workspace-state.js";
import {
  getPinnedWorkspaceDir,
  runWithPinnedWorkspaceDir,
} from "./workspace-dir-pin.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

function setActiveWorkspace(workspaceDir: string): void {
  setActivePluginRegistry(
    createEmptyPluginRegistry(),
    workspaceDir,
    "gateway-bindable",
    workspaceDir,
  );
}

describe("workspace dir pin", () => {
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
    await runWithPinnedWorkspaceDir("/workspace/a", async () => {
      observed.push(getActivePluginRegistryWorkspaceDirFromState());
      // Simulate a concurrent agent-turn/cron mutating the global mid-batch,
      // across an event-loop yield like sessions.list performs between batches.
      setActiveWorkspace("/workspace/b");
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      observed.push(getActivePluginRegistryWorkspaceDirFromState());
    });

    // Both reads inside the pinned scope return the value captured at scope
    // entry, immune to the mid-batch mutation.
    expect(observed).toEqual(["/workspace/a", "/workspace/a"]);
    // Once the scope exits, reads observe the live (mutated) global again.
    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/b");
  });

  it("reuses the outer pin for nested scopes", async () => {
    setActiveWorkspace("/workspace/a");

    await runWithPinnedWorkspaceDir("/workspace/a", async () => {
      setActiveWorkspace("/workspace/b");
      await runWithPinnedWorkspaceDir("/workspace/b", async () => {
        // Nested scope must reuse the outer pin, not re-capture the
        // mutated global.
        expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/a");
      });
    });
  });

  it("propagates rejections and leaves no sticky pinned context", async () => {
    setActiveWorkspace("/workspace/a");

    await expect(
      runWithPinnedWorkspaceDir("/workspace/a", async () => {
        setActiveWorkspace("/workspace/b");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    // After the failed scope exits, reads observe the live global again —
    // no leak.
    expect(getActivePluginRegistryWorkspaceDirFromState()).toBe("/workspace/b");
  });

  it("returns undefined from getPinnedWorkspaceDir when no pin is active", () => {
    setActiveWorkspace("/workspace/a");
    expect(getPinnedWorkspaceDir()).toBeUndefined();
  });

  it("getPinnedWorkspaceDir returns the pinned value inside a scope", () => {
    setActiveWorkspace("/workspace/a");
    runWithPinnedWorkspaceDir("/workspace/a", () => {
      expect(getPinnedWorkspaceDir()).toBe("/workspace/a");
    });
    expect(getPinnedWorkspaceDir()).toBeUndefined();
  });

  it("pinning undefined workspace dir is safe (cold-start / single-tenant)", () => {
    // No setActiveWorkspace call — workspaceDir is undefined.
    runWithPinnedWorkspaceDir(undefined, () => {
      expect(getActivePluginRegistryWorkspaceDirFromState()).toBeUndefined();
    });
  });
});
