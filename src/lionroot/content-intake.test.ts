import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { IMessageInboundDispatchDecision } from "../imessage/monitor/inbound-processing.js";
import {
  clearLastForward,
  clearRecentTweetForward,
  recordLastForward,
  recordRecentTweetForward,
} from "./routing/content-forward.js";

const mockDispatchInboundMessage = vi.hoisted(() => vi.fn());
const mockDeliverOutboundPayloads = vi.hoisted(() => vi.fn());
const mockClassifyContentWithLLM = vi.hoisted(() => vi.fn());
const mockResolveTwitterContent = vi.hoisted(() => vi.fn());
const mockMaybeHandleFoodImageCapture = vi.hoisted(() => vi.fn());
const mockRunBoundedInvestigation = vi.hoisted(() => vi.fn());

vi.mock("../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: mockDispatchInboundMessage,
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: mockDeliverOutboundPayloads,
}));

vi.mock("./routing/content-route.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./routing/content-route.js")>();
  return {
    ...actual,
    classifyContentWithLLM: mockClassifyContentWithLLM,
    resolveTwitterContent: mockResolveTwitterContent,
  };
});

vi.mock("./food-capture.js", () => ({
  maybeHandleFoodImageCapture: mockMaybeHandleFoodImageCapture,
}));

vi.mock("./routing/investigation-orchestrator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./routing/investigation-orchestrator.js")>();
  return {
    ...actual,
    runBoundedInvestigation: mockRunBoundedInvestigation,
  };
});

import { handleContentIntake, type ContentIntakeParams } from "./content-intake.js";

function createConfig(): OpenClawConfig {
  return {
    agents: {
      list: [{ id: "main", default: true }, { id: "cody" }, { id: "liev" }, { id: "leo" }],
      contentRouting: {
        enabled: true,
        model: "qwen3.5:9b",
        defaultAgentId: "leo",
        agents: {
          cody: "Programming, coding, software engineering",
          liev: "Health, wellness, fitness",
          leo: "Strategy, planning, architecture",
        },
        forward: {
          enabled: true,
          channel: "zulip",
          streams: {
            cody: "04💻 coding-loop",
            liev: "08🌱 life-loop",
          },
          streamPattern: "{agent}",
          topicPrefix: "x",
        },
        investigation: {
          enabled: true,
          defaultAgentId: "leo",
          maxSteps: 4,
          maxDurationMs: 15000,
          maxTokens: 900,
          promotionThreshold: "medium",
        },
      },
    },
    channels: {
      zulip: {
        botEmail: "liev-bot@example.com",
        botApiKey: "liev-key", // pragma: allowlist secret
        baseUrl: "https://zulip.example.com",
        accounts: {
          cody: {
            botEmail: "cody-bot@example.com",
            botApiKey: "cody-key", // pragma: allowlist secret
            baseUrl: "https://zulip.example.com",
          },
          liev: {
            botEmail: "liev-bot@example.com",
            botApiKey: "liev-key", // pragma: allowlist secret
            baseUrl: "https://zulip.example.com",
          },
          leo: {
            botEmail: "leo-bot@example.com",
            botApiKey: "leo-key", // pragma: allowlist secret
            baseUrl: "https://zulip.example.com",
          },
        },
      },
    },
    session: {
      dmScope: "per-account-channel-peer",
    },
  } as unknown as OpenClawConfig;
}

function createDecision(): IMessageInboundDispatchDecision {
  return {
    kind: "dispatch",
    isGroup: false,
    sender: "+15551234567",
    senderNormalized: "+15551234567",
    route: {
      agentId: "liev",
      channel: "imessage",
      accountId: "personal",
      sessionKey: "agent:liev:imessage:direct:+15551234567",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    },
    bodyText: "",
    replyContext: null,
    effectiveWasMentioned: true,
    commandAuthorized: false,
    effectiveDmAllowFrom: [],
    effectiveGroupAllowFrom: [],
  };
}

function createParams(): ContentIntakeParams {
  const cfg = createConfig();
  const decision = createDecision();
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    cfg,
    decision: { ...decision },
    message: { sender: decision.sender, id: 42 } as never,
    bodyText: "https://github.com/openclaw/openclaw",
    mediaPath: undefined,
    mediaType: undefined,
    mediaPaths: [],
    mediaTypes: [],
    historyLimit: 0,
    groupHistories: new Map(),
    accountInfo: { accountId: "personal", config: {} },
    runtime: { error: vi.fn() } as never,
    client: {} as never,
    mediaMaxBytes: 1024,
    textLimit: undefined,
    sentMessageCache: {} as never,
    sender: decision.sender,
    sendMessage,
  };
}

