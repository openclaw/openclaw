/**
 * PR-11: tests for the universal /plan slash command handler.
 *
 * Focuses on the parser + dispatch layer (subcommand recognition,
 * sessions.patch payload shapes, restate rendering, error surfaces).
 * Channel-specific authorization paths reuse the same helpers as
 * /approve and are covered by that test suite.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { handlePlanCommand } from "./commands-plan.js";
import type { HandleCommandsParams } from "./commands-types.js";

const callGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/call.js", () => ({
  callGateway: callGatewayMock,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../infra/channel-approval-auth.js", () => ({
  resolveApprovalCommandAuthorization: () => ({
    explicit: true,
    authorized: true,
    reason: undefined,
  }),
}));

vi.mock("./channel-context.js", () => ({
  resolveChannelAccountId: () => "test-account",
}));

vi.mock("./command-gates.js", () => ({
  requireGatewayClientScopeForInternalChannel: () => null,
}));

function makeParams(overrides: {
  body: string;
  sessionEntry?: SessionEntry;
  channel?: string;
  isAuthorized?: boolean;
}): HandleCommandsParams {
  // Cast through `unknown` because we deliberately omit fields we
  // don't exercise (ctx, opts, etc). The handler under test only
  // touches command, sessionKey, sessionEntry, cfg.
  return {
    cfg: {} as OpenClawConfig,
    ctx: {} as HandleCommandsParams["ctx"],
    command: {
      surface: "test",
      channel: overrides.channel ?? "telegram",
      ownerList: [],
      senderIsOwner: true,
      isAuthorizedSender: overrides.isAuthorized ?? true,
      senderId: "u1",
      rawBodyNormalized: overrides.body,
      commandBodyNormalized: overrides.body,
    },
    sessionKey: "agent:main:main",
    sessionEntry: overrides.sessionEntry,
    workspaceDir: "/tmp",
    directives: {} as HandleCommandsParams["directives"],
    elevated: { enabled: false, allowed: false, failures: [] },
    defaultGroupActivation: () => "always",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    provider: "anthropic",
    model: "sonnet-4.6",
    contextTokens: 0,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

describe("/plan handler — parser dispatch", () => {
  beforeEach(() => {
    callGatewayMock.mockReset();
  });

  it("returns null for non-plan input", async () => {
    const result = await handlePlanCommand(makeParams({ body: "hello" }), true);
    expect(result).toBeNull();
  });

  it("returns null when text commands are disallowed", async () => {
    const result = await handlePlanCommand(makeParams({ body: "/plan accept" }), false);
    expect(result).toBeNull();
  });

  it("/plan with no args returns the plan-mode status", async () => {
    const result = await handlePlanCommand(makeParams({ body: "/plan" }), true);
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Plan mode is **off**");
  });

  it("/plan status with active plan-mode session reports mode + approval state", async () => {
    const result = await handlePlanCommand(
      makeParams({
        body: "/plan status",
        sessionEntry: {
          planMode: {
            mode: "plan",
            approval: "pending",
            approvalId: "a1",
            rejectionCount: 2,
            updatedAt: 1,
            autoApprove: true,
          },
        } as unknown as SessionEntry,
      }),
      true,
    );
    expect(result?.reply?.text).toContain("plan");
    expect(result?.reply?.text).toContain("pending");
    expect(result?.reply?.text).toContain("Auto-approve: **on**");
    expect(result?.reply?.text).toContain("Rejection cycles: 2");
  });

  it("/plan view points users to /plan restate on text channels", async () => {
    const result = await handlePlanCommand(makeParams({ body: "/plan view" }), true);
    expect(result?.reply?.text).toContain("Use /plan restate");
  });

  it("/plan accept without an active pending approval bails with friendly error (review M1)", async () => {
    const result = await handlePlanCommand(makeParams({ body: "/plan accept" }), true);
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("No pending plan to accept");
  });

  it("/plan accept patches sessions with action=approve", async () => {
    callGatewayMock.mockResolvedValueOnce({});
    const result = await handlePlanCommand(
      makeParams({
        body: "/plan accept",
        sessionEntry: {
          planMode: {
            mode: "plan",
            approval: "pending",
            approvalId: "a1",
            rejectionCount: 0,
            updatedAt: 1,
          },
        } as unknown as SessionEntry,
      }),
      true,
    );
    expect(callGatewayMock).toHaveBeenCalledOnce();
    const args = callGatewayMock.mock.calls[0][0];
    expect(args.method).toBe("sessions.patch");
    expect(args.params).toMatchObject({
      key: "agent:main:main",
      planApproval: { action: "approve", approvalId: "a1" },
    });
    expect(result?.reply?.text).toContain("**accepted**");
  });

  it("/plan accept edits patches with action=edit", async () => {
    callGatewayMock.mockResolvedValueOnce({});
    const result = await handlePlanCommand(
      makeParams({
        body: "/plan accept edits",
        sessionEntry: {
          planMode: {
            mode: "plan",
            approval: "pending",
            approvalId: "a2",
            rejectionCount: 0,
            updatedAt: 1,
          },
        } as unknown as SessionEntry,
      }),
      true,
    );
    const args = callGatewayMock.mock.calls[0][0];
    expect(args.params.planApproval).toMatchObject({ action: "edit", approvalId: "a2" });
    expect(result?.reply?.text).toContain("accepted with edits");
  });

  it("/plan revise <feedback> patches with action=reject + feedback", async () => {
    callGatewayMock.mockResolvedValueOnce({});
    const result = await handlePlanCommand(
      makeParams({
        body: "/plan revise add error handling for the websocket reconnect",
        sessionEntry: {
          planMode: {
            mode: "plan",
            approval: "pending",
            approvalId: "a1",
            rejectionCount: 0,
            updatedAt: 1,
          },
        } as unknown as SessionEntry,
      }),
      true,
    );
    const args = callGatewayMock.mock.calls[0][0];
    expect(args.params.planApproval).toMatchObject({
      action: "reject",
      feedback: "add error handling for the websocket reconnect",
      approvalId: "a1",
    });
    expect(result?.reply?.text).toContain("revision");
  });

  it("/plan revise without feedback rejects with usage error (review H2)", async () => {
    const result = await handlePlanCommand(makeParams({ body: "/plan revise" }), true);
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("Usage: /plan revise <feedback>");
  });

  it("/plan auto with no arg defaults to autoEnabled=true", async () => {
    callGatewayMock.mockResolvedValueOnce({});
    await handlePlanCommand(makeParams({ body: "/plan auto" }), true);
    expect(callGatewayMock.mock.calls[0][0].params.planApproval).toMatchObject({
      action: "auto",
      autoEnabled: true,
    });
  });

  it("/plan auto on enables", async () => {
    callGatewayMock.mockResolvedValueOnce({});
    await handlePlanCommand(makeParams({ body: "/plan auto on" }), true);
    expect(callGatewayMock.mock.calls[0][0].params.planApproval.autoEnabled).toBe(true);
  });

  it("/plan auto off disables", async () => {
    callGatewayMock.mockResolvedValueOnce({});
    await handlePlanCommand(makeParams({ body: "/plan auto off" }), true);
    expect(callGatewayMock.mock.calls[0][0].params.planApproval.autoEnabled).toBe(false);
  });

  it("/plan auto bogus rejects", async () => {
    const result = await handlePlanCommand(makeParams({ body: "/plan auto bogus" }), true);
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("Unrecognized");
  });

  it("/plan on patches planMode='plan'", async () => {
    callGatewayMock.mockResolvedValueOnce({});
    const result = await handlePlanCommand(makeParams({ body: "/plan on" }), true);
    expect(callGatewayMock.mock.calls[0][0].params).toMatchObject({
      key: "agent:main:main",
      planMode: "plan",
    });
    expect(result?.reply?.text).toContain("**enabled**");
  });

  it("/plan off patches planMode='normal'", async () => {
    callGatewayMock.mockResolvedValueOnce({});
    const result = await handlePlanCommand(makeParams({ body: "/plan off" }), true);
    expect(callGatewayMock.mock.calls[0][0].params).toMatchObject({
      key: "agent:main:main",
      planMode: "normal",
    });
    expect(result?.reply?.text).toContain("**disabled**");
  });

  it("/plan restate without an active plan returns a friendly message", async () => {
    const result = await handlePlanCommand(makeParams({ body: "/plan restate" }), true);
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("No active plan");
  });

  it("/plan restate renders the plan checklist when steps are present (Telegram → HTML)", async () => {
    const result = await handlePlanCommand(
      makeParams({
        body: "/plan restate",
        channel: "telegram",
        sessionEntry: {
          planMode: {
            mode: "plan",
            approval: "none",
            rejectionCount: 0,
            updatedAt: 1,
            lastPlanSteps: [
              { step: "Read the docs", status: "completed" },
              { step: "Wire the handler", status: "in_progress", activeForm: "Wiring the handler" },
              { step: "Add tests", status: "pending" },
            ],
          },
        } as unknown as SessionEntry,
      }),
      true,
    );
    expect(result?.reply?.text).toContain("<b>Current plan:</b>");
    // HTML render uses the activeForm for in_progress steps.
    expect(result?.reply?.text).toContain("Wiring the handler");
  });

  it("/plan restate uses Slack mrkdwn on Slack channels", async () => {
    const result = await handlePlanCommand(
      makeParams({
        body: "/plan restate",
        channel: "slack",
        sessionEntry: {
          planMode: {
            mode: "plan",
            approval: "none",
            rejectionCount: 0,
            updatedAt: 1,
            lastPlanSteps: [{ step: "Hello", status: "pending" }],
          },
        } as unknown as SessionEntry,
      }),
      true,
    );
    expect(result?.reply?.text?.startsWith("*Current plan:*")).toBe(true);
  });

  it("/plan restate uses plaintext on iMessage / Signal", async () => {
    const result = await handlePlanCommand(
      makeParams({
        body: "/plan restate",
        channel: "imessage",
        sessionEntry: {
          planMode: {
            mode: "plan",
            approval: "none",
            rejectionCount: 0,
            updatedAt: 1,
            lastPlanSteps: [{ step: "Hello", status: "pending" }],
          },
        } as unknown as SessionEntry,
      }),
      true,
    );
    expect(result?.reply?.text?.startsWith("Current plan:")).toBe(true);
    // Plaintext output should NOT contain HTML or mrkdwn markers.
    expect(result?.reply?.text).not.toContain("<b>");
    expect(result?.reply?.text).not.toContain("*Current");
  });

  it("rejects /plan@otherbot mention prefix on Telegram (cross-bot disambiguation)", async () => {
    const result = await handlePlanCommand(
      makeParams({ body: "/plan@otherbot accept", channel: "telegram" }),
      true,
    );
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("targets a different Telegram bot");
  });

  it("does NOT reject /plan@<word> on non-Telegram channels (review H1)", async () => {
    // On Discord/Slack/etc, `/plan@something` is NOT a valid /plan
    // command (the parser's COMMAND_REGEX requires whitespace or
    // end-of-string after `plan`). The key contract: the handler must
    // not surface the Telegram-specific "targets a different bot"
    // error to non-Telegram channels — it should fall through to null
    // (so other handlers / agent dispatch can process the line).
    const result = await handlePlanCommand(
      makeParams({ body: "/plan@alice accept", channel: "discord" }),
      true,
    );
    // Either null (parser didn't match) or some other reply — but
    // never the Telegram foreign-bot error string.
    if (result?.reply?.text) {
      expect(result.reply.text).not.toContain("targets a different");
    } else {
      expect(result).toBeNull();
    }
  });

  it("verifies the Telegram-specific foreign-bot error fires only on telegram channel", async () => {
    // Sanity check: on Discord, `/plan` followed by space then a
    // legitimate subcommand parses correctly even with @-mentions in
    // the args. (The H1 fix means @-suffix-on-command isn't a parse
    // error on non-Telegram, but the parser still requires whitespace
    // between command and args.)
    callGatewayMock.mockResolvedValueOnce({});
    const result = await handlePlanCommand(
      makeParams({ body: "/plan accept", channel: "discord" }),
      true,
    );
    expect(result?.reply?.text).not.toContain("targets a different");
  });

  it("maps gateway 'stale approvalId' error to a friendly chat message (review L3)", async () => {
    callGatewayMock.mockRejectedValueOnce(
      new Error(
        "planApproval ignored: stale approvalId or session is in a terminal approval state",
      ),
    );
    const result = await handlePlanCommand(
      makeParams({
        body: "/plan accept",
        sessionEntry: {
          planMode: {
            mode: "plan",
            approval: "pending",
            approvalId: "old",
            rejectionCount: 0,
            updatedAt: 1,
          },
        } as unknown as SessionEntry,
      }),
      true,
    );
    expect(result?.reply?.text).toContain("Plan was already resolved");
  });

  it("/plan revise neutralizes @-mention bombs in the feedback echo (deep-dive M8)", async () => {
    callGatewayMock.mockResolvedValueOnce({});
    const result = await handlePlanCommand(
      makeParams({
        body: "/plan revise @everyone please review by EOD <@!12345>",
        sessionEntry: {
          planMode: {
            mode: "plan",
            approval: "pending",
            approvalId: "a1",
            rejectionCount: 0,
            updatedAt: 1,
          },
        } as unknown as SessionEntry,
      }),
      true,
    );
    // Feedback was forwarded to gateway as-is (server-side sanitization
    // is its own concern; we don't double-process there).
    expect(callGatewayMock.mock.calls[0][0].params.planApproval.feedback).toBe(
      "@everyone please review by EOD <@!12345>",
    );
    // But the BOT'S reply to the channel must have the mentions
    // neutralized so the bot doesn't ping the channel itself.
    expect(result?.reply?.text).not.toMatch(/@everyone\b/);
    expect(result?.reply?.text).toContain("@\uFE6Beveryone"); // ﹫-style neutralization
    expect(result?.reply?.text).toContain("<\u200B@!12345>"); // zero-width-space inside Discord raw mention
  });

  it("/plan restate truncates output above the channel size cap (deep-dive M7)", async () => {
    // Build a 100-step plan to force truncation. Each step adds ~30 chars.
    const longSteps = Array.from({ length: 100 }, (_, i) => ({
      step: `step ${i.toString().padStart(3, "0")} — long descriptive sentence text`,
      status: "pending",
    }));
    const result = await handlePlanCommand(
      makeParams({
        body: "/plan restate",
        channel: "telegram",
        sessionEntry: {
          planMode: {
            mode: "plan",
            approval: "none",
            rejectionCount: 0,
            updatedAt: 1,
            lastPlanSteps: longSteps,
          },
        } as unknown as SessionEntry,
      }),
      true,
    );
    expect(result?.reply?.text).toBeDefined();
    // Message must stay under Telegram's 4096-char limit (with headroom).
    expect(result!.reply!.text!.length).toBeLessThanOrEqual(4096);
    expect(result?.reply?.text).toContain("more line");
  });

  it("plaintext format applies to extended SMS-like channels (review M4)", async () => {
    for (const channel of ["irc", "nostr", "voice-call", "line", "qqbot", "zalo"]) {
      const result = await handlePlanCommand(
        makeParams({
          body: "/plan restate",
          channel,
          sessionEntry: {
            planMode: {
              mode: "plan",
              approval: "none",
              rejectionCount: 0,
              updatedAt: 1,
              lastPlanSteps: [{ step: "Hello", status: "pending" }],
            },
          } as unknown as SessionEntry,
        }),
        true,
      );
      expect(result?.reply?.text?.startsWith("Current plan:")).toBe(true);
      expect(result?.reply?.text).not.toContain("<b>");
      expect(result?.reply?.text).not.toContain("*Current");
    }
  });

  it("surfaces 'plan mode is disabled' config error legibly", async () => {
    callGatewayMock.mockRejectedValueOnce(
      new Error("plan mode is disabled — set agents.defaults.planMode.enabled: true to enable"),
    );
    const result = await handlePlanCommand(makeParams({ body: "/plan on" }), true);
    expect(result?.reply?.text).toContain("Plan mode is disabled at the config level");
  });

  it("surfaces other gateway errors with the raw message prefix", async () => {
    callGatewayMock.mockRejectedValueOnce(new Error("network blip"));
    const result = await handlePlanCommand(
      makeParams({
        body: "/plan accept",
        sessionEntry: {
          planMode: {
            mode: "plan",
            approval: "pending",
            approvalId: "a3",
            rejectionCount: 0,
            updatedAt: 1,
          },
        } as unknown as SessionEntry,
      }),
      true,
    );
    expect(result?.reply?.text).toContain("Failed to apply /plan command");
    expect(result?.reply?.text).toContain("network blip");
  });

  it("status / view subcommands skip authorization checks (anyone can ask state)", async () => {
    // PR-11 review M3 carve-out: only status + view are open to all
    // chat participants. /plan restate now requires operator auth so
    // plan-step text isn't exfiltrated.
    const result = await handlePlanCommand(
      makeParams({ body: "/plan status", isAuthorized: false }),
      true,
    );
    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Plan mode is **off**");
  });
});
