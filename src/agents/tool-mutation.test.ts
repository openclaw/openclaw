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

  it("uses file_path (snake_case) as stable target for edit fingerprints", () => {
    // When the model uses file_path instead of path, the fingerprint should
    // still capture a stable target so that a retry on the same file matches.
    const failed = buildToolActionFingerprint("edit", {
      file_path: "/src/app.ts",
      oldText: "wrong",
      newText: "right",
    });
    const retried = buildToolActionFingerprint("edit", {
      file_path: "/src/app.ts",
      oldText: "correct old text",
      newText: "right",
    });
    expect(failed).toBeDefined();
    expect(retried).toBeDefined();
    expect(failed).toBe(retried);
    expect(failed).toContain("file_path=/src/app.ts");
    expect(failed).not.toContain("meta=");
  });

  it("clears lastToolError when edit retry succeeds on same file_path", () => {
    const failedState = buildToolMutationState("edit", { file_path: "/src/app.ts", oldText: "a" });
    const retryState = buildToolMutationState("edit", {
      file_path: "/src/app.ts",
      oldText: "correct",
    });
    expect(failedState.mutatingAction).toBe(true);
    expect(retryState.mutatingAction).toBe(true);
    expect(
      isSameToolMutationAction(
        {
          toolName: "edit",
          actionFingerprint: failedState.actionFingerprint,
        },
        {
          toolName: "edit",
          actionFingerprint: retryState.actionFingerprint,
        },
      ),
    ).toBe(true);
  });

  it("keeps legacy name-only mutating heuristics for payload fallback", () => {
    expect(isLikelyMutatingToolName("sessions_send")).toBe(true);
    expect(isLikelyMutatingToolName("browser_actions")).toBe(true);
    expect(isLikelyMutatingToolName("message_slack")).toBe(true);
    expect(isLikelyMutatingToolName("browser")).toBe(false);
  });
});
