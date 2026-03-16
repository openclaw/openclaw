import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { describe, expect, it } from "vitest";
import * as sdk from "./index.js";

const pluginSdkEntrypoints = [
  "index",
  "core",
  "compat",
  "telegram",
  "discord",
  "slack",
  "signal",
  "imessage",
  "whatsapp",
  "line",
  "msteams",
  "acpx",
  "bluebubbles",
  "copilot-proxy",
  "device-pair",
  "diagnostics-otel",
  "diffs",
  "feishu",
  "googlechat",
  "irc",
  "llm-task",
  "lobster",
  "matrix",
  "mattermost",
  "memory-core",
  "memory-lancedb",
  "minimax-portal-auth",
  "nextcloud-talk",
  "nostr",
  "open-prose",
  "phone-control",
  "qwen-portal-auth",
  "synology-chat",
  "talk-voice",
  "test-utils",
  "thread-ownership",
  "tlon",
  "twitch",
  "voice-call",
  "zalo",
  "zalouser",
  "account-id",
  "keyed-async-queue",
] as const;

const pluginSdkSpecifiers = pluginSdkEntrypoints.map((entry) =>
  entry === "index" ? "openclaw/plugin-sdk" : `openclaw/plugin-sdk/${entry}`,
);

function buildPluginSdkPackageExports() {
  return Object.fromEntries(
    pluginSdkEntrypoints.map((entry) => [
      entry === "index" ? "./plugin-sdk" : `./plugin-sdk/${entry}`,
      {
        default: `./dist/plugin-sdk/${entry}.js`,
      },
    ]),
  );
}

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

  it("emits importable bundled subpath entries", { timeout: 240_000 }, async () => {
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-sdk-build-"));
    const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plugin-sdk-consumer-"));

    try {
      await build({
        clean: true,
        config: false,
        dts: false,
        entry: Object.fromEntries(
          pluginSdkEntrypoints.map((entry) => [entry, `src/plugin-sdk/${entry}.ts`]),
        ),
        env: { NODE_ENV: "production" },
        fixedExtension: false,
        logLevel: "error",
        outDir,
        platform: "node",
      });

      for (const entry of pluginSdkEntrypoints) {
        const module = await import(pathToFileURL(path.join(outDir, `${entry}.js`)).href);
        expect(module).toBeTypeOf("object");
      }

      const packageDir = path.join(fixtureDir, "openclaw");
      const consumerDir = path.join(fixtureDir, "consumer");
      const consumerEntry = path.join(consumerDir, "import-plugin-sdk.mjs");

      await fs.mkdir(path.join(packageDir, "dist"), { recursive: true });
      await fs.symlink(outDir, path.join(packageDir, "dist", "plugin-sdk"), "dir");
      await fs.writeFile(
        path.join(packageDir, "package.json"),
        JSON.stringify(
          {
            exports: buildPluginSdkPackageExports(),
            name: "openclaw",
            type: "module",
          },
          null,
          2,
        ),
      );

      await fs.mkdir(path.join(consumerDir, "node_modules"), { recursive: true });
      await fs.symlink(packageDir, path.join(consumerDir, "node_modules", "openclaw"), "dir");
      await fs.writeFile(
        consumerEntry,
        [
          `const specifiers = ${JSON.stringify(pluginSdkSpecifiers)};`,
          "const results = {};",
          "for (const specifier of specifiers) {",
          "  results[specifier] = typeof (await import(specifier));",
          "}",
          "export default results;",
        ].join("\n"),
      );

      const { default: importResults } = await import(pathToFileURL(consumerEntry).href);
      expect(importResults).toEqual(
        Object.fromEntries(pluginSdkSpecifiers.map((specifier) => [specifier, "object"])),
      );
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
      await fs.rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
