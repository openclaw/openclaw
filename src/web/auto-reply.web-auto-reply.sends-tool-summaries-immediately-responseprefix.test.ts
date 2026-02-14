import { describe, expect, it, vi } from "vitest";
import "./test-helpers.js";
import { monitorWebChannel } from "./auto-reply.js";
import {
  installWebAutoReplyTestHomeHooks,
  installWebAutoReplyUnitTestHooks,
  resetLoadConfigMock,
  setLoadConfigMock,
} from "./auto-reply.test-harness.js";

installWebAutoReplyTestHomeHooks();

describe("web auto-reply", () => {
  installWebAutoReplyUnitTestHooks();

  it("skips tool summaries and sends final reply with responsePrefix", async () => {
    setLoadConfigMock(() => ({
      channels: { whatsapp: { allowFrom: ["*"] } },
      messages: {
        messagePrefix: undefined,
        responsePrefix: "🦞",
      },
    }));

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "final" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
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

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "hello" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hi",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    // Check that resolver received the message with identity-based prefix
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

    let capturedOnMessage:
      | ((msg: import("./inbound.js").WebInboundMessage) => Promise<void>)
      | undefined;
    const reply = vi.fn();
    const listenerFactory = async (opts: {
      onMessage: (msg: import("./inbound.js").WebInboundMessage) => Promise<void>;
    }) => {
      capturedOnMessage = opts.onMessage;
      return { close: vi.fn() };
    };

    const resolver = vi.fn().mockResolvedValue({ text: "hello there" });

    await monitorWebChannel(false, listenerFactory, false, resolver);
    expect(capturedOnMessage).toBeDefined();

    await capturedOnMessage?.({
      body: "hi",
      from: "+1555",
      to: "+2666",
      id: "msg1",
      sendComposing: vi.fn(),
      reply,
      sendMedia: vi.fn(),
    });

    // No implicit responsePrefix.
    expect(reply).toHaveBeenCalledWith("hello there");
    resetLoadConfigMock();
  });
});
