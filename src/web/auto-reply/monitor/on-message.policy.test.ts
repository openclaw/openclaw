import { describe, expect, it, vi, beforeEach } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { buildMentionConfig } from "../mentions.js";
import { createEchoTracker } from "./echo.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  maybeBroadcastMessage: vi.fn(async () => false),
  processMessage: vi.fn(async () => true),
}));

vi.mock("../../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => mocks.loadConfig(),
  };
});

vi.mock("./broadcast.js", () => ({
  maybeBroadcastMessage: (...args: unknown[]) => mocks.maybeBroadcastMessage(...args),
}));

vi.mock("./process-message.js", () => ({
  processMessage: (...args: unknown[]) => mocks.processMessage(...args),
}));

const { createWebOnMessageHandler } = await import("./on-message.js");

function makeCfg(): OpenClawConfig {
  return {
    channels: {
      whatsapp: {
        allowFrom: ["*"],
      },
    },
    session: {
      store: "/tmp/openclaw-test-sessions.json",
    },
  };
}

function buildDirectMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg-1",
    from: "+15550001111",
    conversationId: "+15550001111",
    to: "+15550002222",
    accountId: "default",
    body: "hello",
    chatType: "direct",
    chatId: "direct:+15550001111",
    senderE164: "+15550001111",
    senderName: "Alice",
    reply: vi.fn(async () => undefined),
    sendComposing: vi.fn(async () => undefined),
    sendMedia: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createHandler(cfg: OpenClawConfig) {
  mocks.loadConfig.mockReturnValue(cfg);
  return createWebOnMessageHandler({
    cfg,
    verbose: false,
    connectionId: "test-conn",
    maxMediaBytes: 1024,
    groupHistoryLimit: 5,
    groupHistories: new Map(),
    groupMemberNames: new Map(),
    echoTracker: createEchoTracker({ maxItems: 10 }),
    backgroundTasks: new Set(),
    replyResolver: vi.fn() as never,
    replyLogger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as Parameters<typeof createWebOnMessageHandler>[0]["replyLogger"],
    baseMentionConfig: buildMentionConfig(cfg),
    account: {},
  });
}

describe("createWebOnMessageHandler inbound policy", () => {
  beforeEach(() => {
    mocks.loadConfig.mockReset();
    mocks.maybeBroadcastMessage.mockClear();
    mocks.processMessage.mockClear();
    mocks.maybeBroadcastMessage.mockResolvedValue(false);
    mocks.processMessage.mockResolvedValue(true);
  });

  it("skips broadcast and dispatch when root whatsapp gate is paused_silent", async () => {
    const cfg: OpenClawConfig = {
      ...makeCfg(),
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          gate: {
            mode: "paused_silent",
          },
        },
      },
    };
    const handler = createHandler(cfg);
    const msg = buildDirectMessage();

    await handler(msg as never);

    expect(msg.reply).not.toHaveBeenCalled();
    expect(mocks.maybeBroadcastMessage).not.toHaveBeenCalled();
    expect(mocks.processMessage).not.toHaveBeenCalled();
  });

  it("sends canned reply and skips dispatch when root whatsapp gate is paused_autoreply", async () => {
    const cfg: OpenClawConfig = {
      ...makeCfg(),
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          gate: {
            mode: "paused_autoreply",
            replyText: "We are currently offline.",
          },
        },
      },
    };
    const handler = createHandler(cfg);
    const msg = buildDirectMessage();

    await handler(msg as never);

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(msg.reply).toHaveBeenCalledWith("We are currently offline.");
    expect(mocks.maybeBroadcastMessage).not.toHaveBeenCalled();
    expect(mocks.processMessage).not.toHaveBeenCalled();
  });

  it("lets account-level gate override the root whatsapp gate", async () => {
    const cfg: OpenClawConfig = {
      ...makeCfg(),
      channels: {
        whatsapp: {
          allowFrom: ["*"],
          gate: {
            mode: "paused_silent",
          },
          accounts: {
            work: {
              gate: {
                mode: "active",
              },
            },
          },
        },
      },
    };
    const handler = createHandler(cfg);
    const msg = buildDirectMessage({ accountId: "work" });

    await handler(msg as never);

    expect(mocks.maybeBroadcastMessage).toHaveBeenCalledTimes(1);
    expect(mocks.processMessage).toHaveBeenCalledTimes(1);
  });
});
