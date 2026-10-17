import { describe, expect, it, vi } from "vitest";
import { listNativeExecApprovalClientLabels } from "./exec-approval-surface.js";

// mock-isolation: reply formatting uses fixed channel capabilities without loading plugins.
vi.mock("./exec-approval-surface.js", () => ({
  describeNativeExecApprovalClientSetup: vi.fn(
    ({ channel, accountId }: { channel?: string; accountId?: string }) =>
      channel === "matrix"
        ? `Configure \`channels.matrix.accounts.${accountId}.dm.allowFrom\`.`
        : null,
  ),
  listNativeExecApprovalClientLabels: vi.fn(() => ["Discord", "Matrix", "Slack", "Telegram"]),
  supportsNativeExecApprovalClient: vi.fn((channel?: string | null) =>
    ["discord", "matrix", "slack", "telegram"].includes((channel ?? "").trim().toLowerCase()),
  ),
}));

import {
  buildExecApprovalPendingReplyPayload,
  buildExecApprovalUnavailableReplyPayload,
  buildTypedApprovalActionDescriptors,
  buildTypedApprovalPresentation,
  buildTypedExecApprovalPendingReplyPayload,
  getExecApprovalReplyMetadata,
  parseExecApprovalCommandText,
} from "./exec-approval-reply.js";

type PendingOptions = Partial<Parameters<typeof buildExecApprovalPendingReplyPayload>[0]>;
const pendingOptions = (options: PendingOptions) => ({
  approvalId: "req-1",
  approvalSlug: "slug-1",
  command: "echo ok",
  host: "gateway" as const,
  ...options,
});
const typedPending = (options: PendingOptions) =>
  buildTypedExecApprovalPendingReplyPayload(pendingOptions(options));
const metadata = (execApproval: unknown) =>
  getExecApprovalReplyMetadata({ channelData: { execApproval } });

function approvalButtons(approvalId: string, always = true) {
  const buttons = [
    { label: "Allow Once", decision: "allow-once", style: "success" },
    ...(always ? [{ label: "Allow Always", decision: "allow-always", style: "primary" }] : []),
    { label: "Deny", decision: "deny", style: "danger" },
  ];
  return {
    blocks: [
      {
        type: "buttons",
        buttons: buttons.map(({ decision, ...button }) =>
          Object.assign(button, {
            action: { type: "approval", approvalId, approvalKind: "exec", decision },
          }),
        ),
      },
    ],
  };
}

