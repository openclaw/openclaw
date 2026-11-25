import path from "node:path";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { rootDir } from "./agent-runner.misc.runreplyagent.test-support.js";
import { createTestQueuedFollowupRun } from "./agent-runner.test-fixtures.js";
import { createMockTypingController, createReplyParams } from "./test-helpers.js";

type RunReplyAgent = typeof import("./agent-runner-run.js").runReplyAgent;
type ReplyParams = Parameters<RunReplyAgent>[0];

export type BaseRunOptions = {
  context?: Partial<ReplyParams["sessionCtx"]>;
  followup?: Partial<Omit<Parameters<typeof createTestQueuedFollowupRun>[0], "run">>;
  run?: Parameters<typeof createTestQueuedFollowupRun>[0]["run"];
  reply?: Partial<Omit<ReplyParams, "followupRun" | "resolvedQueue" | "sessionCtx" | "typing">>;
};

export function createBaseRun(options: BaseRunOptions = {}) {
  const sessionKey = options.run?.sessionKey ?? options.reply?.sessionKey ?? "main";
  const typing = createMockTypingController();
  const sessionCtx: ReplyParams["sessionCtx"] = {
    ...(options.context ?? {
      Provider: "whatsapp",
      OriginatingTo: "+15550001111",
      AccountId: "primary",
      MessageSid: "msg",
    }),
  };
  const resolvedQueue: ReplyParams["resolvedQueue"] = { mode: "interrupt" };
  const followupRun = createTestQueuedFollowupRun({
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    ...options.followup,
    run: {
      sessionId: "session",
      sessionKey,
      messageProvider: options.run?.messageProvider ?? "whatsapp",
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
  const replyParams = createReplyParams(followupRun, {
    commandBody: "hello",
    queueKey: sessionKey,
    resolvedQueue,
    typing,
    sessionCtx,
    defaultModel: "anthropic/claude-opus-4-6",
    typingMode: "instant",
    ...options.reply,
  });
  return {
    typing,
    sessionCtx,
    resolvedQueue,
    followupRun,
    run: async () => {
      const { runReplyAgent } = await import("./agent-runner-run.js");
      setRuntimeConfigSnapshot(followupRun.run.config, followupRun.run.config);
      return runReplyAgent(replyParams);
    },
  };
}
