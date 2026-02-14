import "./test-helpers.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

let monitorWebChannel: typeof import("./auto-reply.js").monitorWebChannel;
let HEARTBEAT_TOKEN: typeof import("./auto-reply.js").HEARTBEAT_TOKEN;
let getReplyFromConfig: typeof import("../auto-reply/reply.js").getReplyFromConfig;
let runEmbeddedPiAgent: typeof import("../agents/pi-embedded.js").runEmbeddedPiAgent;
let lastRouteSpy: { mockRestore: () => void } | undefined;

beforeAll(async () => {
  ({ monitorWebChannel, HEARTBEAT_TOKEN } = await import("./auto-reply.js"));
  ({ getReplyFromConfig } = await import("../auto-reply/reply.js"));
  ({ runEmbeddedPiAgent } = await import("../agents/pi-embedded.js"));
  const lastRoute = await import("./auto-reply/monitor/last-route.js");
  lastRouteSpy = vi
    .spyOn(lastRoute, "updateLastRouteInBackground")
    .mockImplementation(() => undefined);
});

afterAll(() => {
  lastRouteSpy?.mockRestore();
  lastRouteSpy = undefined;
});

function createCapturedListener() {
  let capturedOnMessage:
    | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
    | undefined;
  const listenerFactory = async (opts: {
    onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
  }) => {
    capturedOnMessage = opts.onMessage;
    return { close: vi.fn() };
  };
  return { listenerFactory, getCapturedOnMessage: () => capturedOnMessage };
}

