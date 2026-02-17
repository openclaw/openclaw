import { afterEach, describe, expect, it, vi } from "vitest";
import {
  McpApprovalManager,
  requiresMcpApproval,
  resolveApprovalMode,
  resetMcpApprovalManagerForTest,
} from "./approvals.js";
import type { McpServerConfig } from "./types.js";

afterEach(() => {
  resetMcpApprovalManagerForTest();
});

// ---------------------------------------------------------------------------
// requiresMcpApproval
// ---------------------------------------------------------------------------

describe("requiresMcpApproval", () => {
  it("returns false when approval is 'none'", () => {
    const config: McpServerConfig = { command: "echo", approval: "none" };
    expect(requiresMcpApproval(config, "any_tool")).toBe(false);
  });

  it("returns false when approval is not set (defaults to none)", () => {
    const config: McpServerConfig = { command: "echo" };
    expect(requiresMcpApproval(config, "any_tool")).toBe(false);
  });

  it("returns true when approval is 'always'", () => {
    const config: McpServerConfig = { command: "echo", approval: "always" };
    expect(requiresMcpApproval(config, "any_tool")).toBe(true);
  });

  it("returns false for allowlisted tools", () => {
    const config: McpServerConfig = {
      command: "echo",
      approval: "allowlist",
      approvedTools: ["safe_read", "safe_list"],
    };
    expect(requiresMcpApproval(config, "safe_read")).toBe(false);
    expect(requiresMcpApproval(config, "safe_list")).toBe(false);
  });

  it("returns true for non-allowlisted tools", () => {
    const config: McpServerConfig = {
      command: "echo",
      approval: "allowlist",
      approvedTools: ["safe_read"],
    };
    expect(requiresMcpApproval(config, "dangerous_write")).toBe(true);
  });

  it("returns true when allowlist mode but no approvedTools set", () => {
    const config: McpServerConfig = { command: "echo", approval: "allowlist" };
    expect(requiresMcpApproval(config, "any_tool")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolveApprovalMode
// ---------------------------------------------------------------------------

describe("resolveApprovalMode", () => {
  it("defaults to 'none' for undefined", () => {
    expect(resolveApprovalMode({ command: "echo" })).toBe("none");
  });

  it("passes through valid modes", () => {
    expect(resolveApprovalMode({ command: "echo", approval: "always" })).toBe("always");
    expect(resolveApprovalMode({ command: "echo", approval: "allowlist" })).toBe("allowlist");
    expect(resolveApprovalMode({ command: "echo", approval: "none" })).toBe("none");
  });

  it("defaults to 'always' for invalid values (fail-closed)", () => {
    expect(resolveApprovalMode({ command: "echo", approval: "invalid" as "none" })).toBe("always");
  });
});

// ---------------------------------------------------------------------------
// McpApprovalManager
// ---------------------------------------------------------------------------

describe("McpApprovalManager", () => {
  it("resolves when a decision is provided", async () => {
    const manager = new McpApprovalManager();
    const promise = manager.register({
      id: "req-1",
      serverName: "srv",
      toolName: "tool",
      args: {},
      timestamp: Date.now(),
    });

    expect(manager.size).toBe(1);
    manager.resolve("req-1", "allow");
    const decision = await promise;
    expect(decision).toBe("allow");
    expect(manager.size).toBe(0);
  });

  it("resolves with 'deny' on cancel", async () => {
    const manager = new McpApprovalManager();
    const promise = manager.register({
      id: "req-2",
      serverName: "srv",
      toolName: "tool",
      args: {},
      timestamp: Date.now(),
    });

    manager.cancel("req-2");
    const decision = await promise;
    expect(decision).toBe("deny");
  });

  it("times out with 'timeout' decision", async () => {
    const manager = new McpApprovalManager({ defaultTimeoutMs: 50 });
    const promise = manager.register({
      id: "req-3",
      serverName: "srv",
      toolName: "tool",
      args: {},
      timestamp: Date.now(),
    });

    const decision = await promise;
    expect(decision).toBe("timeout");
  });

  it("returns false when resolving non-existent request", () => {
    const manager = new McpApprovalManager();
    expect(manager.resolve("nonexistent", "allow")).toBe(false);
  });

  it("lists pending requests", () => {
    const manager = new McpApprovalManager();
    const req = {
      id: "req-4",
      serverName: "srv",
      toolName: "tool",
      args: { key: "val" },
      timestamp: 1234,
    };
    manager.register(req);

    const pending = manager.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("req-4");

    manager.cancel("req-4");
  });

  it("clears all pending requests", async () => {
    const manager = new McpApprovalManager();
    const p1 = manager.register({
      id: "a",
      serverName: "srv",
      toolName: "t1",
      args: {},
      timestamp: 0,
    });
    const p2 = manager.register({
      id: "b",
      serverName: "srv",
      toolName: "t2",
      args: {},
      timestamp: 0,
    });

    expect(manager.size).toBe(2);
    manager.clear();
    expect(manager.size).toBe(0);

    // Both should resolve to deny.
    expect(await p1).toBe("deny");
    expect(await p2).toBe("deny");
  });

  it("gets a pending request by ID", () => {
    const manager = new McpApprovalManager();
    const req = {
      id: "req-5",
      serverName: "srv",
      toolName: "tool",
      args: {},
      timestamp: 0,
    };
    manager.register(req);

    expect(manager.get("req-5")).toEqual(req);
    expect(manager.get("nonexistent")).toBeUndefined();

    manager.cancel("req-5");
  });
});
