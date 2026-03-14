import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  buildExecApprovalPendingReplyPayload,
  buildExecApprovalUnavailableReplyPayload,
  getExecApprovalApproverDmNoticeText,
  getExecApprovalReplyMetadata,
} from "./exec-approval-reply.js";

describe("exec approval reply helpers", () => {
  it("returns the approver DM notice text", () => {
    expect(getExecApprovalApproverDmNoticeText()).toBe(
      "Approval required. I sent the allowed approvers DMs.",
    );
  });

  it("returns null for invalid reply metadata payloads", () => {
    for (const payload of [
      {},
      { channelData: null },
      { channelData: [] },
      { channelData: { execApproval: null } },
      { channelData: { execApproval: [] } },
      { channelData: { execApproval: { approvalId: "req-1", approvalSlug: "  " } } },
      { channelData: { execApproval: { approvalId: "  ", approvalSlug: "slug-1" } } },
    ] as unknown[]) {
      expect(getExecApprovalReplyMetadata(payload as ReplyPayload)).toBeNull();
    }
  });

  it("normalizes reply metadata and filters invalid decisions", () => {
    expect(
      getExecApprovalReplyMetadata({
        channelData: {
          execApproval: {
            approvalId: " req-1 ",
            approvalSlug: " slug-1 ",
            allowedDecisions: ["allow-once", "bad", "deny", "allow-always", 3],
          },
        },
      }),
    ).toEqual({
      approvalId: "req-1",
      approvalSlug: "slug-1",
      allowedDecisions: ["allow-once", "deny", "allow-always"],
    });
  });

  it("builds pending reply payloads with trimmed warning text and slug fallback", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      warningText: "  Heads up.  ",
      approvalId: "req-1",
      approvalSlug: "slug-1",
      command: "echo ok",
      cwd: "/tmp/work",
      host: "gateway",
      nodeId: "node-1",
      expiresAtMs: 2500,
      nowMs: 1000,
    });

    expect(payload.channelData).toEqual({
      execApproval: {
        approvalId: "req-1",
        approvalSlug: "slug-1",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
      },
    });
    expect(payload.text).toContain("Heads up.");
    expect(payload.text).toContain("```txt\n/approve slug-1 allow-once\n```");
    expect(payload.text).toContain("```sh\necho ok\n```");
    expect(payload.text).toContain("Host: gateway\nNode: node-1\nCWD: /tmp/work\nExpires in: 2s");
    expect(payload.text).toContain("Full id: `req-1`");
  });

  it("uses a longer fence for commands containing triple backticks", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-2",
      approvalSlug: "slug-2",
      approvalCommandId: " req-cmd-2 ",
      command: "echo ```danger```",
      host: "sandbox",
    });

    expect(payload.text).toContain("```txt\n/approve req-cmd-2 allow-once\n```");
    expect(payload.text).toContain("````sh\necho ```danger```\n````");
    expect(payload.text).not.toContain("Expires in:");
  });

  it("clamps pending reply expiration to zero seconds", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-3",
      approvalSlug: "slug-3",
      command: "echo later",
      host: "gateway",
      expiresAtMs: 1000,
      nowMs: 3000,
    });

    expect(payload.text).toContain("Expires in: 0s");
  });

  it("builds unavailable payloads for approver DMs and each fallback reason", () => {
    expect(
      buildExecApprovalUnavailableReplyPayload({
        warningText: "  Careful.  ",
        reason: "no-approval-route",
        sentApproverDms: true,
      }),
    ).toEqual({
      text: "Careful.\n\nApproval required. I sent the allowed approvers DMs.",
    });

    const cases = [
      {
        reason: "initiating-platform-disabled" as const,
        channelLabel: "Slack",
        expected: "Exec approval is required, but chat exec approvals are not enabled on Slack.",
      },
      {
        reason: "initiating-platform-unsupported" as const,
        channelLabel: undefined,
        expected:
          "Exec approval is required, but this platform does not support chat exec approvals.",
      },
      {
        reason: "no-approval-route" as const,
        channelLabel: undefined,
        expected:
          "Exec approval is required, but no interactive approval client is currently available.",
      },
    ];

    for (const testCase of cases) {
      expect(
        buildExecApprovalUnavailableReplyPayload({
          reason: testCase.reason,
          channelLabel: testCase.channelLabel,
        }).text,
      ).toContain(testCase.expected);
    }
  });
});
