import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import {
  declareAgentWorkspaceAccess,
  getAgentWorkspaceAccess,
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
  it("leaves unconfigured workspaces local and declared workspaces unavailable until start", () => {
    const root = workspace();
    expect(getAgentWorkspaceAccess(root)).toBeUndefined();
    declareAgentWorkspaceAccess(root);
    expect(() => getAgentWorkspaceAccess(root)).toThrow("stopped or not ready");
    const release = registerAgentWorkspaceAccess(root, provider());
    expect(getAgentWorkspaceAccess(root)).toBeDefined();
    release();
    expect(() => getAgentWorkspaceAccess(root)).toThrow("stopped or not ready");
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
    const rejected = expect(read).rejects.toThrow("stopped or not ready");
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
    const rejected = expect(read).rejects.toThrow("stopped or not ready");
    release();
    pending.resolve({ data: Buffer.from("late result"), canonicalPath: "/remote/AGENTS.md" });
    await rejected;
  });
});
