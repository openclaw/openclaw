import { describe, expect, it } from "vitest";
import * as sdk from "./index.js";

describe("plugin-sdk exports", () => {
  it("does not expose runtime modules", () => {
    const forbidden = [
      "chunkMarkdownText",
      "chunkText",
      "resolveTextChunkLimit",
      "hasControlCommand",
      "isControlCommandMessage",
      "shouldComputeCommandAuthorized",
      "shouldHandleTextCommands",
      "buildMentionRegexes",
      "matchesMentionPatterns",
      "resolveStateDir",
      "loadConfig",
      "writeConfigFile",
      "runCommandWithTimeout",
      "enqueueSystemEvent",
      "fetchRemoteMedia",
      "saveMediaBuffer",
      "formatAgentEnvelope",
      "buildPairingReply",
      "resolveAgentRoute",
      "dispatchReplyFromConfig",
      "createReplyDispatcherWithTyping",
      "dispatchReplyWithBufferedBlockDispatcher",
      "resolveCommandAuthorizedFromAuthorizers",
      "monitorSlackProvider",
      "monitorTelegramProvider",
      "monitorIMessageProvider",
      "monitorSignalProvider",
      "sendMessageSlack",
      "sendMessageTelegram",
      "sendMessageIMessage",
      "sendMessageSignal",
      "sendMessageWhatsApp",
      "probeSlack",
      "probeTelegram",
      "probeIMessage",
      "probeSignal",
    ];

    for (const key of forbidden) {
      expect(Object.prototype.hasOwnProperty.call(sdk, key)).toBe(false);
    }
  });

  // Verify critical functions that extensions depend on are exported and callable.
  // Regression guard for #27569 where isDangerousNameMatchingEnabled was missing
  // from the compiled output, breaking mattermost/googlechat/msteams/irc plugins.
  it("exports critical functions used by channel extensions", () => {
    const requiredFunctions = [
      "isDangerousNameMatchingEnabled",
      "createAccountListHelpers",
      "buildAgentMediaPayload",
      "createReplyPrefixOptions",
      "createTypingCallbacks",
      "logInboundDrop",
      "logTypingFailure",
      "buildPendingHistoryContextFromMap",
      "clearHistoryEntriesIfEnabled",
      "recordPendingHistoryEntryIfEnabled",
      "resolveControlCommandGate",
      "resolveDmGroupAccessWithLists",
      "resolveAllowlistProviderRuntimeGroupPolicy",
      "resolveDefaultGroupPolicy",
      "resolveChannelMediaMaxBytes",
      "warnMissingProviderGroupPolicyFallbackOnce",
      "createDedupeCache",
      "formatInboundFromLabel",
      "resolveRuntimeGroupPolicy",
      "emptyPluginConfigSchema",
      "normalizePluginHttpPath",
      "registerPluginHttpRoute",
      "buildBaseAccountStatusSnapshot",
      "buildBaseChannelStatusSummary",
      "buildTokenChannelStatusSummary",
      "collectStatusIssuesFromLastError",
      "createDefaultChannelRuntimeState",
      "resolveChannelEntryMatch",
      "resolveChannelEntryMatchWithFallback",
      "normalizeChannelSlug",
      "buildChannelKeyCandidates",
    ];

    for (const key of requiredFunctions) {
      expect(sdk).toHaveProperty(key);
      expect(typeof (sdk as Record<string, unknown>)[key]).toBe("function");
    }
  });

  // Verify critical constants that extensions depend on are exported.
  it("exports critical constants used by channel extensions", () => {
    const requiredConstants = [
      "DEFAULT_GROUP_HISTORY_LIMIT",
      "DEFAULT_ACCOUNT_ID",
      "SILENT_REPLY_TOKEN",
      "PAIRING_APPROVED_MESSAGE",
    ];

    for (const key of requiredConstants) {
      expect(sdk).toHaveProperty(key);
    }
  });
});
