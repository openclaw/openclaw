import { describe, expect, it } from "vitest";
import { resolveApprovalRequestKind } from "./approval-types.js";
import { buildPendingApprovalView } from "./approval-view-model.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

const approvalRequestBase = { id: "approval-id", createdAtMs: 1, expiresAtMs: 2 };
function pluginRequest(
  request: Partial<PluginApprovalRequest["request"]> = {},
): PluginApprovalRequest {
  return {
    ...approvalRequestBase,
    id: "plugin-approval",
    request: {
      title: "Use protected tool",
      description: "The plugin needs operator consent.",
      ...request,
    },
  };
}

function approvalAction(
  approvalId: string,
  approvalKind: "exec" | "plugin" | "system-agent",
  decision: "allow-once" | "deny",
) {
  return { type: "approval", approvalId, approvalKind, decision };
}

describe("buildPendingApprovalView", () => {
  it("passes command analysis through exec approval views", () => {
    const request: ExecApprovalRequest = {
      ...approvalRequestBase,
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
        scope: {
          kind: "message-send",
          target: "email",
          recipientCount: 3,
          recipients: ["alice@example.com", "bob@example.com"],
          audience: "external",
        },
      },
    };

    const view = buildPendingApprovalView(request);

    expect(view).toMatchObject({
      approvalKind: "exec",
      commandAnalysis: { warningLines: ["Contains inline-eval: python -c"] },
    });
    expect(view.scope).toEqual(request.request.scope);
    expect(view.metadata).toContainEqual({
      label: "Scope",
      value:
        "Send to 3 recipients via email (external): alice@example.com, bob@example.com, +1 more",
    });
    expect(view.actions[0]?.action).toEqual(approvalAction("approval-id", "exec", "allow-once"));
  });

  it("preserves plugin ownership, scope, and fail-closed decisions", () => {
    const request: PluginApprovalRequest = {
      ...pluginRequest({
        scope: { kind: "external-post", target: "github", visibility: "public" },
        allowedDecisions: ["allow-once"],
      }),
      id: "custom-id-without-prefix",
    };
    Object.defineProperty(request, "approvalKind", { value: "exec", enumerable: true });

    expect(resolveApprovalRequestKind(request)).toBe("plugin");
    const view = buildPendingApprovalView(request);
    expect(view.approvalKind).toBe("plugin");
    expect(view.scope).toEqual(request.request.scope);
    expect(view.metadata).toContainEqual({ label: "Scope", value: "Post publicly to github" });
    expect(view.actions.map((action) => action.action)).toEqual([
      approvalAction("custom-id-without-prefix", "plugin", "allow-once"),
      approvalAction("custom-id-without-prefix", "plugin", "deny"),
    ]);
  });

  it("builds system-agent pending views with allow-once and deny only", () => {
    const request = {
      ...approvalRequestBase,
      id: "system-change-1",
      request: {
        title: "Apply proposed change",
        description: "Rewrite the scheduler to prefer cooperative yields.",
        command: "rewrite scheduler",
        proposalHash: "hash-1",
        sessionId: "session-1",
        allowedDecisions: ["allow-once", "deny"] as const,
      },
    };

    const view = buildPendingApprovalView(request);

    expect(view).toMatchObject({
      approvalKind: "system-agent",
      operationSummary: "Rewrite the scheduler to prefer cooperative yields.",
    });
    expect(view.actions.map((action) => action.action)).toEqual([
      approvalAction("system-change-1", "system-agent", "allow-once"),
      approvalAction("system-change-1", "system-agent", "deny"),
    ]);
  });

  it.each([
    { request: { ...approvalRequestBase, request: { command: "echo safe" } }, metadata: [] },
    {
      request: {
        ...approvalRequestBase,
        request: { title: "Use protected tool", description: "The plugin needs consent." },
      },
      metadata: [{ label: "Severity", value: "Warning" }],
    },
  ])("preserves existing metadata when no approval scope is declared", ({ request, metadata }) => {
    const view = buildPendingApprovalView(request);

    expect(view.metadata).toEqual(metadata);
    expect(view).not.toHaveProperty("scope");
  });

  it.each([
    { request: {} },
    { request: { command: "echo hi", title: "Ambiguous", description: "Ambiguous" } },
  ])("rejects a request payload without exactly one owner: %j", (request) => {
    expect(() => resolveApprovalRequestKind(request)).toThrow("exactly one owner");
  });
});
