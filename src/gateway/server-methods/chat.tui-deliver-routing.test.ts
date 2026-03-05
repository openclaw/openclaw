import { describe, expect, it, vi } from "vitest";
import { validateChatSendParams } from "../protocol/index.js";
import { GATEWAY_CLIENT_MODES } from "../../utils/message-channel.js";

// This test covers a routing regression where TUI connections were treated as UI clients,
// causing `chat.send` to refuse inheriting deliverable routes on configured main sessions.
// See: https://github.com/openclaw/openclaw/issues/36088

describe("chat.send routing (tui --deliver)", () => {
  it("allows deliverable route inheritance for configured main sessions from CLI-mode clients", async () => {
    expect(validateChatSendParams({
      sessionKey: "agent:main:main",
      message: "hi",
      deliver: true,
      idempotencyKey: "idem",
    })).toBe(true);

    const respond = vi.fn();
    const context = {
      logGateway: { warn: vi.fn(), debug: vi.fn() },
      dedupe: new Map(),
      chatAbortControllers: new Map(),
      agentRunSeq: new Map(),
      broadcast: vi.fn(),
      nodeSendToSession: vi.fn(),
    } as any;

    const entry = {
      sessionId: "sess-1",
      deliveryContext: {
        channel: "whatsapp",
        to: "whatsapp:+8613800138000",
        accountId: "default",
      },
      lastChannel: "whatsapp",
      lastTo: "whatsapp:+8613800138000",
      lastAccountId: "default",
    };

    // Mock session store loader + dispatch to capture constructed MsgContext
    const dispatchInboundMessageMock = vi.fn(() => Promise.resolve(undefined));

    vi.doMock("../session-utils.js", async () => {
      const actual = await vi.importActual<any>("../session-utils.js");
      return {
        ...actual,
        loadSessionEntry: (_key: string) => ({ cfg: { session: { mainKey: "main" } }, entry, canonicalKey: "agent:main:main" }),
      };
    });
    vi.doMock("../../auto-reply/dispatch.js", async () => {
      const actual = await vi.importActual<any>("../../auto-reply/dispatch.js");
      return {
        ...actual,
        dispatchInboundMessage: (args: any) => dispatchInboundMessageMock(args),
      };
    });

    // Re-import handler after mocks
    const { chatHandlers: handlers } = await import("./chat.js");

    await (handlers as any)["chat.send"]({
      params: {
        sessionKey: "agent:main:main",
        message: "hi",
        deliver: true,
        idempotencyKey: "idem",
      },
      respond,
      context,
      client: {
        connect: {
          client: {
            mode: GATEWAY_CLIENT_MODES.CLI,
            id: "openclaw-tui",
          },
        },
      },
    });

    // Should have dispatched with originating route set to WhatsApp (not internal webchat).
    expect(dispatchInboundMessageMock).toHaveBeenCalled();
    const call = dispatchInboundMessageMock.mock.calls[0]?.[0];
    expect(call?.ctx).toEqual(
      expect.objectContaining({
        OriginatingChannel: "whatsapp",
        OriginatingTo: "whatsapp:+8613800138000",
        AccountId: "default",
      }),
    );
  });
});
