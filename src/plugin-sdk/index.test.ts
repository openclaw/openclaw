import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  OpenClawPluginDefinition,
  OpenClawPluginModule,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
  OpenClawPluginToolOptions,
} from "./index.js";
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

  it("re-exports plugin authoring types", () => {
    expectTypeOf<OpenClawPluginDefinition>().toEqualTypeOf<OpenClawPluginDefinition>();
    expectTypeOf<OpenClawPluginModule>().toEqualTypeOf<OpenClawPluginModule>();
    expectTypeOf<OpenClawPluginToolContext>().toEqualTypeOf<OpenClawPluginToolContext>();
    expectTypeOf<OpenClawPluginToolFactory>().toEqualTypeOf<OpenClawPluginToolFactory>();
    expectTypeOf<OpenClawPluginToolOptions>().toEqualTypeOf<OpenClawPluginToolOptions>();
  });
});
