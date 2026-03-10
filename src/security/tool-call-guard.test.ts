import { describe, expect, it } from "vitest";
import { evaluateToolCallGuard, isDestructiveToolCall } from "./tool-call-guard.js";

describe("isDestructiveToolCall", () => {
  it("flags exec/shell tools", () => {
    expect(isDestructiveToolCall("system_run")).toBe(true);
    expect(isDestructiveToolCall("system.run")).toBe(true);
    expect(isDestructiveToolCall("exec")).toBe(true);
    expect(isDestructiveToolCall("bash")).toBe(true);
    expect(isDestructiveToolCall("shell")).toBe(true);
  });

  it("flags file mutation tools", () => {
    expect(isDestructiveToolCall("write")).toBe(true);
    expect(isDestructiveToolCall("edit")).toBe(true);
    expect(isDestructiveToolCall("apply_patch")).toBe(true);
  });

  it("flags outbound messaging tools", () => {
    expect(isDestructiveToolCall("send_message")).toBe(true);
    expect(isDestructiveToolCall("send_email")).toBe(true);
    expect(isDestructiveToolCall("reply")).toBe(true);
  });

  it("flags sub-agent spawning", () => {
    expect(isDestructiveToolCall("sessions_spawn")).toBe(true);
    expect(isDestructiveToolCall("session_spawn")).toBe(true);
  });

  it("allows safe read-only tools", () => {
    expect(isDestructiveToolCall("read")).toBe(false);
    expect(isDestructiveToolCall("search")).toBe(false);
    expect(isDestructiveToolCall("memory_search")).toBe(false);
    expect(isDestructiveToolCall("web_fetch")).toBe(false);
  });
});

describe("evaluateToolCallGuard", () => {
  it("allows all tools for non-hook sessions", () => {
    const result = evaluateToolCallGuard({
      toolName: "system_run",
      sessionKey: "agent:main",
    });
    expect(result.blocked).toBe(false);
    expect(result.requiresApproval).toBe(false);
  });

  it("requires approval for destructive tools in hook sessions", () => {
    const result = evaluateToolCallGuard({
      toolName: "system_run",
      sessionKey: "hook:gmail:msg-123",
    });
    expect(result.blocked).toBe(false);
    expect(result.requiresApproval).toBe(true);
    expect(result.reason).toContain("human approval");
  });

  it("allows read-only tools in hook sessions without approval", () => {
    const result = evaluateToolCallGuard({
      toolName: "read",
      sessionKey: "hook:webhook:abc",
    });
    expect(result.blocked).toBe(false);
    expect(result.requiresApproval).toBe(false);
  });

  it("respects allowUnsafeExternalContent bypass", () => {
    const result = evaluateToolCallGuard({
      toolName: "system_run",
      sessionKey: "hook:gmail:msg-123",
      allowUnsafeExternalContent: true,
    });
    expect(result.blocked).toBe(false);
    expect(result.requiresApproval).toBe(false);
  });

  it("allows all tools when sessionKey is absent", () => {
    const result = evaluateToolCallGuard({
      toolName: "exec",
      sessionKey: null,
    });
    expect(result.blocked).toBe(false);
    expect(result.requiresApproval).toBe(false);
  });
});
