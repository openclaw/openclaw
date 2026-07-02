// sessions_list tool tests cover session metadata projection, visibility
// helpers, and numeric argument validation.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionsListTool } from "./sessions-list-tool.js";

const mocks = vi.hoisted(() => ({
  gatewayCall: vi.fn(),
  createAgentToAgentPolicy: vi.fn(() => ({})),
  createSessionVisibilityGuard: vi.fn(async () => ({
    check: () => ({ allowed: true }),
  })),
  resolveEffectiveSessionToolsVisibility: vi.fn(() => "all"),
  resolveSandboxedSessionToolContext: vi.fn(() => ({
    mainKey: "main",
    alias: "main",
    requesterInternalKey: undefined,
    restrictToSpawned: false,
  })),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => mocks.gatewayCall(opts),
}));

vi.mock("./sessions-helpers.js", async (importActual) => {
  const actual = await importActual<typeof import("./sessions-helpers.js")>();
  return {
    ...actual,
    createAgentToAgentPolicy: () => mocks.createAgentToAgentPolicy(),
    createSessionVisibilityGuard: async () => await mocks.createSessionVisibilityGuard(),
    resolveEffectiveSessionToolsVisibility: () => mocks.resolveEffectiveSessionToolsVisibility(),
    resolveSandboxedSessionToolContext: () => mocks.resolveSandboxedSessionToolContext(),
  };
});

type SessionsListDetails = {
  sessions?: Array<{
    deliveryContext?: {
      accountId?: string;
      channel?: string;
      threadId?: string | number;
      to?: string;
    };
    elevatedLevel?: string;
    effectiveFastMode?: boolean | "auto";
    effectiveFastModeSource?: "session" | "agent" | "config" | "default";
    fastMode?: boolean | "auto";
    fastAutoOnSeconds?: number;
    reasoningLevel?: string;
    responseUsage?: string;
    thinkingLevel?: string;
    verboseLevel?: string;
    messages?: unknown[];
  }>;
};

function extractVisibleText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : undefined,
    )
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function getSessionsListDetails(result: { details?: unknown }): SessionsListDetails {
  return result.details as SessionsListDetails;
}

