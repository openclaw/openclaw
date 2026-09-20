import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  declareAgentWorkspaceAccess,
  getAgentWorkspaceAccess,
  isWorkspaceAccessUnavailableError,
  WorkspaceAccessUnavailableError,
  registerAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "./workspace-access.js";

function workspace() {
  return path.resolve("test-workspace", randomUUID());
}

function provider(): AgentWorkspaceAccess {
  return {
    bridge: {
      readFile: vi.fn(async () => Buffer.from("remote")),
      writeFile: vi.fn(async () => {}),
      stat: vi.fn(async () => ({ type: "file" as const, size: 6, mtimeMs: 1 })),
    },
  };
}

describe("host-owned workspace access", () => {
  it("identifies unavailable access through wrapped errors and separate SDK instances", () => {
    const cause = new Error("host offline");
    const error = new WorkspaceAccessUnavailableError("workspace unavailable", { cause });
    expect(error.cause).toBe(cause);
    expect(isWorkspaceAccessUnavailableError(error)).toBe(true);
    expect(isWorkspaceAccessUnavailableError(new Error("wrapped", { cause: error }))).toBe(true);
    // A separately loaded SDK has a different prototype, but preserves the error code.
    expect(isWorkspaceAccessUnavailableError({ code: "WORKSPACE_ACCESS_UNAVAILABLE" })).toBe(true);
    expect(isWorkspaceAccessUnavailableError(cause)).toBe(false);
    expect(
      isWorkspaceAccessUnavailableError(new Error("Workspace access is stopped or not ready")),
    ).toBe(false);
  });

  it("leaves unconfigured workspaces local and declared workspaces unavailable until start", () => {
    const root = workspace();
    expect(getAgentWorkspaceAccess(root)).toBeUndefined();
    declareAgentWorkspaceAccess(root);
    expect(() => getAgentWorkspaceAccess(root)).toThrow(WorkspaceAccessUnavailableError);
    const release = registerAgentWorkspaceAccess(root, provider());
    expect(getAgentWorkspaceAccess(root)).toBeDefined();
    release();
    expect(() => getAgentWorkspaceAccess(root)).toThrow(WorkspaceAccessUnavailableError);
  });

  it("rejects duplicate ownership and revokes retained methods without affecting a replacement", async () => {
    const root = workspace();
    const host = provider();
    const release = registerAgentWorkspaceAccess(root, host);
    const retained = getAgentWorkspaceAccess(root)!;
    expect(() => registerAgentWorkspaceAccess(root, host)).toThrow("already registered");
    release();
    await expect(
      retained.bridge.writeFile({ filePath: "AGENTS.md", data: "late" }),
    ).rejects.toThrow("stopped or not ready");
    expect(host.bridge.writeFile).not.toHaveBeenCalled();
    const releaseReplacement = registerAgentWorkspaceAccess(root, provider());
    try {
      release();
      await expect(
        getAgentWorkspaceAccess(root)!.bridge.readFile({ filePath: "AGENTS.md" }),
      ).resolves.toEqual(Buffer.from("remote"));
      await expect(retained.bridge.readFile({ filePath: "AGENTS.md" })).rejects.toThrow(
        "stopped or not ready",
      );
    } finally {
      releaseReplacement();
    }
  });

  it("rejects a result returned after ownership is revoked", async () => {
    const root = workspace();
    const host = provider();
    const pending = createDeferredCore<Buffer>();
    host.bridge.readFile = vi.fn(() => pending.promise);
    const release = registerAgentWorkspaceAccess(root, host);
    const read = getAgentWorkspaceAccess(root)!.bridge.readFile({ filePath: "AGENTS.md" });
    const rejected = expect(read).rejects.toThrow(WorkspaceAccessUnavailableError);
    release();
    pending.resolve(Buffer.from("late result"));
    await rejected;
  });

  it("preserves source-aware reads and revokes retained optional capabilities", async () => {
    const root = workspace();
    const host = provider();
    host.bridge.readFileWithSource = vi.fn(async () => ({
      data: Buffer.from("remote"),
      canonicalPath: "/remote/MEMORY.md",
    }));
    host.bridge.readDirectory = vi.fn(async () => [{ name: "MEMORY.md", isDirectory: false }]);
    const release = registerAgentWorkspaceAccess(root, host);
    const retained = getAgentWorkspaceAccess(root)!;
    await expect(
      retained.bridge.readFileWithSource!({ filePath: "alias/MEMORY.md", maxBytes: 6 }),
    ).resolves.toEqual({ data: Buffer.from("remote"), canonicalPath: "/remote/MEMORY.md" });
    release();
    await expect(
      retained.bridge.readFileWithSource!({ filePath: "alias/MEMORY.md" }),
    ).rejects.toThrow("stopped or not ready");
    await expect(retained.bridge.readDirectory!({ filePath: "." })).rejects.toThrow(
      "stopped or not ready",
    );
    expect(host.bridge.readFileWithSource).toHaveBeenCalledTimes(1);
    expect(host.bridge.readDirectory).not.toHaveBeenCalled();
  });

  it("does not return source metadata after access is revoked during a read", async () => {
    const root = workspace();
    const host = provider();
    const pending = createDeferredCore<{ data: Buffer; canonicalPath: string }>();
    host.bridge.readFileWithSource = vi.fn(() => pending.promise);
    const release = registerAgentWorkspaceAccess(root, host);
    const read = getAgentWorkspaceAccess(root)!.bridge.readFileWithSource!({
      filePath: "AGENTS.md",
    });
    const rejected = expect(read).rejects.toThrow(WorkspaceAccessUnavailableError);
    release();
    pending.resolve({ data: Buffer.from("late result"), canonicalPath: "/remote/AGENTS.md" });
    await rejected;
  });
});
