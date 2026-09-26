// Tests execution approval reply text and decision formatting.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReplyPayload } from "../auto-reply/types.js";

const surface = vi.hoisted(() => ({
  describeNativeExecApprovalClientSetup:
    vi.fn<typeof import("./exec-approval-surface.js").describeNativeExecApprovalClientSetup>(),
  listNativeExecApprovalClientLabels:
    vi.fn<typeof import("./exec-approval-surface.js").listNativeExecApprovalClientLabels>(),
  supportsNativeExecApprovalClient:
    vi.fn<typeof import("./exec-approval-surface.js").supportsNativeExecApprovalClient>(),
}));

vi.mock("./exec-approval-surface.js", () => surface);

import {
  buildApprovalButtonPresentation,
  buildApprovalPresentationFromActionDescriptors,
  buildExecApprovalActionDescriptors,
  buildExecApprovalCommandText,
  buildExecApprovalPendingReplyPayload,
  buildExecApprovalUnavailableReplyPayload,
  buildTypedApprovalActionDescriptors,
  buildTypedApprovalPresentation,
  buildTypedExecApprovalPendingReplyPayload,
  getExecApprovalApproverDmNoticeText,
  getExecApprovalReplyMetadata,
  parseExecApprovalCommandText,
} from "./exec-approval-reply.js";

