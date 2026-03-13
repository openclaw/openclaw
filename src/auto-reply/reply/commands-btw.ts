import { runBtwSideQuestion } from "../../agents/btw.js";
import type { CommandHandler } from "./commands-types.js";

const BTW_USAGE = "Usage: /btw <side question>";

export const handleBtwCommand: CommandHandler = async (params) => {
  const match = params.command.commandBodyNormalized.match(/^\/btw(?:\s+(.*))?$/i);
  if (!match) {
    return null;
  }

  const question = match[1]?.trim() ?? "";
  if (!question) {
    return {
      shouldContinue: false,
      reply: { text: BTW_USAGE },
    };
  }

  if (!params.sessionEntry?.sessionId) {
    return {
      shouldContinue: false,
      reply: { text: "⚠️ /btw requires an active session with existing context." },
    };
  }

  if (!params.agentDir) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ /btw is unavailable because the active agent directory could not be resolved.",
      },
    };
  }

  try {
    const reply = await runBtwSideQuestion({
      cfg: params.cfg,
      agentDir: params.agentDir,
      provider: params.provider,
      model: params.model,
      question,
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      resolvedThinkLevel: params.resolvedThinkLevel,
      resolvedReasoningLevel: params.resolvedReasoningLevel,
      blockReplyChunking: params.blockReplyChunking,
      resolvedBlockStreamingBreak: params.resolvedBlockStreamingBreak,
      opts: params.opts,
      isNewSession: false,
    });
    return {
      shouldContinue: false,
      reply,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message.trim() : "";
    return {
      shouldContinue: false,
      reply: {
        text: `⚠️ /btw failed${message ? `: ${message}` : "."}`,
      },
    };
  }
};
