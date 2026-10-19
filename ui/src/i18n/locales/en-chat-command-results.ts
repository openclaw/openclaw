import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatCommandResults = {
  chat: {
    commandResults: {
      help: {
        availableCommands: "Available Commands",
        agentCommand: "agent",
        openMenu: "Type `/` to open the command menu.",
      },
      compaction: {
        failed: "Compaction failed.",
        failedWithReason: "Compaction failed: {reason}",
        tokenSummary: " ({before} -> {after} tokens)",
        succeeded: "Context compacted successfully",
        skipped: "Compaction skipped.",
        skippedWithReason: "Compaction skipped: {reason}",
      },
      model: {
        current: "**Current model:** {model}",
        available: "**Available:** {models}",
        more: " +{count} more",
        getFailed: "Failed to get model info: {error}",
        set: "Model set to {model}.",
        setFailed: "Failed to set model: {error}",
      },
      thinking: {
        current: "Current thinking level: {level}.",
        getFailed: "Failed to get thinking level: {error}",
        reset: "Thinking level reset to default.",
        resetFailed: "Failed to reset thinking level: {error}",
        unrecognized: 'Unrecognized thinking level "{level}". Valid levels: {options}.',
        unsupported:
          'Unsupported thinking level "{level}" for this model. Valid levels: {options}.',
        set: "Thinking level set to {level}.",
        setFailed: "Failed to set thinking level: {error}",
      },
      verbose: {
        current: "Current verbose level: {level}.",
        getFailed: "Failed to get verbose level: {error}",
        unrecognized: 'Unrecognized verbose level "{level}". Valid levels: off, on, full.',
        set: "Verbose mode set to {level}.",
        setFailed: "Failed to set verbose mode: {error}",
      },
      fast: {
        options: "on, off, auto ({seconds} sec), default, status",
        getFailed: "Failed to get fast mode: {error}",
        reset: "Fast mode reset to default.",
        resetFailed: "Failed to reset fast mode: {error}",
        unrecognized:
          'Unrecognized fast mode "{mode}". Valid levels: on, off, auto, default, status.',
        setAuto: "Fast mode set to auto.",
        enabled: "Fast mode enabled.",
        disabled: "Fast mode disabled.",
        setFailed: "Failed to set fast mode: {error}",
      },
      usage: {
        noActiveThread: "No active session.",
        notAvailable: "n/a",
        title: "Session Usage",
        inputTokens: "Input: {count} tokens",
        outputTokens: "Output: {count} tokens",
        totalTokens: "Total: {count} tokens",
        context: "Context: {percent} of {total}",
        promptBudget: "Prompt budget (last run): {percent} of {total}",
        model: "Model: {model}",
        failed: "Failed to get usage: {error}",
      },
      agents: {
        none: "No agents configured.",
        title: "**Agents** ({count})",
        default: "default",
        runtime: " · runtime {runtime}",
        failed: "Failed to list agents: {error}",
      },
      steer: {
        timeout: "The active run ended before the steer message was accepted.",
        failed: "Steer failed before it reached the run; try again.",
        usage: "Usage: `/steer <message>`",
        succeeded: "Steered.",
        requestFailed: "Failed to steer: {error}",
      },
      redirect: {
        timeout: "The active run ended before the redirect message was accepted.",
        failed: "Redirect failed before it reached the run; try again.",
        usage: "Usage: `/redirect <message>`",
        succeeded: "Redirected.",
        requestFailed: "Failed to redirect: {error}",
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