describe("sessions-list-tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAgentToAgentPolicy.mockReturnValue({});
    mocks.createSessionVisibilityGuard.mockResolvedValue({
      check: () => ({ allowed: true }),
    });
    mocks.resolveEffectiveSessionToolsVisibility.mockReturnValue("all");
    mocks.resolveSandboxedSessionToolContext.mockReturnValue({
      mainKey: "main",
      alias: "main",
      requesterInternalKey: undefined,
      restrictToSpawned: false,
    });
  });

  it("keeps deliveryContext.threadId in sessions_list results", async () => {
    // Thread/topic ids are required for channel-specific follow-up routing, so
    // list results must preserve both string and numeric variants.
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:dashboard:child",
              kind: "direct",
              sessionId: "sess-dashboard-child",
              deliveryContext: {
                channel: "discord",
                to: "discord:child",
                accountId: "acct-1",
                threadId: "thread-1",
              },
            },
            {
              key: "agent:main:telegram:topic",
              kind: "direct",
              sessionId: "sess-telegram-topic",
              deliveryContext: {
                channel: "telegram",
                to: "telegram:topic",
                accountId: "acct-2",
                threadId: 271,
              },
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-1", {});
    const details = getSessionsListDetails(result);

    expect(details.sessions?.[0]?.deliveryContext).toEqual({
      channel: "discord",
      to: "discord:child",
      accountId: "acct-1",
      threadId: "thread-1",
    });
    expect(Object.hasOwn(details.sessions?.[0] ?? {}, "effectiveFastMode")).toBe(false);
    expect(details.sessions?.[1]?.deliveryContext).toEqual({
      channel: "telegram",
      to: "telegram:topic",
      accountId: "acct-2",
      threadId: 271,
    });
  });

  it("keeps numeric deliveryContext.threadId in sessions_list results", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:telegram:group:-100123:topic:99",
              kind: "group",
              sessionId: "sess-telegram-topic",
              deliveryContext: {
                channel: "telegram",
                to: "-100123",
                accountId: "acct-1",
                threadId: 99,
              },
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-2", {});
    const details = getSessionsListDetails(result);

    expect(details.sessions?.[0]?.deliveryContext).toEqual({
      channel: "telegram",
      to: "-100123",
      accountId: "acct-1",
      threadId: 99,
    });
  });

  it("keeps live session setting metadata in sessions_list results", async () => {
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "main",
              kind: "direct",
              sessionId: "sess-main",
              thinkingLevel: "high",
              fastMode: "auto",
              effectiveFastMode: "auto",
              effectiveFastModeSource: "config",
              fastAutoOnSeconds: 30,
              verboseLevel: "on",
              reasoningLevel: "deep",
              elevatedLevel: "on",
              responseUsage: "full",
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-3", {});
    const details = getSessionsListDetails(result);

    const session = details.sessions?.[0];
    expect(session?.thinkingLevel).toBe("high");
    expect(session?.fastMode).toBe("auto");
    expect(session?.effectiveFastMode).toBe("auto");
    expect(session?.effectiveFastModeSource).toBe("config");
    expect(session?.fastAutoOnSeconds).toBe(30);
    expect(session?.verboseLevel).toBe("on");
    expect(session?.reasoningLevel).toBe("deep");
    expect(session?.elevatedLevel).toBe("on");
    expect(session?.responseUsage).toBe("full");
  });

  it("keeps bounded standalone delivery mirrors in hydrated sessions_list messages", async () => {
    const deliveredText = "Redacted invoice summary delivered.";
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:whatsapp:group:120363425559039020@g.us",
              kind: "group",
              sessionId: "sess-wa",
            },
          ],
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Please send the redacted invoice summary." }],
            },
            {
              role: "assistant",
              provider: "openclaw",
              model: "delivery-mirror",
              content: [{ type: "text", text: deliveredText }],
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-list-wa-bounded", { messageLimit: 2 });
    const details = getSessionsListDetails(result);
    const messages = details.sessions?.[0]?.messages ?? [];

    expect(messages.map(extractVisibleText)).toEqual([
      "Please send the redacted invoice summary.",
      deliveredText,
    ]);
    expect(messages).toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "delivery-mirror" }),
    );
  });

  it("keeps repeated identical standalone delivery mirrors in hydrated sessions_list messages", async () => {
    const repeatedText = "Done.";
    mocks.gatewayCall.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [
            {
              key: "agent:main:whatsapp:group:120363425559039020@g.us",
              kind: "group",
              sessionId: "sess-wa-repeated",
            },
          ],
        };
      }
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Send the first redacted update." }],
            },
            {
              role: "assistant",
              provider: "openclaw",
              model: "delivery-mirror",
              content: [{ type: "text", text: repeatedText }],
            },
            {
              role: "user",
              content: [{ type: "text", text: "Send the second redacted update." }],
            },
            {
              role: "assistant",
              provider: "openclaw",
              model: "delivery-mirror",
              content: [{ type: "text", text: repeatedText }],
            },
            {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "call-message-repeated",
                  name: "message",
                  arguments: {
                    action: "send",
                    message: repeatedText,
                  },
                },
              ],
            },
            {
              role: "toolResult",
              toolName: "message",
              toolCallId: "call-message-repeated",
              content: { ok: true, messageId: "wamid.2", chatId: "120363425559039020@g.us" },
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "Sent the update in WhatsApp." }],
            },
          ],
        };
      }
      return {};
    });
    const tool = createSessionsListTool({ config: {} as never });

    const result = await tool.execute("call-list-wa-repeated", { messageLimit: 7 });
    const details = getSessionsListDetails(result);
    const messages = details.sessions?.[0]?.messages ?? [];

    expect(messages.map(extractVisibleText)).toEqual([
      "Send the first redacted update.",
      repeatedText,
      "Send the second redacted update.",
      repeatedText,
    ]);
    expect(
      messages.filter(
        (message) =>
          message &&
          typeof message === "object" &&
          (message as { provider?: unknown }).provider === "openclaw" &&
          (message as { model?: unknown }).model === "delivery-mirror",
      ),
    ).toHaveLength(1);
    expect(
      messages.filter(
        (message) =>
          message &&
          typeof message === "object" &&
          Boolean((message as { openclawMessageToolMirror?: unknown }).openclawMessageToolMirror),
      ),
    ).toHaveLength(1);
  });

  it.each([
    [{ limit: 1.5 }, "limit must be a positive integer"],
    [{ activeMinutes: 0 }, "activeMinutes must be a positive integer"],
    [{ messageLimit: 1.5 }, "messageLimit must be a non-negative integer"],
    [{ messageLimit: -1 }, "messageLimit must be a non-negative integer"],
  ])("rejects invalid numeric parameter %o", async (params, message) => {
    // Reject before gateway dispatch so malformed limits cannot reach session
    // store queries.
    const tool = createSessionsListTool({ config: {} as never });

    await expect(tool.execute("call-4", params)).rejects.toThrow(message);
    expect(mocks.gatewayCall).not.toHaveBeenCalled();
  });
});