describe("web auto-reply", () => {
  installWebAutoReplyUnitTestHooks();

  it("prefixes body with same-phone marker when from === to", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: "[same-phone]",
        responsePrefix: undefined,
      },
    }));

    const { listenerFactory, getCapturedOnMessage } = createCapturedListener();
    const resolver = vi.fn().mockResolvedValue({ text: "reply" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(getCapturedOnMessage()).toBeDefined();

    await getCapturedOnMessage()?.({
      body: "hello",
      from: "+1555",
      to: "+1555",
      id: "msg1",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    const callArg = resolver.mock.calls[0]?.[0] as { Body?: string };
    expect(callArg?.Body).toBeDefined();
    expect(callArg?.Body).toContain("[WhatsApp +1555");
    expect(callArg?.Body).toContain("[same-phone] hello");
    resetLoadConfigMock();
  });

  it("does not prefix body when from !== to", async () => {
    const { listenerFactory, getCapturedOnMessage } = createCapturedListener();
    const resolver = vi.fn().mockResolvedValue({ text: "reply" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(getCapturedOnMessage()).toBeDefined();

    await getCapturedOnMessage()?.({
      body: "hello",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    const callArg = resolver.mock.calls[0]?.[0] as { Body?: string };
    expect(callArg?.Body).toContain("[WhatsApp +1555");
    expect(callArg?.Body).toContain("hello");
  });

  it("forwards reply-to context to resolver", async () => {
    const { listenerFactory, getCapturedOnMessage } = createCapturedListener();
    const resolver = vi.fn().mockResolvedValue({ text: "reply" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(getCapturedOnMessage()).toBeDefined();

    await getCapturedOnMessage()?.({
      body: "hello",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      replyToId: "q1",
      replyToBody: "original",
      replyToSender: "+1999",
      sendComposing: vi.fn(),
      reply: vi.fn(),
      sendMedia: vi.fn(),
    });

    const callArg = resolver.mock.calls[0]?.[0] as {
      ReplyToId?: string;
      ReplyToBody?: string;
      ReplyToSender?: string;
      Body?: string;
    };
    expect(callArg.ReplyToId).toBe("q1");
    expect(callArg.ReplyToBody).toBe("original");
    expect(callArg.ReplyToSender).toBe("+1999");
    expect(callArg.Body).toContain("[Replying to +1999 id:q1]");
    expect(callArg.Body).toContain("original");
  });

  it("applies responsePrefix to regular replies", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    const { listenerFactory, getCapturedOnMessage } = createCapturedListener();
    const reply = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "hello there" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(getCapturedOnMessage()).toBeDefined();

    await getCapturedOnMessage()?.({
      body: "hi",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    expect(reply).toHaveBeenCalledWith("🦞 hello there");
    resetLoadConfigMock();
  });

  it("applies channel responsePrefix override to replies", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"], responsePrefix: "[WA]" } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "[Global]",
      },
    }));

    const { listenerFactory, getCapturedOnMessage } = createCapturedListener();
    const reply = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "hello there" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(getCapturedOnMessage()).toBeDefined();

    await getCapturedOnMessage()?.({
      body: "hi",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    expect(reply).toHaveBeenCalledWith("[WA] hello there");
    resetLoadConfigMock();
  });

  it("defaults responsePrefix for self-chat replies when unset", async () => {
    setLoadConfigMock(() => ({
      agents: {
        list: [
          {
            id: "main",
            default: true,
            identity: { name: "Mainbot", emoji: "🦞", theme: "space lobster" },
          },
        ],
      },
      channels: { whatsapp: { allowFrom: ["+1555"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: undefined,
      },
    }));

    const { listenerFactory, getCapturedOnMessage } = createCapturedListener();
    const reply = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "hello there" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(getCapturedOnMessage()).toBeDefined();

    await getCapturedOnMessage()?.({
      body: "hi",
      from: "+1555",
      to: "+1555",
      selfE164: "+1555",
      chatType: "direct",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    expect(reply).toHaveBeenCalledWith("[Mainbot] hello there");
    resetLoadConfigMock();
  });

  it("does not deliver HEARTBEAT_OK responses", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    const { listenerFactory, getCapturedOnMessage } = createCapturedListener();
    const reply = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: HEARTBEAT_TOKEN });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(getCapturedOnMessage()).toBeDefined();

    await getCapturedOnMessage()?.({
      body: "test",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    expect(reply).not.toHaveBeenCalled();
    resetLoadConfigMock();
  });

  it("does not double-prefix if responsePrefix already present", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    const { listenerFactory, getCapturedOnMessage } = createCapturedListener();
    const reply = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "🦞 already prefixed" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(getCapturedOnMessage()).toBeDefined();

    await getCapturedOnMessage()?.({
      body: "test",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    expect(reply).toHaveBeenCalledWith("🦞 already prefixed");
    resetLoadConfigMock();
  });

  it("skips tool summaries and sends final reply with responsePrefix", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    const { listenerFactory, getCapturedOnMessage } = createCapturedListener();
    const reply = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "final" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(getCapturedOnMessage()).toBeDefined();

    await getCapturedOnMessage()?.({
      body: "hi",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    const replies = reply.mock.calls.map((call) => call[0]);
    expect(replies).toEqual(["🦞 final"]);
    resetLoadConfigMock();
  });

  it("uses identity.name for messagePrefix when set", async () => {
    setLoadConfigMock(() => ({
      agents: {
        list: [
          {
            id: "main",
            default: true,
            identity: { name: "Mainbot", emoji: "🦞", theme: "space lobster" },
          },
          {
            id: "rich",
            identity: { name: "Richbot", emoji: "🦁", theme: "lion bot" },
          },
        ],
      },
      bindings: [
        {
          agentId: "rich",
          match: {
            channel: "whatsapp",
            peer: { kind: "direct", id: "+1555" },
          },
        },
      ],
    }));

    const { listenerFactory, getCapturedOnMessage } = createCapturedListener();
    const reply = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "hello" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(getCapturedOnMessage()).toBeDefined();

    await getCapturedOnMessage()?.({
      body: "hi",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    expect(resolver).toHaveBeenCalled();
    const resolverArg = resolver.mock.calls[0][0];
    expect(resolverArg.Body).toContain("[Richbot]");
    expect(resolverArg.Body).not.toContain("[openclaw]");
    resetLoadConfigMock();
  });

  it("does not derive responsePrefix from identity.name when unset", async () => {
    setLoadConfigMock(() => ({
      agents: {
        list: [
          {
            id: "main",
            default: true,
            identity: { name: "Mainbot", emoji: "🦞", theme: "space lobster" },
          },
          {
            id: "rich",
            identity: { name: "Richbot", emoji: "🦁", theme: "lion bot" },
          },
        ],
      },
      bindings: [
        {
          agentId: "rich",
          match: {
            channel: "whatsapp",
            peer: { kind: "direct", id: "+1555" },
          },
        },
      ],
    }));

    const { listenerFactory, getCapturedOnMessage } = createCapturedListener();
    const reply = vi.fn();
    const resolver = vi.fn().mockResolvedValue({ text: "hello there" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(getCapturedOnMessage()).toBeDefined();

    await getCapturedOnMessage()?.({
      body: "hi",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    expect(reply).toHaveBeenCalledWith("hello there");
    resetLoadConfigMock();
  });
});

describe("partial reply gating", () => {
  installWebAutoReplyUnitTestHooks();

  it("does not send partial replies for WhatsApp provider", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn().mockResolvedValue(undefined);
    const sendMedia = vi.fn().mockResolvedValue(undefined);

    const replyResolver = vi.fn().mockResolvedValue({ text: "final reply" });

    const mockConfig: OpenClawConfig = {
      channels: { whatsapp: { allowFrom: ["*"] } },
    };

    setLoadConfigMock(mockConfig);

    await monitorWebChannel(
      false,
      async ({ onMessage }) => {
        await onMessage({
          id: "m1",
          from: "+1000",
          conversationId: "+1000",
          to: "+2000",
          body: "hello",
          timestamp: Date.now(),
          chatType: "direct",
          chatId: "direct:+1000",
          sendComposing,
          reply,
          sendMedia,
        });
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
      false,
      replyResolver,
    );

    resetLoadConfigMock();

    expect(replyResolver).toHaveBeenCalledTimes(1);
    const resolverOptions = replyResolver.mock.calls[0]?.[1] ?? {};
    expect("onPartialReply" in resolverOptions).toBe(false);
    expect(reply).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith("final reply");
  });

  it("falls back from empty senderJid to senderE164 for SenderId", async () => {
    const reply = vi.fn().mockResolvedValue(undefined);
    const sendComposing = vi.fn().mockResolvedValue(undefined);
    const sendMedia = vi.fn().mockResolvedValue(undefined);

    const replyResolver = vi.fn().mockResolvedValue({ text: "final reply" });

    const mockConfig: OpenClawConfig = {
      channels: {
        whatsapp: {
          allowFrom: ["*"],
        },
      },
    };

    setLoadConfigMock(mockConfig);

    await monitorWebChannel(
      false,
      async ({ onMessage }) => {
        await onMessage({
          id: "m1",
          from: "+1000",
          conversationId: "+1000",
          to: "+2000",
          body: "hello",
          timestamp: Date.now(),
          chatType: "direct",
          chatId: "direct:+1000",
          senderJid: "",
          senderE164: "+1000",
          sendComposing,
          reply,
          sendMedia,
        });
        return { close: vi.fn().mockResolvedValue(undefined) };
      },
      false,
      replyResolver,
    );

    resetLoadConfigMock();

    expect(replyResolver).toHaveBeenCalledTimes(1);
    const ctx = replyResolver.mock.calls[0]?.[0] ?? {};
    expect(ctx.SenderE164).toBe("+1000");
    expect(ctx.SenderId).toBe("+1000");
  });

  it("defaults to self-only when no config is present", async () => {
    vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {
        durationMs: 1,
        agentMeta: { sessionId: "s", provider: "p", model: "m" },
      },
    });

    const blocked = await getReplyFromConfig(
      {
        Body: "hi",
        From: "whatsapp:+999",
        To: "whatsapp:+123",
      },
      undefined,
      {},
    );
    expect(blocked).toBeUndefined();
    expect(runEmbeddedPiAgent).not.toHaveBeenCalled();

    const allowed = await getReplyFromConfig(
      {
        Body: "hi",
        From: "whatsapp:+123",
        To: "whatsapp:+123",
      },
      undefined,
      {},
    );
    expect(allowed).toMatchObject({ text: "ok", audioAsVoice: false });
    expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
  });
});
