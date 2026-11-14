import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeNativeExecApprovalClientSetup,
  listNativeExecApprovalClientLabels,
  supportsNativeExecApprovalClient,
} from "./exec-approval-surface.js";

// mock-isolation: reply formatting uses fixed channel capabilities without loading plugins.
vi.mock("./exec-approval-surface.js", () => ({
  describeNativeExecApprovalClientSetup: vi.fn<typeof describeNativeExecApprovalClientSetup>(),
  listNativeExecApprovalClientLabels: vi.fn<typeof listNativeExecApprovalClientLabels>(),
  supportsNativeExecApprovalClient: vi.fn<typeof supportsNativeExecApprovalClient>(),
}));

import {
  buildExecApprovalPendingReplyPayload,
  buildExecApprovalUnavailableReplyPayload,
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

function approvalButtons(approvalId: string, decisions: string[]) {
  return {
    blocks: [
      {
        type: "buttons",
        buttons: decisions.map((decision) => ({
          action: { type: "approval", approvalId, approvalKind: "exec", decision },
        })),
      },
    ],
  };
}

describe("exec approval reply helpers", () => {
  beforeEach(() => {
    vi.mocked(describeNativeExecApprovalClientSetup).mockReset().mockReturnValue(null);
    vi.mocked(listNativeExecApprovalClientLabels)
      .mockReset()
      .mockReturnValue(["Discord", "Matrix", "Slack", "Telegram"]);
    vi.mocked(supportsNativeExecApprovalClient).mockReset().mockReturnValue(true);
  });

  it("only suggests exec-capable recovery surfaces without native clients", () => {
    vi.mocked(listNativeExecApprovalClientLabels).mockReturnValueOnce([]);
    const text = buildExecApprovalUnavailableReplyPayload({ reason: "no-approval-route" }).text;

    expect(text).toContain("Approve it from the Web UI");
    expect(listNativeExecApprovalClientLabels).toHaveBeenCalledExactlyOnceWith({
      host: undefined,
      nodeId: undefined,
    });
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
    expect(listNativeExecApprovalClientLabels).toHaveBeenCalledExactlyOnceWith({
      host: "node",
      nodeId: "mac-1",
    });
    expect(text).not.toMatch(/terminal UI|\bTUI\b/i);
  });

  it("uses account-scoped disabled setup guidance for the initiating channel", () => {
    vi.mocked(describeNativeExecApprovalClientSetup).mockReturnValueOnce(
      "Configure `channels.matrix.accounts.work.dm.allowFrom`.",
    );
    const text = buildExecApprovalUnavailableReplyPayload({
      reason: "initiating-platform-disabled",
      channel: " Matrix ",
      channelLabel: "Matrix",
      accountId: "work",
    }).text;

    expect(text).toContain("`channels.matrix.accounts.work.dm.allowFrom`");
    expect(text).not.toContain("`channels.matrix.dm.allowFrom`");
    expect(supportsNativeExecApprovalClient).toHaveBeenCalledExactlyOnceWith("matrix");
    expect(describeNativeExecApprovalClientSetup).toHaveBeenCalledExactlyOnceWith({
      channel: "matrix",
      channelLabel: "Matrix",
      accountId: "work",
    });
    expect(listNativeExecApprovalClientLabels).not.toHaveBeenCalled();
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
      command: "echo ```danger```",
      cwd: "C:\\Users\\alice\\project",
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
    expect(payload.presentation).toMatchObject(
      approvalButtons("req-1", ["allow-once", "allow-always", "deny"]),
    );
    expect(payload.interactive).toBeUndefined();
    expect(payload.text).toContain("Heads up.");
    expect(payload.text).toContain("```txt\n/approve slug-1 allow-once\n```");
    expect(payload.text).toContain("````sh\necho ```danger```\n````");
    expect(payload.text).not.toContain("C:\\Users\\alice");
    expect(payload.text).toContain(
      "Host: gateway\nNode: node-1\nCWD: ~/project\nScope: Pay 49.99 EUR to Stripe\nExpires in: 2s",
    );
    expect(payload.text).toContain("Full id: `req-1`");
  });

  it("uses a trimmed command id and omits absent expiry", () => {
    const { text } = typedPending({ approvalCommandId: " req-cmd-2 ", host: "sandbox" });
    expect(text).toContain("```txt\n/approve req-cmd-2 allow-once\n```");
    expect(text).not.toContain("Expires in:");
  });

  it("formats minute expiry", () => {
    expect(typedPending({ expiresAtMs: 1_801_000, nowMs: 1_000 }).text).toContain(
      "Expires in: 30m",
    );
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
    expect(payload.presentation).toMatchObject(
      approvalButtons("req-ask-always", ["allow-once", "deny"]),
    );
    expect(payload.interactive).toBeUndefined();
  });

  it.each([".", "broken-\uD800"])("refuses malformed typed approval identity %j", (approvalId) => {
    expect(
      typedPending({
        approvalId,
        approvalSlug: "safe-slug",
        allowedDecisions: ["deny"],
      }).presentation,
    ).toBeUndefined();
  });

  it("parses exec approval command text", () => {
    for (const [command, decision] of [
      ["/approve req-1 deny", "deny"],
      ["approve req-1 allow-once", "allow-once"],
      ["/approve@clover req-1 allow-once", "allow-once"],
      ["  /approve req-1 always", "allow-always"],
      ["/approve req-1 allow-always", "allow-always"],
      ["/approve req-1 maybe", null],
    ] as const) {
      expect(parseExecApprovalCommandText(command)).toEqual(
        decision ? { approvalId: "req-1", decision } : null,
      );
    }
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
    expect(supportsNativeExecApprovalClient).not.toHaveBeenCalled();
    expect(describeNativeExecApprovalClientSetup).not.toHaveBeenCalled();
    expect(listNativeExecApprovalClientLabels).not.toHaveBeenCalled();
  });

  it.each([
    [
      "initiating-platform-disabled",
      "Slack",
      "Exec approval is required, but native chat exec approvals are not configured on Slack.",
    ],
    [
      "initiating-platform-unsupported",
      undefined,
      "Exec approval is required, but this platform does not support chat exec approvals.",
    ],
  ] as const)("builds unavailable payload for reason %s", (reason, channelLabel, expected) => {
    const payload = buildExecApprovalUnavailableReplyPayload({ reason, channelLabel });
    expect(payload.text).toContain(expected);
    expect(payload.channelData).toEqual({ execApprovalUnavailable: { reason } });
  });
});
