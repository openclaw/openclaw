import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { shouldSuppressLocalExecApprovalPrompt } from "./exec-approval-local.js";

const execApprovalPayload: ReplyPayload = {
  text: "Approval required.\n\n```txt\n/approve 12345678 allow-once\n```",
  channelData: {
    execApproval: {
      approvalId: "12345678-1234-1234-1234-123456789012",
      approvalSlug: "12345678",
      allowedDecisions: ["allow-once", "allow-always", "deny"],
    },
  },
};

describe("shouldSuppressLocalExecApprovalPrompt", () => {
  it("does not count disabled native approval channels when suppressing Telegram prompts", () => {
    const cfg = {
      channels: {
        discord: {
          enabled: false,
          execApprovals: {
            enabled: true,
            approvers: ["123"],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      shouldSuppressLocalExecApprovalPrompt({
        channel: "telegram",
        cfg,
        accountId: "default",
        payload: execApprovalPayload,
      }),
    ).toBe(false);
  });
});
