import { describe, expect, it } from "vitest";
import {
  buildApprovalPendingReplyPayload,
  buildPluginApprovalPendingReplyPayload,
  buildPluginApprovalResolvedReplyPayload,
} from "./approval-renderers.js";

describe("plugin-sdk/approval-renderers", () => {
  it("builds shared approval payloads with generic interactive commands", () => {
    const payload = buildApprovalPendingReplyPayload({
      approvalId: "plugin:approval-123",
      approvalSlug: "plugin:a",
      text: "Approval required @everyone",
    });

    expect(payload.text).toContain("@\u200beveryone");
    expect(payload.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow Once",
              value: "/approve plugin:approval-123 allow-once",
              style: "success",
            },
            {
              label: "Allow Always",
              value: "/approve plugin:approval-123 always",
              style: "primary",
            },
            {
              label: "Deny",
              value: "/approve plugin:approval-123 deny",
              style: "danger",
            },
          ],
        },
      ],
    });
  });

  it("builds plugin pending payloads with approval metadata and extra channel data", () => {
    const payload = buildPluginApprovalPendingReplyPayload({
      request: {
        id: "plugin-approval-123",
        request: {
          title: "Sensitive action",
          description: "Needs approval",
        },
        createdAtMs: 1_000,
        expiresAtMs: 61_000,
      },
      nowMs: 1_000,
      approvalSlug: "custom-slug",
      channelData: {
        telegram: {
          quoteText: "quoted",
        },
      },
    });

    expect(payload.text).toContain("Plugin approval required");
    expect(payload.interactive).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow Once",
              value: "/approve plugin-approval-123 allow-once",
              style: "success",
            },
            {
              label: "Allow Always",
              value: "/approve plugin-approval-123 always",
              style: "primary",
            },
            {
              label: "Deny",
              value: "/approve plugin-approval-123 deny",
              style: "danger",
            },
          ],
        },
      ],
    });
    expect(payload.channelData).toMatchObject({
      execApproval: {
        approvalId: "plugin-approval-123",
        approvalSlug: "custom-slug",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
      telegram: {
        quoteText: "quoted",
      },
    });
  });

  it("builds plugin resolved payloads with optional channel data", () => {
    const payload = buildPluginApprovalResolvedReplyPayload({
      resolved: {
        id: "plugin-approval-123",
        decision: "allow-once",
        resolvedBy: "discord:user:1",
        ts: 2_000,
      },
      channelData: {
        discord: {
          components: [{ type: "container" }],
        },
      },
    });

    expect(payload.text).toContain("Plugin approval allowed once");
    expect(payload.channelData).toEqual({
      discord: {
        components: [{ type: "container" }],
      },
    });
  });
});
