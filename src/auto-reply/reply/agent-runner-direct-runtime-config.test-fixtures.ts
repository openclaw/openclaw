import type { TemplateContext } from "../templating.js";
import type { runReplyAgent } from "./agent-runner-run.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";
import type { QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

export const staleCfg = {
  runtimeFresh: false,
  skills: {
    entries: {
      whisper: {
        apiKey: { source: "env" as const, provider: "default", id: "OPENAI_API_KEY" },
      },
    },
  },
};
export const directSessionKey = "agent:main:telegram:default:direct:test";

function createTelegramSessionCtx(): TemplateContext {
  return {
    Provider: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "12345",
    AccountId: "default",
    ChatType: "dm",
    MessageSid: "msg-1",
  } as unknown as TemplateContext;
}

export function createDirectRuntimeReplyParams({
  shouldFollowup = false,
  isActive = false,
  queueMode = "interrupt",
}: {
  shouldFollowup?: boolean;
  isActive?: boolean;
  queueMode?: QueueSettings["mode"];
} = {}) {
  const sessionKey = directSessionKey;
  const followupRun = createTestFollowupRun({
    sessionId: "session-1",
    sessionKey,
    messageProvider: "telegram",
    config: staleCfg,
    provider: "openai",
    model: "gpt-5.4",
  });
  followupRun.originatingChannel = "telegram";
  followupRun.originatingTo = "12345";
  const resolvedQueue = { mode: queueMode } as QueueSettings;
  const replyParams: Parameters<typeof runReplyAgent>[0] = {
    commandBody: "hello",
    followupRun,
    queueKey: sessionKey,
    resolvedQueue,
    shouldSteer: false,
    shouldFollowup,
    isActive,
    typing: createMockTypingController(),
    sessionCtx: createTelegramSessionCtx(),
    defaultModel: "openai/gpt-5.4",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
  };

  return { followupRun, resolvedQueue, replyParams };
}