describe("exec approval reply helpers", () => {
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
  ] as const;

  it("only suggests exec-capable recovery surfaces without native clients", () => {
    vi.mocked(listNativeExecApprovalClientLabels).mockReturnValueOnce([]);
    const text = buildExecApprovalUnavailableReplyPayload({ reason: "no-approval-route" }).text;

    expect(text).toContain("Approve it from the Web UI");
    expect(text).not.toMatch(/terminal UI|\bTUI\b/i);
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
    expect(text).not.toMatch(/terminal UI|\bTUI\b/i);
  });

  it("uses account-scoped disabled setup guidance for the initiating channel", () => {
    const text = buildExecApprovalUnavailableReplyPayload({
      reason: "initiating-platform-disabled",
      channel: "matrix",
      channelLabel: "Matrix",
      accountId: "work",
    }).text;

    expect(text).toContain("`channels.matrix.accounts.work.dm.allowFrom`");
    expect(text).not.toContain("`channels.matrix.dm.allowFrom`");
  });

  it.each([
    null,
    { approvalId: "req-1", approvalSlug: "  " },
    { approvalId: "  ", approvalSlug: "slug-1" },
  ])("returns null for invalid reply metadata %j", (value) => expect(metadata(value)).toBeNull());

  it("normalizes reply metadata and filters invalid decisions", () => {
    expect(
      metadata({
        approvalId: " req-1 ",
        approvalSlug: " slug-1 ",
        agentId: " agent-1 ",
        allowedDecisions: ["allow-once", "bad", "deny", "allow-always", 3],
        sessionKey: " session-1 ",
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
    const payload = typedPending({
      warningText: "  Heads up.  ",
      cwd: "/tmp/work",
      nodeId: "node-1",
      agentId: "ops-agent",
      sessionKey: "agent:ops-agent:matrix:channel:!room:example.org",
      scope: { kind: "payment", amount: "49.99", currency: "EUR", target: "Stripe" },
      expiresAtMs: 2500,
      nowMs: 1000,
    });

    expect(payload.channelData).toEqual({
      execApproval: {
        approvalId: "req-1",
        approvalSlug: "slug-1",
        approvalKind: "exec",
        agentId: "ops-agent",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        sessionKey: "agent:ops-agent:matrix:channel:!room:example.org",
      },
    });
    expect(payload.presentation).toEqual(approvalButtons("req-1"));
    expect(payload.interactive).toBeUndefined();
    expect(payload.text).toContain("Heads up.");
    expect(payload.text).toContain("```txt\n/approve slug-1 allow-once\n```");
    expect(payload.text).toContain("```sh\necho ok\n```");
    expect(payload.text).toContain(
      "Host: gateway\nNode: node-1\nCWD: /tmp/work\nScope: Pay 49.99 EUR to Stripe\nExpires in: 2s",
    );
    expect(payload.text).toContain("Full id: `req-1`");
  });

  it.each([
    {
      name: "compact cwd",
      options: { command: "pwd", cwd: "C:\\Users\\alice\\project" },
      contains: ["CWD: ~/project"],
      excludes: ["C:\\Users\\alice"],
    },
    {
      name: "backtick fences",
      options: { approvalCommandId: " req-cmd-2 ", command: "echo ```danger```", host: "sandbox" },
      contains: ["```txt\n/approve req-cmd-2 allow-once\n```", "````sh\necho ```danger```\n````"],
      excludes: ["Expires in:"],
    },
    {
      name: "minute expiry",
      options: { command: "echo later", expiresAtMs: 1_801_000, nowMs: 1_000 },
      contains: ["Expires in: 30m"],
      excludes: [],
    },
  ] satisfies Array<{
    name: string;
    options: PendingOptions;
    contains: string[];
    excludes: string[];
  }>)("formats pending replies: $name", ({ options, contains, excludes }) => {
    const { text } = buildExecApprovalPendingReplyPayload(pendingOptions(options));
    for (const expected of contains) {
      expect(text).toContain(expected);
    }
    for (const forbidden of excludes) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("omits allow-always actions when the effective policy requires approval every time", () => {
    const payload = typedPending({
      approvalId: "req-ask-always",
      approvalSlug: "slug-always",
      ask: "always",
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
    expect(payload.presentation).toEqual(approvalButtons("req-ask-always", false));
    expect(payload.interactive).toBeUndefined();
  });

  it.each([".", "broken-\uD800"])("refuses malformed typed approval identity %j", (approvalId) => {
    const denied = { approvalKind: "exec" as const, allowedDecisions: ["deny"] as const };
    expect(
      buildTypedApprovalActionDescriptors({
        approvalCommandId: approvalId,
        ...denied,
      }),
    ).toEqual([]);
    expect(buildTypedApprovalPresentation({ approvalId, ...denied })).toBeUndefined();
    expect(
      typedPending({
        approvalId,
        approvalSlug: "safe-slug",
        allowedDecisions: ["deny"],
      }).presentation,
    ).toBeUndefined();
  });

  it("parses exec approval command text", () => {
    expect(
      [
        "/approve req-1 deny",
        "approve req-1 allow-once",
        "/approve@clover req-1 allow-once",
        "  /approve req-1 always",
        "/approve req-1 allow-always",
        "/approve req-1 maybe",
      ].map(parseExecApprovalCommandText),
    ).toEqual([
      { approvalId: "req-1", decision: "deny" },
      { approvalId: "req-1", decision: "allow-once" },
      { approvalId: "req-1", decision: "allow-once" },
      { approvalId: "req-1", decision: "allow-always" },
      { approvalId: "req-1", decision: "allow-always" },
      null,
    ]);
  });

  it("builds unavailable payloads for approver DMs", () => {
    expect(
      buildExecApprovalUnavailableReplyPayload({
        warningText: "  Careful.  ",
        reason: "no-approval-route",
        sentApproverDms: true,
      }),
    ).toEqual({
      text: "Careful.\n\nApproval required. I sent approval DMs to the approvers for this account.",
      channelData: {
        execApprovalUnavailable: { reason: "no-approval-route" },
      },
    });
  });

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
