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

  it("uses file_path as a stable fingerprint target key", () => {
    const fingerprint = buildToolActionFingerprint(
      "write",
      { file_path: "/tmp/snake-case.txt" },
      "write 123 chars to /tmp/snake-case.txt",
    );

    expect(fingerprint).toContain("tool=write");
    expect(fingerprint).toContain("file_path=/tmp/snake-case.txt");
    expect(fingerprint).not.toContain("meta=");
  });

  it("uses old_path and new_path as stable fingerprint target keys", () => {
    const fingerprint = buildToolActionFingerprint(
      "edit",
      { old_path: "/tmp/old.txt", new_path: "/tmp/new.txt" },
      "rename /tmp/old.txt -> /tmp/new.txt",
    );

    expect(fingerprint).toContain("tool=edit");
    expect(fingerprint).toContain("old_path=/tmp/old.txt");
    expect(fingerprint).toContain("new_path=/tmp/new.txt");
    expect(fingerprint).not.toContain("meta=");
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

  it("matches retry actions for write calls using file_path fingerprint keys", () => {
    const firstAttempt = buildToolMutationState(
      "write",
      { file_path: "/tmp/retry.txt" },
      "write 92 chars to /tmp/retry.txt",
    );
    const retryAttempt = buildToolMutationState(
      "write",
      { file_path: "/tmp/retry.txt" },
      "write 104 chars to /tmp/retry.txt",
    );

    expect(firstAttempt.actionFingerprint).toBeDefined();
    expect(retryAttempt.actionFingerprint).toBeDefined();
    expect(
      isSameToolMutationAction(
        { toolName: "write", actionFingerprint: firstAttempt.actionFingerprint },
        { toolName: "write", actionFingerprint: retryAttempt.actionFingerprint },
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
