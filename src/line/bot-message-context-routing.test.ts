import type { MessageEvent, PostbackEvent } from "@line/bot-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Hoisted mocks ────────────────────────────────────────────────────
const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveAgentRoute: vi.fn(),
  formatInboundEnvelope: vi.fn(),
  resolveEnvelopeFormatOptions: vi.fn(),
  finalizeInboundContext: vi.fn(),
  readSessionUpdatedAt: vi.fn(),
  recordSessionMetaFromInbound: vi.fn(),
  resolveStorePath: vi.fn(),
  updateLastRoute: vi.fn(),
  recordChannelActivity: vi.fn(),
  logVerbose: vi.fn(),
  shouldLogVerbose: vi.fn(),
}));

vi.mock("../config/config.js", () => ({ loadConfig: mocks.loadConfig }));
vi.mock("../routing/resolve-route.js", () => ({ resolveAgentRoute: mocks.resolveAgentRoute }));
vi.mock("../auto-reply/envelope.js", () => ({
  formatInboundEnvelope: mocks.formatInboundEnvelope,
  resolveEnvelopeFormatOptions: mocks.resolveEnvelopeFormatOptions,
}));
vi.mock("../auto-reply/reply/inbound-context.js", () => ({
  finalizeInboundContext: mocks.finalizeInboundContext,
}));
vi.mock("../config/sessions.js", () => ({
  readSessionUpdatedAt: mocks.readSessionUpdatedAt,
  recordSessionMetaFromInbound: mocks.recordSessionMetaFromInbound,
  resolveStorePath: mocks.resolveStorePath,
  updateLastRoute: mocks.updateLastRoute,
}));
vi.mock("../globals.js", () => ({
  logVerbose: mocks.logVerbose,
  shouldLogVerbose: mocks.shouldLogVerbose,
}));
vi.mock("../infra/channel-activity.js", () => ({
  recordChannelActivity: mocks.recordChannelActivity,
}));
vi.mock("../channels/location.js", () => ({
  formatLocationText: vi.fn(),
  toLocationContext: vi.fn(),
}));

// ── Fixtures ─────────────────────────────────────────────────────────

/** Config returned by loadConfig() — represents the live, on-disk config. */
function makeFreshConfig() {
  return { session: { store: "sessions.json" }, _fresh: true } as never;
}

/** Config captured in the closure at bot creation time — stale. */
function makeStaleConfig() {
  return { session: { store: "sessions.json" }, _stale: true } as never;
}

function makeAccount(id = "acc-1") {
  return { accountId: id, config: {} } as never;
}

function makeRoute(agentId = "secondary") {
  return {
    agentId,
    accountId: "acc-1",
    sessionKey: `agent:${agentId}:line:user123`,
    mainSessionKey: `agent:${agentId}:line:user123`,
  };
}

function makeTextMessageEvent(text = "hello"): MessageEvent {
  return {
    type: "message",
    timestamp: 1700000000000,
    source: { type: "user", userId: "user123" },
    replyToken: "reply-token-1",
    message: { type: "text", id: "msg-1", text },
    mode: "active",
    webhookEventId: "evt-1",
    deliveryContext: { isRedelivery: false },
  } as never;
}

function makePostbackEvent(): PostbackEvent {
  return {
    type: "postback",
    timestamp: 1700000000000,
    source: { type: "user", userId: "user123" },
    replyToken: "reply-token-2",
    postback: { data: "action=confirm" },
    mode: "active",
    webhookEventId: "evt-2",
    deliveryContext: { isRedelivery: false },
  } as never;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("LINE bot-message-context routing uses fresh config", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mocks.shouldLogVerbose.mockReturnValue(false);
    mocks.resolveStorePath.mockReturnValue("/tmp/sessions.json");
    mocks.readSessionUpdatedAt.mockReturnValue(undefined);
    mocks.formatInboundEnvelope.mockReturnValue("envelope-body");
    mocks.resolveEnvelopeFormatOptions.mockReturnValue({});
    mocks.finalizeInboundContext.mockImplementation((input) => input);
    mocks.recordSessionMetaFromInbound.mockResolvedValue(undefined);
    mocks.updateLastRoute.mockResolvedValue(undefined);
    mocks.loadConfig.mockReturnValue(makeFreshConfig());
    mocks.resolveAgentRoute.mockReturnValue(makeRoute());
  });

  describe("buildLineMessageContext", () => {
    it("calls resolveAgentRoute with fresh config from loadConfig(), not the stale cfg param", async () => {
      const freshCfg = makeFreshConfig();
      const staleCfg = makeStaleConfig();
      mocks.loadConfig.mockReturnValue(freshCfg);

      const { buildLineMessageContext } = await import("./bot-message-context.js");

      await buildLineMessageContext({
        event: makeTextMessageEvent(),
        allMedia: [],
        cfg: staleCfg,
        account: makeAccount(),
      });

      expect(mocks.resolveAgentRoute).toHaveBeenCalledOnce();
      const callArg = mocks.resolveAgentRoute.mock.calls[0][0];
      expect(callArg.cfg).toBe(freshCfg);
      expect(callArg.cfg).not.toBe(staleCfg);
    });

    it("passes channel and accountId to resolveAgentRoute", async () => {
      const { buildLineMessageContext } = await import("./bot-message-context.js");

      await buildLineMessageContext({
        event: makeTextMessageEvent(),
        allMedia: [],
        cfg: makeStaleConfig(),
        account: makeAccount("my-line-acct"),
      });

      const callArg = mocks.resolveAgentRoute.mock.calls[0][0];
      expect(callArg.channel).toBe("line");
      expect(callArg.accountId).toBe("my-line-acct");
    });

    it("uses the stale cfg for non-routing operations (storePath, envelope)", async () => {
      const staleCfg = makeStaleConfig();
      const { buildLineMessageContext } = await import("./bot-message-context.js");

      await buildLineMessageContext({
        event: makeTextMessageEvent(),
        allMedia: [],
        cfg: staleCfg,
        account: makeAccount(),
      });

      // resolveEnvelopeFormatOptions should receive the original cfg (not loadConfig)
      expect(mocks.resolveEnvelopeFormatOptions).toHaveBeenCalledWith(staleCfg);
    });
  });

  describe("buildLinePostbackContext", () => {
    it("calls resolveAgentRoute with fresh config from loadConfig(), not the stale cfg param", async () => {
      const freshCfg = makeFreshConfig();
      const staleCfg = makeStaleConfig();
      mocks.loadConfig.mockReturnValue(freshCfg);

      const { buildLinePostbackContext } = await import("./bot-message-context.js");

      const result = await buildLinePostbackContext({
        event: makePostbackEvent(),
        cfg: staleCfg,
        account: makeAccount(),
      });

      expect(result).not.toBeNull();
      expect(mocks.resolveAgentRoute).toHaveBeenCalledOnce();
      const callArg = mocks.resolveAgentRoute.mock.calls[0][0];
      expect(callArg.cfg).toBe(freshCfg);
      expect(callArg.cfg).not.toBe(staleCfg);
    });

    it("passes channel and accountId to resolveAgentRoute", async () => {
      const { buildLinePostbackContext } = await import("./bot-message-context.js");

      const result = await buildLinePostbackContext({
        event: makePostbackEvent(),
        cfg: makeStaleConfig(),
        account: makeAccount("my-line-acct"),
      });

      expect(result).not.toBeNull();
      const callArg = mocks.resolveAgentRoute.mock.calls[0][0];
      expect(callArg.channel).toBe("line");
      expect(callArg.accountId).toBe("my-line-acct");
    });
  });
});
