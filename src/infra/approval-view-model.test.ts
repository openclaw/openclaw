// Tests approval view model formatting for prompts and decisions.
import { describe, expect, it } from "vitest";
import { buildPendingApprovalView } from "./approval-view-model.js";
import type { ExecApprovalRequest } from "./exec-approvals.js";
import type { PluginApprovalRequest } from "./plugin-approvals.js";

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

  it("passes external resolution through plugin approval views without custom actions", () => {
    const request: PluginApprovalRequest = {
      id: "plugin:approval-id",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        title: "World proof required",
        description: "Verify first",
        allowedDecisions: ["deny"],
        externalResolution: {
          label: "Verify with World",
          commands: [
            {
              decision: "allow-once",
              label: "Verify once",
              description: "Approve this blocked action only",
              command: "/agentkit approve plugin:approval-id allow-once",
            },
          ],
        },
      },
    };

    const view = buildPendingApprovalView(request);

    expect(view.approvalKind).toBe("plugin");
    if (view.approvalKind !== "plugin") {
      throw new Error("expected plugin approval view");
    }
    expect(view.externalResolution?.label).toBe("Verify with World");
    expect(view.actions.map((action) => action.decision)).toEqual(["deny"]);
  });
});
