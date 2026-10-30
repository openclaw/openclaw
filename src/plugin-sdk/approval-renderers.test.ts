import { describe, expect, it } from "vitest";
import type { PluginApprovalRequest } from "../infra/plugin-approvals.js";
import {
  buildApprovalPendingReplyPayload,
  buildApprovalResolvedReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  buildPluginApprovalResolvedReplyPayload,
  buildTypedApprovalPendingReplyPayload,
  buildTypedPluginApprovalPendingReplyPayload,
} from "./approval-renderers.js";

const buttonLabels = {
  "allow-once": { label: "Allow Once", style: "success" },
  "allow-always": { label: "Allow Always", style: "primary" },
  deny: { label: "Deny", style: "danger" },
};

function pendingRequest(
  id = "plugin-approval-123",
  allowedDecisions?: PluginApprovalRequest["request"]["allowedDecisions"],
) {
  return {
    request: {
      id,
      request: { title: "Sensitive action", description: "Needs approval", allowedDecisions },
      createdAtMs: 1_000,
      expiresAtMs: 61_000,
    },
    nowMs: 1_000,
  };
}

function pendingMetadata(
  approvalSlug: string,
  allowedDecisions = ["allow-once", "allow-always", "deny"],
  approvalId = "plugin-approval-123",
) {
  return {
    agentId: undefined,
    approvalId,
    approvalKind: "plugin",
    approvalSlug,
    allowedDecisions,
    sessionKey: undefined,
    state: "pending",
  };
}

function commandPresentation(approvalId: string, decision: keyof typeof buttonLabels) {
  const command = `/approve ${approvalId} ${decision}`;
  return buttonPresentation([
    {
      ...buttonLabels[decision],
      action: { type: "command", command },
      value: command,
    },
  ]);
}

function buttonPresentation<T>(buttons: T[]) {
  return { blocks: [{ type: "buttons", buttons }] };
}
function resolvedMetadata(approvalId: string, approvalSlug = approvalId) {
  return { approvalId, approvalSlug, state: "resolved" };
}

function pluginPresentation(
  approvalId: string,
  decisions: Array<keyof typeof buttonLabels> = ["allow-once", "allow-always", "deny"],
) {
  return buttonPresentation(
    decisions.map((decision) => ({
      ...buttonLabels[decision],
      action: { type: "approval", approvalId, approvalKind: "plugin", decision },
    })),
  );
}

describe("plugin-sdk/approval-renderers", () => {
  it("preserves command controls when shipped approvalKind metadata is supplied", () => {
    expect(
      buildApprovalPendingReplyPayload({
        approvalKind: "plugin",
        approvalId: "plugin:legacy-approval",
        approvalSlug: "legacy-a",
        text: "Approval required",
        allowedDecisions: ["deny"],
      }),
    ).toEqual({
      text: "Approval required",
      presentation: commandPresentation("plugin:legacy-approval", "deny"),
      channelData: {
        execApproval: pendingMetadata("legacy-a", ["deny"], "plugin:legacy-approval"),
      },
    });
  });

  it("preserves command controls in the shipped plugin approval builder", () => {
    const payload = buildPluginApprovalPendingReplyPayload(
      pendingRequest("plugin-legacy", ["allow-once"]),
    );

    expect(payload.text).toContain("Reply with: /approve plugin-legacy allow-once");
    expect(payload.text).not.toContain("allow-once|deny");
    expect(payload.presentation).toEqual(commandPresentation("plugin-legacy", "allow-once"));
  });

  it.each([
    {
      name: "builds shared approval payloads with typed plugin decisions",
      payload: buildTypedApprovalPendingReplyPayload({
        approvalKind: "plugin",
        approvalId: "plugin:approval-123",
        approvalSlug: "plugin:a",
        text: "Approval required @everyone",
      }),
      text: expect.stringContaining("@everyone"),
      presentationExpected: pluginPresentation("plugin:approval-123"),
    },
    {
      name: "builds plugin pending payloads with approval metadata and extra channel data",
      payload: buildTypedPluginApprovalPendingReplyPayload({
        ...pendingRequest(),
        approvalSlug: "custom-slug",
        channelData: { telegram: { quoteText: "quoted" } },
      }),
      text: expect.stringContaining("Plugin approval required"),
      presentationExpected: pluginPresentation("plugin-approval-123"),
      channelDataExpected: {
        execApproval: pendingMetadata("custom-slug"),
        telegram: { quoteText: "quoted" },
      },
    },
    {
      name: "adds fail-closed deny to request-scoped plugin decisions",
      payload: buildTypedPluginApprovalPendingReplyPayload({
        ...pendingRequest("plugin-approval-123", ["allow-once"]),
        allowedDecisions: ["allow-once"],
      }),
      text: expect.stringContaining("Reply with: /approve plugin-approval-123 allow-once"),
      textExcluded: "allow-once|deny",
      presentationExpected: pluginPresentation("plugin-approval-123", ["allow-once", "deny"]),
      channelDataExpected: { execApproval: pendingMetadata("plugin-a", ["allow-once", "deny"]) },
    },
    {
      name: "builds generic resolved payloads with approval metadata",
      payload: buildApprovalResolvedReplyPayload({
        approvalId: "req-123",
        approvalSlug: "req-123",
        text: "resolved @everyone",
      }),
      text: "resolved @everyone",
      channelDataExpected: {
        execApproval: resolvedMetadata("req-123"),
      },
    },
    {
      name: "builds plugin resolved payloads with optional channel data",
      payload: buildPluginApprovalResolvedReplyPayload({
        resolved: {
          id: "plugin-approval-123",
          decision: "allow-once",
          resolvedBy: "discord:user:1",
          ts: 2_000,
        },
        channelData: { discord: { components: [{ type: "container" }] } },
      }),
      text: expect.stringContaining("Plugin approval allowed once"),
      channelDataExpected: {
        execApproval: resolvedMetadata("plugin-approval-123", "plugin-a"),
        discord: { components: [{ type: "container" }] },
      },
    },
  ])("$name", ({ payload, text, textExcluded, presentationExpected, channelDataExpected }) => {
    expect(payload.text).toEqual(text);
    if (textExcluded) {
      expect(payload.text).not.toContain(textExcluded);
    }
    if (presentationExpected) {
      expect(payload.presentation).toEqual(presentationExpected);
      expect(payload.interactive).toBeUndefined();
    }
    if (channelDataExpected) {
      expect(payload.channelData).toEqual(channelDataExpected);
    }
  });
});
