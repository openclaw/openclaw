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

  it("keeps legacy name-only mutating heuristics for payload fallback", () => {
    expect(isLikelyMutatingToolName("sessions_send")).toBe(true);
    expect(isLikelyMutatingToolName("browser_actions")).toBe(true);
    expect(isLikelyMutatingToolName("message_slack")).toBe(true);
    expect(isLikelyMutatingToolName("browser")).toBe(false);
  });

  describe("exec/bash read-only command classification", () => {
    it("treats read-only commands as non-mutating", () => {
      for (const cmd of [
        "ls",
        "cat",
        "grep",
        "find",
        "head",
        "tail",
        "wc",
        "echo",
        "ps",
        "diff",
        "ping",
      ]) {
        expect(isMutatingToolCall("exec", { command: cmd })).toBe(false);
        expect(isMutatingToolCall("bash", { command: cmd })).toBe(false);
      }
    });

    it("treats commands with absolute paths as non-mutating when the binary is read-only", () => {
      expect(isMutatingToolCall("bash", { command: "/usr/bin/ls -la" })).toBe(false);
      expect(isMutatingToolCall("exec", { command: "/bin/cat /etc/hosts" })).toBe(false);
    });

    it("treats unknown commands as mutating", () => {
      expect(isMutatingToolCall("bash", { command: "rm -rf /tmp/foo" })).toBe(true);
      expect(isMutatingToolCall("exec", { command: "chmod 755 file" })).toBe(true);
      expect(isMutatingToolCall("bash", { command: "mv a b" })).toBe(true);
    });

    it("treats commands that can mutate state as mutating", () => {
      // These were previously (incorrectly) in the read-only list
      expect(isMutatingToolCall("bash", { command: "git commit -m 'test'" })).toBe(true);
      expect(isMutatingToolCall("bash", { command: "sed -i 's/a/b/' file" })).toBe(true);
      expect(isMutatingToolCall("bash", { command: "python3 script.py" })).toBe(true);
      expect(isMutatingToolCall("bash", { command: "node index.js" })).toBe(true);
      expect(isMutatingToolCall("bash", { command: "docker run ubuntu" })).toBe(true);
      expect(isMutatingToolCall("bash", { command: "kubectl delete pod foo" })).toBe(true);
      expect(isMutatingToolCall("bash", { command: "npm install express" })).toBe(true);
      expect(isMutatingToolCall("bash", { command: "pip install requests" })).toBe(true);
      expect(isMutatingToolCall("bash", { command: "aws s3 rm s3://bucket/key" })).toBe(true);
      expect(isMutatingToolCall("bash", { command: "sqlite3 db.sqlite 'DROP TABLE t'" })).toBe(
        true,
      );
      expect(isMutatingToolCall("bash", { command: "redis-cli SET key val" })).toBe(true);
    });

    it("defaults to mutating when command is empty or missing", () => {
      expect(isMutatingToolCall("bash", {})).toBe(true);
      expect(isMutatingToolCall("exec", { command: "" })).toBe(true);
      expect(isMutatingToolCall("bash", { command: 123 })).toBe(true);
    });
  });
});
