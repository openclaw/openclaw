import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

const enChatCommandResults = {
  chat: {
    commandResults: {
      newUnavailable: "Couldn’t start a new session. Try again.",
      forkUnavailable: "Couldn’t fork this session. Try again.",
      notConnected: "Reconnect to continue.",
      cannotRunDisconnected: "Reconnect to use /{name}.",
      failedUnexpectedly: "Command `/{name}` failed unexpectedly.",
      failed: "Couldn’t use /{name}. Try again.",
      unknownCommand: "Couldn’t find `{command}`. Type `/` to see available commands.",
      options: "Options: {options}.",
      connectionChanged: "The connection changed. Try the command again.",
      sessionUnavailable: "Couldn’t access this session. Open another session and try again.",
      help: {
        availableCommands: "Available commands",
        agentCommand: "agent",
        openMenu: "Type `/` to open the command menu.",
      },
      compaction: {
        failed: "Couldn’t compact this session. Try again.",
        failedWithReason: "Couldn’t compact this session. Try again.\n\n{reason}",
        tokenSummary: " ({before} → {after} tokens)",
        succeeded: "Context compacted",
        skipped: "Compaction skipped.",
        skippedWithReason: "Compaction skipped.\n\n{reason}",
      },
      model: {
        current: "**Current model:** {model}",
        available: "**Available:** {models}",
        more: " +{count} more",
        getFailed: "Couldn’t load model details. Try again.\n\n{error}",
        set: "Model set to {model}.",
        setFailed: "Couldn’t change the model. Try again.\n\n{error}",
      },
      thinking: {
        current: "Current effort: {level}.",
        getFailed: "Couldn’t load effort. Try again.\n\n{error}",
        reset: "Effort reset to default.",
        resetFailed: "Couldn’t reset effort. Try again.\n\n{error}",
        unrecognized: "Couldn’t change effort to “{level}”. Choose {options}.",
        unsupported: "Couldn’t use effort “{level}” with this model. Choose {options}.",
        set: "Effort set to {level}.",
        setFailed: "Couldn’t change effort. Try again.\n\n{error}",
      },
      verbose: {
        current: "Current verbose level: {level}.",
        getFailed: "Couldn’t load verbose mode. Try again.\n\n{error}",
        unrecognized: "Couldn’t change verbose mode to “{level}”. Choose off, on, or full.",
        set: "Verbose mode set to {level}.",
        setFailed: "Couldn’t change verbose mode. Try again.\n\n{error}",
      },
      fast: {
        options: "on, off, auto ({seconds} sec), default, status",
        getFailed: "Couldn’t load fast mode. Try again.\n\n{error}",
        reset: "Fast mode reset to default.",
        resetFailed: "Couldn’t reset fast mode. Try again.\n\n{error}",
        unrecognized:
          "Couldn’t change fast mode to “{mode}”. Choose on, off, auto, default, or status.",
        setAuto: "Fast mode set to auto.",
        enabled: "Fast mode enabled.",
        disabled: "Fast mode disabled.",
        setFailed: "Couldn’t change fast mode. Try again.\n\n{error}",
      },
      usage: {
        noActiveThread: "No active session. Open a session to view usage.",
        notAvailable: "n/a",
        title: "Session usage",
        inputTokens: "Input: {count} tokens",
        outputTokens: "Output: {count} tokens",
        totalTokens: "Total: {count} tokens",
        context: "Context: {percent} of {total}",
        promptBudget: "Prompt budget (last reply): {percent} of {total}",
        model: "Model: {model}",
        failed: "Couldn’t load usage. Try again.\n\n{error}",
      },
      agents: {
        none: "No agents yet. Open Agents to add one.",
        title: "**Agents** ({count})",
        default: "default",
        runtime: " · runtime {runtime}",
        failed: "Couldn’t load agents. Try again.\n\n{error}",
      },
      steer: {
        timeout: "Couldn’t guide the agent’s reply because it ended. Send a new message.",
        failed: "Couldn’t guide the agent’s reply. Try again.",
        usage: "Usage: `/steer <message>`",
        succeeded: "Steered.",
        requestFailed: "Couldn’t guide the agent’s reply. Try again.\n\n{error}",
      },
      redirect: {
        timeout: "Couldn’t restart the agent’s reply because it ended. Send a new message.",
        failed: "Couldn’t restart the agent’s reply. Try again.",
        usage: "Usage: `/redirect <message>`",
        succeeded: "Redirected.",
        requestFailed: "Couldn’t restart the agent’s reply. Try again.\n\n{error}",
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
