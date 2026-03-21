import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { IMessageInboundDispatchDecision } from "../../imessage/monitor/inbound-processing.js";

const mockDispatchInboundMessage = vi.hoisted(() => vi.fn());

vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: mockDispatchInboundMessage,
}));

import {
  formatInvestigationReply,
  resolveInvestigationConfig,
  runBoundedInvestigation,
  shouldPromoteInvestigation,
} from "./investigation-orchestrator.js";

function createDecision(): IMessageInboundDispatchDecision {
  return {
    kind: "dispatch",
    isGroup: false,
    sender: "+15551234567",
    senderNormalized: "+15551234567",
    route: {
      agentId: "leo",
      channel: "imessage",
      accountId: "personal",
      sessionKey: "agent:leo:imessage:personal:direct:+15551234567:investigation",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "content",
    },
    bodyText: "investigate: compare BlueBubbles to our current relay",
    replyContext: null,
    effectiveWasMentioned: true,
    commandAuthorized: false,
    effectiveDmAllowFrom: [],
    effectiveGroupAllowFrom: [],
  };
}

describe("investigation-orchestrator", () => {
  beforeEach(() => {
    mockDispatchInboundMessage.mockReset();
  });

  it("resolves defaults with content-routing fallback agent", () => {
    expect(
      resolveInvestigationConfig({
        contentRoutingDefaultAgentId: "leo",
        investigation: { enabled: true, maxSteps: 3 },
      }),
    ).toEqual({
      enabled: true,
      maxSteps: 3,
      maxDurationMs: 30_000,
      maxTokens: 2_000,
      promotionThreshold: "medium",
      defaultAgentId: "leo",
    });
  });

  it("formats fallback replies when no usable output arrives", () => {
    expect(
      formatInvestigationReply({
        agentId: "leo",
        rawReplyText: undefined,
        errorSeen: true,
      }),
    ).toContain("provider issue");
  });

  it("promotes medium-threshold investigations only when signals are strong enough", () => {
    expect(
      shouldPromoteInvestigation({
        threshold: "medium",
        replyText:
          "What you're looking into\n\n- the gateway path\n- the review surface\n\nRecommendation: move iMessage to bounded intake and keep review in Command Post.",
      }),
    ).toBe(true);
    expect(
      shouldPromoteInvestigation({
        threshold: "medium",
        replyText: "Probably not worth it.",
      }),
    ).toBe(false);
  });

  it("injects a bounded investigation prompt and returns the final reply", async () => {
    mockDispatchInboundMessage.mockImplementationOnce(async ({ ctx, dispatcher }) => {
      expect(ctx.BodyForAgent).toContain("Run a bounded investigation");
      expect(ctx.BodyForAgent).toContain("at most 4 concrete investigative steps");
      expect(ctx.BodyForAgent).toContain("compare BlueBubbles to our current relay");
      dispatcher.sendFinalReply({
        text: "What you're looking into\n\nYou want a proactive iMessage investigation flow.\n\nRecommendation: prototype it in clawdbot first.",
      });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    const result = await runBoundedInvestigation({
      cfg: {} as OpenClawConfig,
      decision: createDecision(),
      message: { sender: "+15551234567", id: 42 } as never,
      bodyText: "investigate: compare BlueBubbles to our current relay",
      historyLimit: 0,
      groupHistories: new Map(),
      media: {},
      accountInfo: { accountId: "personal", config: {} },
      investigation: {
        enabled: true,
        maxSteps: 4,
        maxDurationMs: 15_000,
        maxTokens: 900,
        promotionThreshold: "medium",
        defaultAgentId: "leo",
      },
      reason: "fast-path: investigate tag",
    });

    expect(result.replyText).toContain("leo:");
    expect(result.rawReplyText).toContain("proactive iMessage investigation flow");
    expect(result.shouldPromote).toBe(true);
    expect(result.promotionText).toContain("Route reason: fast-path: investigate tag");
  });
});
