import path from "node:path";
import { rootDir } from "./agent-runner.misc.runreplyagent.test-support.js";
import {
  createTestQueueSettings,
  createTestQueuedFollowupRun,
  createTestTemplateContext,
} from "./agent-runner.test-fixtures.js";
import { createMockTypingController } from "./test-helpers.js";

type RunReplyAgent = typeof import("./agent-runner.js").runReplyAgent;

export type BaseRunOptions = {
  context?: Parameters<typeof createTestTemplateContext>[0];
  followup?: Partial<Omit<Parameters<typeof createTestQueuedFollowupRun>[0], "run">>;
  run?: Parameters<typeof createTestQueuedFollowupRun>[0]["run"];
  reply?: Partial<
    Omit<Parameters<RunReplyAgent>[0], "followupRun" | "resolvedQueue" | "sessionCtx" | "typing">
  >;
};

export function createBaseRun(options: BaseRunOptions = {}) {
  const sessionKey = options.run?.sessionKey ?? "main";
  const messageProvider = options.run?.messageProvider ?? "whatsapp";
  const typing = createMockTypingController();
  const sessionCtx = createTestTemplateContext(
    options.context ?? {
      Provider: "whatsapp",
      OriginatingTo: "+15550001111",
      AccountId: "primary",
      MessageSid: "msg",
    },
  );
  const resolvedQueue = createTestQueueSettings({ mode: "interrupt" });
  const followupRun = createTestQueuedFollowupRun({
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    ...options.followup,
    run: {
      sessionId: "session",
      sessionKey,
      messageProvider,
      sessionFile: path.join(rootDir, "session.jsonl"),
      workspaceDir: rootDir,
      config: {},
      skillsSnapshot: {},
      provider: "anthropic",
      model: "claude",
      thinkingCatalog: [
        { provider: "anthropic", id: "claude", input: ["text"] },
        { provider: "claude-cli", id: "opus-4.5", input: ["text", "image"] },
        { provider: "anthropic", id: "claude-opus-4-7", input: ["text", "image"] },
        { provider: "google", id: "gemini-2.5-pro", input: ["text", "image"] },
        { provider: "google-gemini-cli", id: "gemini-3", input: ["text", "image"] },
        {
          provider: "amazon-bedrock",
          id: "us.anthropic.claude-sonnet-4-6",
          input: ["text", "image"],
        },
      ],
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      ...options.run,
    },
  });
  const replyParams = {
    commandBody: "hello",
    followupRun,
    queueKey: "main",
    resolvedQueue,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    typing,
    sessionCtx,
    defaultModel: "anthropic/claude-opus-4-6",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
    ...options.reply,
  } satisfies Parameters<RunReplyAgent>[0];
  return {
    typing,
    sessionCtx,
    resolvedQueue,
    followupRun,
    run: async () => {
      const { runReplyAgent } = await import("./agent-runner.js");
      return runReplyAgent(replyParams);
    },
  };
}
