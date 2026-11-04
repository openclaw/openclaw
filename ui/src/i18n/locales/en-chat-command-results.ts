import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatCommandResults = {
  chat: {
    commandResults: {
      unknownCommand: "Unknown command: `{command}`. Type `/help` for available commands.",
      options: "Options: {options}.",
      connectionChanged: "Couldn’t finish the command. The connection changed; try again.",
      sessionUnavailable: "Couldn’t load session details. Check your connection and try again.",
      help: {
        availableCommands: "Available commands",
        agentCommand: "agent",
        openMenu: "Type `/` to open the command menu.",
      },
      compaction: {
        failed: "Couldn’t compact the conversation. Try again.",
        failedWithReason: "Couldn’t compact the conversation. Try again. {reason}",
        tokenSummary: " ({before} -> {after} tokens)",
        succeeded: "Context compacted",
        skipped: "Compaction skipped.",
        skippedWithReason: "Compaction skipped: {reason}",
      },
      model: {
        current: "**Current model:** {model}",
        available: "**Available:** {models}",
        more: " +{count} more",
        getFailed: "Couldn’t load model details. Try again. {error}",
        set: "Model set to {model}.",
        setFailed: "Couldn’t change the model. Try again. {error}",
      },
      thinking: {
        current: "Current thinking level: {level}.",
        getFailed: "Couldn’t load effort. Try again. {error}",
        reset: "Thinking level reset to default.",
        resetFailed: "Couldn’t reset effort. Try again. {error}",
        unrecognized: 'Unrecognized thinking level "{level}". Valid levels: {options}.',
        unsupported:
          'Unsupported thinking level "{level}" for this model. Valid levels: {options}.',
        set: "Thinking level set to {level}.",
        setFailed: "Couldn’t change effort. Try again. {error}",
      },
      verbose: {
        current: "Current verbose level: {level}.",
        getFailed: "Couldn’t load the verbose level. Try again. {error}",
        unrecognized: "Unrecognized verbose level “{level}”. Valid levels: off, on, full.",
        set: "Verbose mode set to {level}.",
        setFailed: "Couldn’t change verbose mode. Try again. {error}",
      },
      fast: {
        options: "on, off, auto ({seconds} sec), default, status",
        getFailed: "Couldn’t load fast mode. Try again. {error}",
        reset: "Fast mode reset to default.",
        resetFailed: "Couldn’t reset fast mode. Try again. {error}",
        unrecognized:
          "Unrecognized fast mode “{mode}”. Valid levels: on, off, auto, default, status.",
        setAuto: "Fast mode set to auto.",
        enabled: "Fast mode enabled.",
        disabled: "Fast mode disabled.",
        setFailed: "Couldn’t change fast mode. Try again. {error}",
      },
      usage: {
        noActiveThread: "No active session.",
        notAvailable: "n/a",
        title: "Session usage",
        inputTokens: "Input: {count} tokens",
        outputTokens: "Output: {count} tokens",
        totalTokens: "Total: {count} tokens",
        context: "Context: {percent} of {total}",
        promptBudget: "Prompt budget (last reply): {percent} of {total}",
        model: "Model: {model}",
        failed: "Couldn’t load usage. Try again. {error}",
      },
      agents: {
        none: "No agents yet. Create an agent in Agents.",
        title: "**Agents** ({count})",
        default: "default",
        runtime: " · runtime {runtime}",
        failed: "Failed to list agents: {error}",
      },
      steer: {
        timeout: "The active reply ended before your steering message was accepted.",
        failed: "Couldn’t steer the reply. Try again.",
        usage: "Usage: `/steer <message>`",
        succeeded: "Steered.",
        requestFailed: "Couldn’t steer the reply. Try again. {error}",
      },
      redirect: {
        timeout: "The active reply ended before your redirect message was accepted.",
        failed: "Couldn’t redirect the reply. Try again.",
        usage: "Usage: `/redirect <message>`",
        succeeded: "Redirected.",
        requestFailed: "Couldn’t redirect the reply. Try again. {error}",
      },
    },
  },
} satisfies TranslationMap;

export const registerChatCommandResultsEnglish = Object.assign(
  () => {
    const { fast, ...commands } = enChatCommandResults.chat.commandResults;
    Object.assign(en.chat.commandResults, commands);
    Object.assign(en.chat.commandResults.fast, fast);
  },
  { catalog: enChatCommandResults },
);
