// Tests execution approval reply text and decision formatting.
import { describe, expect, it } from "vitest";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  buildApprovalButtonPresentation,
  buildApprovalPresentationFromActionDescriptors,
  buildExecApprovalActionDescriptors,
  buildExecApprovalCommandText,
  buildExecApprovalPendingReplyPayload,
  buildTypedApprovalActionDescriptors,
  buildTypedApprovalPresentation,
  buildTypedExecApprovalPendingReplyPayload,
  getExecApprovalApproverDmNoticeText,
  getExecApprovalReplyMetadata,
  parseExecApprovalCommandText,
} from "./exec-approval-reply.js";

describe("exec approval reply helpers", () => {
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

  it("returns the approver DM notice text", () => {
    expect(getExecApprovalApproverDmNoticeText()).toBe(
      "Approval required. I sent approval DMs to the approvers for this account.",
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
        deliveryRoute: undefined,
        expiresAtMs: 2500,
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
});