describe("handleContentIntake forwarded agent routing", () => {
  beforeEach(() => {
    clearLastForward("+15551234567");
    mockDeliverOutboundPayloads.mockReset().mockResolvedValue([]);
    mockResolveTwitterContent.mockReset().mockResolvedValue(null);
    mockClassifyContentWithLLM.mockReset().mockResolvedValue({
      kind: "recognized",
      agentId: "cody",
      confidence: "high",
      reason: "LLM classified as Cody",
    });
    mockMaybeHandleFoodImageCapture.mockReset().mockResolvedValue(false);
    mockRunBoundedInvestigation.mockReset().mockResolvedValue({
      replyText: "leo: bounded investigation summary",
      rawReplyText: `What you're looking into

A proactive iMessage workflow.`,
      promotionText: undefined,
      shouldPromote: false,
      errorSeen: false,
    });
    mockDispatchInboundMessage.mockReset().mockImplementation(async ({ dispatcher }) => {
      dispatcher.sendFinalReply({ text: "Looks good for OpenClaw integration." });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
  });

  afterEach(async () => {
    clearLastForward("+15551234567");
    await clearRecentTweetForward("+15551234567", "2029856270271008942");
  });

  it("rebuilds the forwarded session key and posts as the classified Zulip account", async () => {
    const params = createParams();

    const result = await handleContentIntake(params);

    expect(result).toEqual({ handled: true });
    expect(params.decision.route.agentId).toBe("cody");
    expect(params.decision.route.sessionKey).toContain("agent:cody:");

    expect(mockDispatchInboundMessage).toHaveBeenCalledTimes(1);
    const [{ ctx }] = mockDispatchInboundMessage.mock.calls.map(([arg]) => arg);
    expect(ctx.SessionKey).toContain("agent:cody:");

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledTimes(2);
    for (const [call] of mockDeliverOutboundPayloads.mock.calls) {
      expect(call.accountId).toBe("cody");
    }
  });

  it("keeps follow-up posts and forwarded replies on the original classified agent/account", async () => {
    const params = createParams();
    params.bodyText = "can we wire this into our repo sync flow?";

    recordLastForward(params.decision.senderNormalized, {
      channel: "zulip",
      to: "stream:04💻 coding-loop:topic:link: github.com",
      agentId: "cody",
      stream: "04💻 coding-loop",
      timestamp: Date.now(),
    });

    const result = await handleContentIntake(params);

    expect(result).toEqual({ handled: true });
    expect(params.decision.route.agentId).toBe("cody");
    expect(params.decision.route.sessionKey).toContain("agent:cody:");

    expect(mockDispatchInboundMessage).toHaveBeenCalledTimes(1);
    const [{ ctx }] = mockDispatchInboundMessage.mock.calls.map(([arg]) => arg);
    expect(ctx.SessionKey).toContain("agent:cody:");

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledTimes(2);
    for (const [call] of mockDeliverOutboundPayloads.mock.calls) {
      expect(call.accountId).toBe("cody");
    }
  });

  it("reuses the existing Zulip thread when the same X link is resent", async () => {
    const params = createParams();
    params.bodyText = "https://x.com/aiwithjainam/status/2029856270271008942?s=10";

    await recordRecentTweetForward(params.decision.senderNormalized, "2029856270271008942", {
      channel: "zulip",
      to: "stream:04💻 coding-loop:topic:x: @aiwithjainam (Jainam Parmar):🚨 This m",
      agentId: "cody",
      stream: "04💻 coding-loop",
      messageId: "3382",
      tweetId: "2029856270271008942",
      timestamp: Date.now(),
    });

    const result = await handleContentIntake(params);

    expect(result).toEqual({ handled: true });
    expect(mockClassifyContentWithLLM).not.toHaveBeenCalled();
    expect(mockResolveTwitterContent).not.toHaveBeenCalled();
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mockDispatchInboundMessage).not.toHaveBeenCalled();
    expect(params.sendMessage).toHaveBeenCalledTimes(1);
    expect(params.sendMessage).toHaveBeenCalledWith(
      params.sender,
      expect.stringContaining("https://zulip.example.com/#narrow/near/3382"),
      expect.any(Object),
    );
  });

  it("handles explicit investigation fast-path requests in iMessage", async () => {
    const params = createParams();
    params.bodyText = "investigate: would BlueBubbles be better than our current relay?";

    const result = await handleContentIntake(params);

    expect(result).toEqual({ handled: true });
    expect(mockRunBoundedInvestigation).toHaveBeenCalledTimes(1);
    expect(mockClassifyContentWithLLM).not.toHaveBeenCalled();
    expect(params.decision.route.agentId).toBe("leo");
    expect(params.decision.route.sessionKey).toContain(":investigation");
    expect(params.sendMessage).toHaveBeenCalledTimes(1);
    expect(params.sendMessage).toHaveBeenCalledWith(
      params.sender,
      expect.stringContaining("bounded investigation summary"),
      expect.any(Object),
    );
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
  });

  it("promotes LLM investigation classifications into Zulip when the result is strong enough", async () => {
    const params = createParams();
    params.bodyText = "I still don't know how this iMessage workflow would work out for me";
    mockClassifyContentWithLLM.mockResolvedValueOnce({
      kind: "recognized",
      agentId: "leo",
      category: "investigate",
      confidence: "high",
      reason: "LLM classified as strategy",
    });
    mockRunBoundedInvestigation.mockResolvedValueOnce({
      replyText: "leo: here's the short answer",
      rawReplyText: `What you're looking into

You want a proactive iMessage workflow with downstream review.

Recommendation: keep iMessage as intake and promote strong findings.`,
      promotionText: `🧭 Investigation — leo

Detailed review artifact`,
      shouldPromote: true,
      errorSeen: false,
    });

    const result = await handleContentIntake(params);

    expect(result).toEqual({ handled: true });
    expect(mockRunBoundedInvestigation).toHaveBeenCalledTimes(1);
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledTimes(1);
    expect(mockDeliverOutboundPayloads.mock.calls[0]?.[0]?.to).toContain("leo");
    expect(params.sendMessage).toHaveBeenCalledTimes(1);
    expect(params.sendMessage).toHaveBeenCalledWith(
      params.sender,
      expect.stringContaining("→ leo #"),
      expect.any(Object),
    );
  });

  it("lets abstained classifications fall back to normal dispatch", async () => {
    const params = createParams();
    params.bodyText = "some ambiguous note";
    mockClassifyContentWithLLM.mockResolvedValueOnce({
      kind: "abstain",
      confidence: "low",
      reason: "LLM timeout/error",
    });

    const result = await handleContentIntake(params);

    expect(result).toEqual({ handled: false });
    expect(params.decision.route.agentId).toBe("liev");
    expect(mockDispatchInboundMessage).not.toHaveBeenCalled();
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
    expect(params.sendMessage).not.toHaveBeenCalled();
  });

  it("does not leak raw provider errors into forwarded iMessage summaries", async () => {
    const params = createParams();
    mockDispatchInboundMessage.mockImplementationOnce(async ({ dispatcher }) => {
      dispatcher.sendFinalReply({ text: "provider error in 200 response", isError: true });
      dispatcher.markComplete();
      await dispatcher.waitForIdle();
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    const result = await handleContentIntake(params);

    expect(result).toEqual({ handled: true });
    expect(params.sendMessage).toHaveBeenCalledTimes(2);
    expect(params.sendMessage).toHaveBeenNthCalledWith(
      2,
      params.sender,
      expect.stringContaining("Forwarded to Zulip, but the agent hit a provider error"),
      expect.any(Object),
    );
    expect(params.sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("provider error in 200 response"),
      expect.anything(),
    );
  });

  it("passes readable attachment text into content classification", async () => {
    const params = createParams();
    params.bodyText = "please route this attachment";
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-content-intake-"));
    const textPath = path.join(tempDir, "PastedText.txt");
    await fs.writeFile(
      textPath,
      "Bryan wants Cody to review this infrastructure bug report.",
      "utf8",
    );
    params.mediaPaths = [textPath];
    params.mediaTypes = ["text/plain"];
    params.mediaType = "text/plain";
    params.mediaPath = textPath;

    await handleContentIntake(params);

    expect(mockClassifyContentWithLLM).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaType: "text/plain",
        attachmentText: expect.stringContaining("infrastructure bug report"),
      }),
    );
  });

  it("fast-path routes explicit health tags to Liev without calling the LLM", async () => {
    const params = createParams();
    params.bodyText = "health: check these recovery numbers";

    const result = await handleContentIntake(params);

    expect(result).toEqual({ handled: true });
    expect(mockClassifyContentWithLLM).not.toHaveBeenCalled();
    expect(params.decision.route.agentId).toBe("liev");
    expect(mockDeliverOutboundPayloads).toHaveBeenCalledTimes(2);
    const [firstForwardCall] = mockDeliverOutboundPayloads.mock.calls;
    expect(firstForwardCall?.[0].to).toContain("08🌱 life-loop");
  });

  it("short-circuits normal routing when a food image capture is handled", async () => {
    const params = createParams();
    params.bodyText = "<media:image>";
    params.mediaType = "image/jpeg";
    params.mediaPath = "/tmp/meal.jpg";
    mockMaybeHandleFoodImageCapture.mockResolvedValueOnce(true);

    const result = await handleContentIntake(params);

    expect(result).toEqual({ handled: true });
    expect(mockMaybeHandleFoodImageCapture).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyText: "<media:image>",
        mediaType: "image/jpeg",
        mediaPath: "/tmp/meal.jpg",
      }),
    );
    expect(mockClassifyContentWithLLM).not.toHaveBeenCalled();
    expect(mockDeliverOutboundPayloads).not.toHaveBeenCalled();
    expect(mockDispatchInboundMessage).not.toHaveBeenCalled();
  });
});
