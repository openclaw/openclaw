import { describe, expect, it } from "vitest";
import {
  buildToolActionFingerprint,
  buildToolMutationState,
  isLikelyMutatingToolName,
  isMutatingToolCall,
  isSameToolMutationAction,
} from "./tool-mutation.js";

describe("tool mutation helpers", () => {
  it("treats session_status as mutating only when model override is provided", () => {
    expect(isMutatingToolCall("session_status", { sessionKey: "agent:main:main" })).toBe(false);
    expect(
      isMutatingToolCall("session_status", {
        sessionKey: "agent:main:main",
        model: "openai/gpt-4o",
      }),
    ).toBe(true);
  });

  it("builds stable fingerprints for mutating calls and omits read-only calls", () => {
    const writeFingerprint = buildToolActionFingerprint(
      "write",
      { path: "/tmp/demo.txt", id: 42 },
      "write /tmp/demo.txt",
    );
    expect(writeFingerprint).toContain("tool=write");
    expect(writeFingerprint).toContain("path=/tmp/demo.txt");
    expect(writeFingerprint).toContain("id=42");
    expect(writeFingerprint).not.toContain("meta=write /tmp/demo.txt");

    const metaOnlyFingerprint = buildToolActionFingerprint("exec", { command: "ls -la" }, "ls -la");
    expect(metaOnlyFingerprint).toContain("tool=exec");
    expect(metaOnlyFingerprint).toContain("meta=ls -la");

    const readFingerprint = buildToolActionFingerprint("read", { path: "/tmp/demo.txt" });
    expect(readFingerprint).toBeUndefined();
  });

  it("exposes mutation state for downstream payload rendering", () => {
    expect(
      buildToolMutationState("message", { action: "send", to: "telegram:1" }).mutatingAction,
    ).toBe(true);
    expect(buildToolMutationState("browser", { action: "list" }).mutatingAction).toBe(false);
  });

  it("matches tool actions by fingerprint and fails closed on asymmetric data", () => {
    expect(
      isSameToolMutationAction(
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
      ),
    ).toBe(true);
    expect(
      isSameToolMutationAction(
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/b" },
      ),
    ).toBe(false);
    expect(
      isSameToolMutationAction(
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
        { toolName: "write" },
      ),
    ).toBe(false);
  });

  it("excludes attachment path from message tool fingerprint so retries match (#37430)", () => {
    // First call: send with file from /tmp (will fail)
    const firstAttempt = buildToolActionFingerprint("message", {
      action: "send",
      to: "telegram:413",
      filePath: "/tmp/report.pdf",
    });
    // Retry: same target, file copied to workspace
    const retry = buildToolActionFingerprint("message", {
      action: "send",
      to: "telegram:413",
      filePath: "/home/user/.openclaw/workspace/report.pdf",
    });
    expect(firstAttempt).toBeDefined();
    expect(retry).toBeDefined();
    expect(firstAttempt).toBe(retry);
    // Both should match on target, not file path
    expect(firstAttempt).toContain("to=telegram:413");
    expect(firstAttempt).not.toContain("filepath=");
    expect(firstAttempt).not.toContain("path=");
  });

  it("retains path in fingerprint for file-mutating tools", () => {
    const fp = buildToolActionFingerprint("write", { path: "/tmp/demo.txt" });
    expect(fp).toContain("path=/tmp/demo.txt");
  });

  it("clears lastToolError when message retry with different path succeeds (#37430)", () => {
    const failedRef = {
      toolName: "message",
      actionFingerprint: buildToolActionFingerprint("message", {
        action: "send",
        to: "telegram:413",
        filePath: "/tmp/report.pdf",
      }),
    };
    const retryRef = {
      toolName: "message",
      actionFingerprint: buildToolActionFingerprint("message", {
        action: "send",
        to: "telegram:413",
        filePath: "/home/user/workspace/report.pdf",
      }),
    };
    expect(isSameToolMutationAction(failedRef, retryRef)).toBe(true);
  });

  it("keeps legacy name-only mutating heuristics for payload fallback", () => {
    expect(isLikelyMutatingToolName("sessions_send")).toBe(true);
    expect(isLikelyMutatingToolName("browser_actions")).toBe(true);
    expect(isLikelyMutatingToolName("message_slack")).toBe(true);
    expect(isLikelyMutatingToolName("browser")).toBe(false);
  });
});
