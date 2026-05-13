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

  it("projects policy approval metadata into plugin approval views", () => {
    const request: PluginApprovalRequest = {
      id: "plugin:approval-id",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        title: "Policy approval required",
        description: "Deploy touches a governed target",
        severity: "warning",
        toolName: "deploy",
        metadata: {
          source: "policy",
          policy: {
            path: "policy.jsonc",
            hash: "sha256:policy",
          },
          workspace: {
            scope: "policy",
            hash: "sha256:workspace",
          },
          attestation: {
            hash: "sha256:attestation",
            expectedHash: "sha256:expected-attestation",
          },
          target: "oc://TOOLS.md/tools/deploy",
        },
      },
    };

    const view = buildPendingApprovalView(request);

    expect(view.approvalKind).toBe("plugin");
    if (view.approvalKind !== "plugin") {
      throw new Error("expected plugin approval view");
    }
    expect(view.metadata).toEqual(
      expect.arrayContaining([
        { label: "Policy Hash", value: "sha256:policy" },
        { label: "Workspace Hash", value: "sha256:workspace" },
        { label: "Attestation Hash", value: "sha256:attestation" },
        { label: "Expected Attestation", value: "sha256:expected-attestation" },
        { label: "Policy Target", value: "oc://TOOLS.md/tools/deploy" },
      ]),
    );
  });
});