describe("exec approval reply helpers", () => {
  beforeEach(() => {
    surface.describeNativeExecApprovalClientSetup.mockReset().mockReturnValue(null);
    surface.listNativeExecApprovalClientLabels
      .mockReset()
      .mockReturnValue(["Discord", "Matrix", "Slack", "Telegram"]);
    surface.supportsNativeExecApprovalClient.mockReset().mockReturnValue(false);
  });

  const invalidReplyMetadataCases = [
    { name: "empty object", payload: {} },
    { name: "null channelData", payload: { channelData: null } },
    { name: "array channelData", payload: { channelData: [] } },
    { name: "null execApproval", payload: { channelData: { execApproval: null } } },
    { name: "array execApproval", payload: { channelData: { execApproval: [] } } },
    {
      name: "blank approval slug",
      payload: { channelData: { execApproval: { approvalId: "req-1", approvalSlug: "  " } } },
    },
    {
      name: "blank approval id",
      payload: { channelData: { execApproval: { approvalId: "  ", approvalSlug: "slug-1" } } },
    },
  ] as const;

  const unavailableReasonCases = [
    {
      reason: "initiating-platform-disabled" as const,
      channelLabel: "Slack",
      expected:
        "Exec approval is required, but native chat exec approvals are not configured on Slack.",
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
  ] as const;

  it("returns the approver DM notice text", () => {
    expect(getExecApprovalApproverDmNoticeText()).toBe(
      "Approval required. I sent approval DMs to the approvers for this account.",
    );
  });

  it("includes the available native client labels in fallback guidance", () => {
    const text = buildExecApprovalUnavailableReplyPayload({
      reason: "no-approval-route",
    }).text;
    expect(text).toContain("native chat approval client such as");
    expect(text).toContain("Discord");
    expect(text).toContain("Matrix");
    expect(text).toContain("Slack");
    expect(text).toContain("Telegram");
    expect(surface.listNativeExecApprovalClientLabels).toHaveBeenCalledExactlyOnceWith({
      excludeChannel: undefined,
    });
  });

  it("avoids repeating allowFrom guidance in the no-route fallback", () => {
    const text = buildExecApprovalUnavailableReplyPayload({
      reason: "no-approval-route",
    }).text;

    expect(text).not.toContain(
      "Then retry the command. If those accounts already know your owner ID via allowFrom or owner config",
    );
    expect(text).toContain(
      "You can usually leave execApprovals.approvers unset when owner config already identifies the approvers.",
    );
  });

  it("distinguishes node approval-inbox access from policy inspection", () => {
    const text = buildExecApprovalUnavailableReplyPayload({
      reason: "no-approval-route",
      host: "node",
      nodeId: "mac-1",
    }).text;

    expect(text).toContain(
      "Print the Control UI URL with `openclaw dashboard --no-open`, open it in a browser, then use the approval inbox.",
    );
    expect(text).toContain(
      "Inspect the node's effective exec policy with `openclaw approvals get --node mac-1`.",
    );
    expect(text).not.toContain("`openclaw dashboard --no-open` or `openclaw approvals get");
    expect(text).not.toContain("Open the approval inbox with");
    expect(text).not.toContain("exec-approvals list");
  });

  it.each([undefined, " work "])(
    "includes delegated setup guidance for account %j without rewriting its label or account",
    (accountId) => {
      surface.supportsNativeExecApprovalClient.mockReturnValue(true);
      surface.describeNativeExecApprovalClientSetup.mockReturnValue("Native setup instructions.");

      const text = buildExecApprovalUnavailableReplyPayload({
        reason: "initiating-platform-disabled",
        channel: " SuPPorted ",
        channelLabel: " Custom label ",
        ...(accountId === undefined ? {} : { accountId }),
      }).text;

      expect(surface.supportsNativeExecApprovalClient).toHaveBeenCalledExactlyOnceWith("supported");
      expect(surface.describeNativeExecApprovalClientSetup).toHaveBeenCalledExactlyOnceWith({
        channel: "supported",
        channelLabel: " Custom label ",
        accountId,
      });
      expect(text).toBe(
        "Exec approval is required, but native chat exec approvals are not configured on  Custom label .\n\nNative setup instructions.",
      );
      expect(surface.listNativeExecApprovalClientLabels).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "uses generic guidance when native support is %s and setup is unavailable",
    (supported) => {
      surface.supportsNativeExecApprovalClient.mockReturnValue(supported);

      const text = buildExecApprovalUnavailableReplyPayload({
        reason: "initiating-platform-disabled",
        channel: " SuPPorted ",
        channelLabel: "Custom",
      }).text;

      expect(surface.supportsNativeExecApprovalClient).toHaveBeenCalledExactlyOnceWith("supported");
      if (supported) {
        expect(surface.describeNativeExecApprovalClientSetup).toHaveBeenCalledExactlyOnceWith({
          channel: "supported",
          channelLabel: "Custom",
          accountId: undefined,
        });
      } else {
        expect(surface.describeNativeExecApprovalClientSetup).not.toHaveBeenCalled();
      }
      expect(surface.listNativeExecApprovalClientLabels).toHaveBeenCalledExactlyOnceWith({
        excludeChannel: undefined,
      });
      expect(text).toContain(
        "native chat approval client such as Discord, Matrix, Slack, or Telegram",
      );
    },
  );

  it.each([
    { channel: undefined, channelLabel: "Custom" },
    { channel: "supported", channelLabel: undefined },
  ])("bypasses native setup when its channel or label is missing: %j", (params) => {
    surface.supportsNativeExecApprovalClient.mockReturnValue(true);

    const text = buildExecApprovalUnavailableReplyPayload({
      reason: "initiating-platform-disabled",
      ...params,
    }).text;

    expect(surface.supportsNativeExecApprovalClient).not.toHaveBeenCalled();
    expect(surface.describeNativeExecApprovalClientSetup).not.toHaveBeenCalled();
    expect(surface.listNativeExecApprovalClientLabels).toHaveBeenCalledExactlyOnceWith({
      excludeChannel: undefined,
    });
    expect(text).toContain(
      "native chat approval client such as Discord, Matrix, Slack, or Telegram",
    );
  });

  it("forwards the raw unsupported channel to the fallback client exclusion", () => {
    const text = buildExecApprovalUnavailableReplyPayload({
      reason: "initiating-platform-unsupported",
      channel: " Other-Channel ",
      channelLabel: "Other",
    }).text;

    expect(surface.listNativeExecApprovalClientLabels).toHaveBeenCalledExactlyOnceWith({
      excludeChannel: " Other-Channel ",
    });
    expect(surface.supportsNativeExecApprovalClient).not.toHaveBeenCalled();
    expect(surface.describeNativeExecApprovalClientSetup).not.toHaveBeenCalled();
    expect(text).toContain("Other does not support chat exec approvals.");
    expect(text).toContain(
      "native chat approval client such as Discord, Matrix, Slack, or Telegram",
    );
  });

  it.each(invalidReplyMetadataCases)(
    "returns null for invalid reply metadata payload: $name",
    ({ payload }) => {
      expect(getExecApprovalReplyMetadata(payload as ReplyPayload)).toBeNull();
    },
  );

  it("normalizes reply metadata and filters invalid decisions", () => {
    expect(
      getExecApprovalReplyMetadata({
        channelData: {
          execApproval: {
            approvalId: " req-1 ",
            approvalSlug: " slug-1 ",
            agentId: " agent-1 ",
            allowedDecisions: ["allow-once", "bad", "deny", "allow-always", 3],
            sessionKey: " session-1 ",
          },
        },
      }),
    ).toEqual({
      approvalId: "req-1",
      approvalSlug: "slug-1",
      approvalKind: "exec",
      agentId: "agent-1",
      allowedDecisions: ["allow-once", "deny", "allow-always"],
      sessionKey: "session-1",
    });
  });

  it("builds pending reply payloads with trimmed warning text and slug fallback", () => {
    const payload = buildTypedExecApprovalPendingReplyPayload({
      warningText: "  Heads up.  ",
      approvalId: "req-1",
      approvalSlug: "slug-1",
      command: "echo ok",
      cwd: "/tmp/work",
      host: "gateway",
      nodeId: "node-1",
      scope: { kind: "payment", amount: "49.99", currency: "EUR", target: "Stripe" },
      expiresAtMs: 2500,
      nowMs: 1000,
    });

    expect(payload.channelData).toEqual({
      execApproval: {
        approvalId: "req-1",
        approvalSlug: "slug-1",
        approvalKind: "exec",
        agentId: undefined,
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        sessionKey: undefined,
      },
    });
    expect(payload.presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow Once",
              action: {
                type: "approval",
                approvalId: "req-1",
                approvalKind: "exec",
                decision: "allow-once",
              },
              style: "success",
            },
            {
              label: "Allow Always",
              action: {
                type: "approval",
                approvalId: "req-1",
                approvalKind: "exec",
                decision: "allow-always",
              },
              style: "primary",
            },
            {
              label: "Deny",
              action: {
                type: "approval",
                approvalId: "req-1",
                approvalKind: "exec",
                decision: "deny",
              },
              style: "danger",
            },
          ],
        },
      ],
    });
    expect(payload.interactive).toBeUndefined();
    expect(payload.text).toContain("Heads up.");
    expect(payload.text).toContain("```txt\n/approve slug-1 allow-once\n```");
    expect(payload.text).toContain("```sh\necho ok\n```");
    expect(payload.text).toContain(
      "Host: gateway\nNode: node-1\nCWD: /tmp/work\nScope: Pay 49.99 EUR to Stripe\nExpires in: 2s",
    );
    expect(payload.text).toContain("Full id: `req-1`");
  });

  it("preserves shipped command/value controls in the legacy pending builder", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-legacy",
      approvalSlug: "legacy",
      allowedDecisions: ["deny"],
      command: "echo legacy",
      host: "gateway",
    });

    expect(payload.presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Deny",
              action: { type: "command", command: "/approve req-legacy deny" },
              value: "/approve req-legacy deny",
              style: "danger",
            },
          ],
        },
      ],
    });
    expect(payload.text).not.toContain("Scope:");
  });

  it("compacts structured cwd paths in pending reply payloads", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-home",
      approvalSlug: "slug-home",
      command: "pwd",
      cwd: "C:\\Users\\alice\\project",
      host: "gateway",
    });

    expect(payload.text).toContain("CWD: ~/project");
    expect(payload.text).not.toContain("C:\\Users\\alice");
  });

  it("omits allow-always actions when the effective policy requires approval every time", () => {
    const payload = buildTypedExecApprovalPendingReplyPayload({
      approvalId: "req-ask-always",
      approvalSlug: "slug-always",
      ask: "always",
      command: "echo ok",
      host: "gateway",
    });

    expect(payload.channelData).toEqual({
      execApproval: {
        approvalId: "req-ask-always",
        approvalSlug: "slug-always",
        approvalKind: "exec",
        allowedDecisions: ["allow-once", "deny"],
      },
    });
    expect(payload.text).toContain("```txt\n/approve slug-always allow-once\n```");
    expect(payload.text).not.toContain("allow-always");
    expect(payload.text).toContain("Allow Always is unavailable for this command.");
    expect(payload.presentation).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Allow Once",
              action: {
                type: "approval",
                approvalId: "req-ask-always",
                approvalKind: "exec",
                decision: "allow-once",
              },
              style: "success",
            },
            {
              label: "Deny",
              action: {
                type: "approval",
                approvalId: "req-ask-always",
                approvalKind: "exec",
                decision: "deny",
              },
              style: "danger",
            },
          ],
        },
      ],
    });
    expect(payload.interactive).toBeUndefined();
  });

  it("stores agent and session metadata for downstream suppression checks", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-meta",
      approvalSlug: "slug-meta",
      agentId: "ops-agent",
      sessionKey: "agent:ops-agent:matrix:channel:!room:example.org",
      command: "echo ok",
      host: "gateway",
    });

    expect(payload.channelData).toEqual({
      execApproval: {
        approvalId: "req-meta",
        approvalSlug: "slug-meta",
        approvalKind: "exec",
        agentId: "ops-agent",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        sessionKey: "agent:ops-agent:matrix:channel:!room:example.org",
      },
    });
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

  it("formats longer approval windows in minutes", () => {
    const payload = buildExecApprovalPendingReplyPayload({
      approvalId: "req-30m",
      approvalSlug: "slug-30m",
      command: "echo later",
      host: "gateway",
      expiresAtMs: 1_801_000,
      nowMs: 1_000,
    });

    expect(payload.text).toContain("Expires in: 30m");
  });

  it("builds shared exec approval action descriptors and interactive replies", () => {
    expect(
      buildExecApprovalActionDescriptors({
        approvalCommandId: "req-1",
      }),
    ).toEqual([
      {
        decision: "allow-once",
        label: "Allow Once",
        style: "success",
        command: "/approve req-1 allow-once",
      },
      {
        decision: "allow-always",
        label: "Allow Always",
        style: "primary",
        command: "/approve req-1 allow-always",
      },
      {
        decision: "deny",
        label: "Deny",
        style: "danger",
        command: "/approve req-1 deny",
      },
    ]);

    expect(
      buildApprovalButtonPresentation({
        approvalId: "req-1",
        allowedDecisions: ["deny"],
      }),
    ).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Deny",
              action: { type: "command", command: "/approve req-1 deny" },
              value: "/approve req-1 deny",
              style: "danger",
            },
          ],
        },
      ],
    });

    expect(
      buildApprovalPresentationFromActionDescriptors([
        {
          decision: "deny",
          label: "Deny",
          style: "danger",
          command: "/approve legacy-id deny",
        },
      ]),
    ).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Deny",
              action: { type: "command", command: "/approve legacy-id deny" },
              value: "/approve legacy-id deny",
              style: "danger",
            },
          ],
        },
      ],
    });
  });

  it("builds typed descriptors and presentations only through named typed builders", () => {
    expect(
      buildTypedApprovalActionDescriptors({
        approvalCommandId: "opaque-id",
        approvalKind: "plugin",
        allowedDecisions: ["deny"],
      }),
    ).toEqual([
      {
        decision: "deny",
        label: "Deny",
        style: "danger",
        action: {
          type: "approval",
          approvalId: "opaque-id",
          approvalKind: "plugin",
          decision: "deny",
        },
        command: "/approve opaque-id deny",
      },
    ]);

    expect(
      buildTypedApprovalPresentation({
        approvalId: "opaque-id",
        approvalKind: "plugin",
        allowedDecisions: ["deny"],
      }),
    ).toEqual({
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Deny",
              action: {
                type: "approval",
                approvalId: "opaque-id",
                approvalKind: "plugin",
                decision: "deny",
              },
              style: "danger",
            },
          ],
        },
      ],
    });
  });

  it.each([".", "..", "\uD800", "\uDC00", "broken-\uD800"])(
    "refuses malformed typed approval identity %j",
    (approvalId) => {
      expect(
        buildTypedApprovalActionDescriptors({
          approvalCommandId: approvalId,
          approvalKind: "exec",
          allowedDecisions: ["deny"],
        }),
      ).toEqual([]);
      expect(
        buildTypedApprovalPresentation({
          approvalId,
          approvalKind: "exec",
          allowedDecisions: ["deny"],
        }),
      ).toBeUndefined();
      expect(
        buildTypedExecApprovalPendingReplyPayload({
          approvalId,
          approvalSlug: "safe-slug",
          allowedDecisions: ["deny"],
          command: "echo safe",
          host: "gateway",
        }).presentation,
      ).toBeUndefined();
    },
  );

  it("preserves protocol-valid boundary whitespace in typed approval actions", () => {
    const approvalId = "\uFEFF";

    expect(
      buildTypedApprovalActionDescriptors({
        approvalCommandId: approvalId,
        approvalKind: "exec",
        allowedDecisions: ["deny"],
      }),
    ).toMatchObject([
      {
        action: { type: "approval", approvalId, approvalKind: "exec", decision: "deny" },
      },
    ]);
  });

  it("builds and parses shared exec approval command text", () => {
    expect(
      buildExecApprovalCommandText({
        approvalCommandId: "req-1",
        decision: "allow-always",
      }),
    ).toBe("/approve req-1 allow-always");

    expect(parseExecApprovalCommandText("/approve req-1 deny")).toEqual({
      approvalId: "req-1",
      decision: "deny",
    });
    expect(parseExecApprovalCommandText("approve req-1 allow-once")).toEqual({
      approvalId: "req-1",
      decision: "allow-once",
    });
    expect(parseExecApprovalCommandText("/approve@clover req-1 allow-once")).toEqual({
      approvalId: "req-1",
      decision: "allow-once",
    });
    expect(parseExecApprovalCommandText("  /approve req-1 always")).toEqual({
      approvalId: "req-1",
      decision: "allow-always",
    });
    expect(parseExecApprovalCommandText("/approve req-1 allow-always")).toEqual({
      approvalId: "req-1",
      decision: "allow-always",
    });
    expect(parseExecApprovalCommandText("/approve req-1 maybe")).toBeNull();
  });

  it.each(["no-approval-route", "initiating-platform-disabled"] as const)(
    "returns the approver DM notice before querying collaborators for %s",
    (reason) => {
      surface.supportsNativeExecApprovalClient.mockReturnValue(true);

      expect(
        buildExecApprovalUnavailableReplyPayload({
          warningText: "  Careful.  ",
          reason,
          channel: "supported",
          channelLabel: "Custom",
          sentApproverDms: true,
        }),
      ).toEqual({
        text: "Careful.\n\nApproval required. I sent approval DMs to the approvers for this account.",
        channelData: { execApprovalUnavailable: { reason } },
      });
      expect(surface.supportsNativeExecApprovalClient).not.toHaveBeenCalled();
      expect(surface.describeNativeExecApprovalClientSetup).not.toHaveBeenCalled();
      expect(surface.listNativeExecApprovalClientLabels).not.toHaveBeenCalled();
    },
  );

  it.each(unavailableReasonCases)(
    "builds unavailable payload for reason $reason",
    ({ reason, channelLabel, expected }) => {
      const payload = buildExecApprovalUnavailableReplyPayload({
        reason,
        channelLabel,
      });
      expect(payload.text).toContain(expected);
      expect(payload.channelData).toEqual({ execApprovalUnavailable: { reason } });
    },
  );
});
