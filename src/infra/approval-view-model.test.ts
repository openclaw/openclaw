// Tests approval view model formatting for prompts and decisions.
import { describe, expect, it } from "vitest";
import { buildPendingApprovalView } from "./approval-view-model.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";

describe("buildPendingApprovalView", () => {
  it("passes command analysis through exec approval views", () => {
    const request: ExecApprovalRequest = {
      id: "approval-id",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        command: 'ls | grep "stuff" | python -c \'print("hi")\'',
        host: "node",
        ask: "always",
        commandAnalysis: {
          commandCount: 1,
          nestedCommandCount: 0,
          riskKinds: ["inline-eval"],
          warningLines: ["Contains inline-eval: python -c"],
        },
      },
    };

    const view = buildPendingApprovalView(request);

    expect(view.approvalKind).toBe("exec");
    if (view.approvalKind !== "exec") {
      throw new Error("expected exec approval view");
    }
    expect(view.commandAnalysis?.warningLines).toEqual(["Contains inline-eval: python -c"]);
  });

  it("includes session identity in exec metadata rows for adapter-backed prompts", () => {
    const request: ExecApprovalRequest = {
      id: "approval-id",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        command: "echo hi",
        host: "node",
        ask: "always",
        agentId: "main",
        sessionKey: "agent:main:telegram:direct:424242",
      },
    };

    const view = buildPendingApprovalView(request);

    expect(view.metadata).toContainEqual({
      label: "Session",
      value: "agent:main:telegram:direct:424242",
    });
    // Absent session keys must not add an empty row.
    const withoutSession = buildPendingApprovalView({
      ...request,
      request: { ...request.request, sessionKey: null },
    });
    expect(withoutSession.metadata.some((row) => row.label === "Session")).toBe(false);
  });

  it("sanitizes displayed identity metadata without changing raw routing fields", () => {
    const agentId = "main\n**admin**";
    const sessionKey = "global\u202E\n[approve](danger)";
    const view = buildPendingApprovalView({
      id: "approval-id",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        command: "echo hi",
        host: "node",
        agentId,
        sessionKey,
      },
    });

    expect(view.metadata).toContainEqual({ label: "Agent", value: "main ＊＊admin＊＊" });
    expect(view.metadata).toContainEqual({
      label: "Session",
      value: "global ［approve］（danger）",
    });
    expect(view.agentId).toBe(agentId);
    expect(view.sessionKey).toBe(sessionKey);
  });

  it("includes session identity in plugin metadata rows", () => {
    const view = buildPendingApprovalView({
      id: "plugin:req-1",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        title: "Sensitive tool call",
        description: "Plugin wants to call a sensitive tool",
        pluginId: "voice-call",
        agentId: "main",
        sessionKey: "agent:main:main",
      },
    });

    expect(view.metadata).toContainEqual({ label: "Session", value: "agent:main:main" });
  });
});
