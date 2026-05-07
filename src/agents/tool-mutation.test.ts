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

  it("treats coding-tool path aliases as the same stable target", () => {
    const filePathFingerprint = buildToolActionFingerprint("edit", {
      file_path: "/tmp/demo.txt",
      old_string: "before",
      new_string: "after",
    });
    const fileAliasFingerprint = buildToolActionFingerprint("edit", {
      file: "/tmp/demo.txt",
      oldText: "before",
      newText: "after again",
    });

    expect(filePathFingerprint).toBe("tool=edit|path=/tmp/demo.txt");
    expect(fileAliasFingerprint).toBe("tool=edit|path=/tmp/demo.txt");
  });

  it("exposes mutation state for downstream payload rendering", () => {
    expect(
      buildToolMutationState("message", { action: "send", to: "forum:1" }).mutatingAction,
    ).toBe(true);
    expect(buildToolMutationState("browser", { action: "list" }).mutatingAction).toBe(false);
    expect(
      buildToolMutationState("subagents", { action: "kill", target: "worker-1" }).mutatingAction,
    ).toBe(true);
    expect(
      buildToolMutationState("subagents", { action: "steer", target: "worker-1" }).mutatingAction,
    ).toBe(true);
    expect(buildToolMutationState("subagents", { action: "list" }).mutatingAction).toBe(false);
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

  it("recognizes cross-tool file-mutation recovery on the same target (#79024)", () => {
    expect(
      isSameToolMutationAction(
        { toolName: "edit", actionFingerprint: "tool=edit|path=/tmp/a" },
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
      ),
    ).toBe(true);
    expect(
      isSameToolMutationAction(
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/a" },
        { toolName: "edit", actionFingerprint: "tool=edit|path=/tmp/a" },
      ),
    ).toBe(true);
    expect(
      isSameToolMutationAction(
        { toolName: "edit", actionFingerprint: "tool=edit|path=/tmp/a" },
        { toolName: "apply_patch", actionFingerprint: "tool=apply_patch|path=/tmp/a" },
      ),
    ).toBe(true);
  });

  it("does not cross-recover file mutations on different targets (#79024)", () => {
    expect(
      isSameToolMutationAction(
        { toolName: "edit", actionFingerprint: "tool=edit|path=/tmp/a" },
        { toolName: "write", actionFingerprint: "tool=write|path=/tmp/b" },
      ),
    ).toBe(false);
  });

  it("does not cross-recover when the recovery tool is not file-mutating (#79024)", () => {
    expect(
      isSameToolMutationAction(
        { toolName: "edit", actionFingerprint: "tool=edit|path=/tmp/a" },
        { toolName: "bash", actionFingerprint: "tool=bash|meta=cat /tmp/a" },
      ),
    ).toBe(false);
    expect(
      isSameToolMutationAction(
        { toolName: "edit", actionFingerprint: "tool=edit|path=/tmp/a" },
        { toolName: "exec", actionFingerprint: "tool=exec|meta=touch /tmp/a" },
      ),
    ).toBe(false);
  });

  it("ignores call-specific noise when comparing the cross-tool target (#79024)", () => {
    // `id=...` and `meta=...` segments must not block recovery when the
    // stable `path=...` target still matches.
    expect(
      isSameToolMutationAction(
        {
          toolName: "edit",
          actionFingerprint: "tool=edit|path=/tmp/a|id=42|meta=edit /tmp/a",
        },
        {
          toolName: "write",
          actionFingerprint: "tool=write|path=/tmp/a|id=99|meta=write /tmp/a",
        },
      ),
    ).toBe(true);
  });

  it("requires `oldpath` to agree across cross-tool recovery (#79024)", () => {
    expect(
      isSameToolMutationAction(
        {
          toolName: "apply_patch",
          actionFingerprint: "tool=apply_patch|path=/tmp/a|oldpath=/tmp/old",
        },
        {
          toolName: "write",
          actionFingerprint: "tool=write|path=/tmp/a|oldpath=/tmp/old",
        },
      ),
    ).toBe(true);
    expect(
      isSameToolMutationAction(
        {
          toolName: "apply_patch",
          actionFingerprint: "tool=apply_patch|path=/tmp/a|oldpath=/tmp/old",
        },
        {
          toolName: "apply_patch",
          actionFingerprint: "tool=apply_patch|path=/tmp/a|oldpath=/tmp/different",
        },
      ),
    ).toBe(false);
  });

  it("keeps legacy name-only mutating heuristics for payload fallback", () => {
    expect(isLikelyMutatingToolName("sessions_spawn")).toBe(true);
    expect(isLikelyMutatingToolName("sessions_send")).toBe(true);
    expect(isLikelyMutatingToolName("browser_actions")).toBe(true);
    expect(isLikelyMutatingToolName("message_slack")).toBe(true);
    expect(isLikelyMutatingToolName("browser")).toBe(false);
  });
});
