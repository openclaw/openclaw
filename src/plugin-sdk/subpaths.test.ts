import * as bluebubblesSdk from "openclaw/plugin-sdk/bluebubbles";
import * as channelPairingSdk from "openclaw/plugin-sdk/channel-pairing";
import * as channelReplyPipelineSdk from "openclaw/plugin-sdk/channel-reply-pipeline";
import * as channelRuntimeSdk from "openclaw/plugin-sdk/channel-runtime";
import * as channelSendResultSdk from "openclaw/plugin-sdk/channel-send-result";
import * as channelSetupSdk from "openclaw/plugin-sdk/channel-setup";
import * as coreSdk from "openclaw/plugin-sdk/core";
import type {
  ChannelMessageActionContext as CoreChannelMessageActionContext,
  OpenClawPluginApi as CoreOpenClawPluginApi,
  PluginRuntime as CorePluginRuntime,
} from "openclaw/plugin-sdk/core";
import * as directoryRuntimeSdk from "openclaw/plugin-sdk/directory-runtime";
import * as discordSdk from "openclaw/plugin-sdk/discord";
import * as imessageSdk from "openclaw/plugin-sdk/imessage";
import * as imessageCoreSdk from "openclaw/plugin-sdk/imessage-core";
import * as lazyRuntimeSdk from "openclaw/plugin-sdk/lazy-runtime";
import * as ollamaSetupSdk from "openclaw/plugin-sdk/ollama-setup";
import * as providerModelsSdk from "openclaw/plugin-sdk/provider-models";
import * as providerSetupSdk from "openclaw/plugin-sdk/provider-setup";
import * as replyPayloadSdk from "openclaw/plugin-sdk/reply-payload";
import * as routingSdk from "openclaw/plugin-sdk/routing";
import * as runtimeSdk from "openclaw/plugin-sdk/runtime";
import * as sandboxSdk from "openclaw/plugin-sdk/sandbox";
import * as secretInputSdk from "openclaw/plugin-sdk/secret-input";
import * as selfHostedProviderSetupSdk from "openclaw/plugin-sdk/self-hosted-provider-setup";
import * as setupSdk from "openclaw/plugin-sdk/setup";
import * as slackSdk from "openclaw/plugin-sdk/slack";
import * as telegramSdk from "openclaw/plugin-sdk/telegram";
import * as testingSdk from "openclaw/plugin-sdk/testing";
import * as webhookIngressSdk from "openclaw/plugin-sdk/webhook-ingress";
import * as whatsappSdk from "openclaw/plugin-sdk/whatsapp";
import * as whatsappActionRuntimeSdk from "openclaw/plugin-sdk/whatsapp-action-runtime";
import * as whatsappLoginQrSdk from "openclaw/plugin-sdk/whatsapp-login-qr";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ChannelMessageActionContext } from "../channels/plugins/types.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import type {
  ChannelMessageActionContext as SharedChannelMessageActionContext,
  OpenClawPluginApi as SharedOpenClawPluginApi,
  PluginRuntime as SharedPluginRuntime,
} from "./channel-plugin-common.js";
import { pluginSdkSubpaths } from "./entrypoints.js";

const importPluginSdkSubpath = (specifier: string) => import(/* @vite-ignore */ specifier);

const bundledExtensionSubpathLoaders = pluginSdkSubpaths.map((id: string) => ({
  id,
  load: () => importPluginSdkSubpath(`openclaw/plugin-sdk/${id}`),
}));

const asExports = (mod: object) => mod as Record<string, unknown>;
const accountHelpersSdk = await import("openclaw/plugin-sdk/account-helpers");
const allowlistEditSdk = await import("openclaw/plugin-sdk/allowlist-config-edit");

describe("plugin-sdk subpath exports", () => {
  it("keeps legacy compat out of the curated public list", () => {
    expect(pluginSdkSubpaths).not.toContain("compat");
  });

  it("keeps core focused on generic shared exports", () => {
    expect(typeof coreSdk.emptyPluginConfigSchema).toBe("function");
    expect(typeof coreSdk.definePluginEntry).toBe("function");
    expect(typeof coreSdk.defineChannelPluginEntry).toBe("function");
    expect(typeof coreSdk.defineSetupPluginEntry).toBe("function");
    expect(typeof coreSdk.createChannelPluginBase).toBe("function");
    expect(typeof coreSdk.isSecretRef).toBe("function");
    expect(typeof coreSdk.optionalStringEnum).toBe("function");
    expect("runPassiveAccountLifecycle" in asExports(coreSdk)).toBe(false);
    expect("createLoggerBackedRuntime" in asExports(coreSdk)).toBe(false);
    expect("registerSandboxBackend" in asExports(coreSdk)).toBe(false);
  });

  it("exports routing helpers from the dedicated subpath", () => {
    expect(typeof routingSdk.buildAgentSessionKey).toBe("function");
    expect(typeof routingSdk.resolveThreadSessionKeys).toBe("function");
  });

  it("exports reply payload helpers from the dedicated subpath", () => {
    expect(typeof replyPayloadSdk.deliverTextOrMediaReply).toBe("function");
    expect(typeof replyPayloadSdk.resolveOutboundMediaUrls).toBe("function");
    expect(typeof replyPayloadSdk.sendPayloadWithChunkedTextAndMedia).toBe("function");
  });

  it("exports account helper builders from the dedicated subpath", () => {
    expect(typeof accountHelpersSdk.createAccountListHelpers).toBe("function");
  });

  it("exports allowlist edit helpers from the dedicated subpath", () => {
    expect(typeof allowlistEditSdk.buildDmGroupAccountAllowlistAdapter).toBe("function");
    expect(typeof allowlistEditSdk.createNestedAllowlistOverrideResolver).toBe("function");
  });

  it("exports runtime helpers from the dedicated subpath", () => {
    expect(typeof runtimeSdk.createLoggerBackedRuntime).toBe("function");
  });

  it("exports directory runtime helpers from the dedicated subpath", () => {
    expect(typeof directoryRuntimeSdk.listDirectoryEntriesFromSources).toBe("function");
    expect(typeof directoryRuntimeSdk.listResolvedDirectoryEntriesFromSources).toBe("function");
  });

  it("exports channel runtime helpers from the dedicated subpath", () => {
    expect(typeof channelRuntimeSdk.createChannelDirectoryAdapter).toBe("function");
    expect(typeof channelRuntimeSdk.createRuntimeOutboundDelegates).toBe("function");
    expect(typeof channelRuntimeSdk.sendPayloadMediaSequenceOrFallback).toBe("function");
  });

  it("exports channel setup helpers from the dedicated subpath", () => {
    expect(typeof channelSetupSdk.createOptionalChannelSetupSurface).toBe("function");
    expect(typeof channelSetupSdk.createTopLevelChannelDmPolicy).toBe("function");
  });

  it("exports channel pairing helpers from the dedicated subpath", () => {
    expect(typeof channelPairingSdk.createChannelPairingController).toBe("function");
    expect(typeof channelPairingSdk.createChannelPairingChallengeIssuer).toBe("function");
    expect(typeof channelPairingSdk.createScopedPairingAccess).toBe("function");
  });

  it("exports channel reply pipeline helpers from the dedicated subpath", () => {
    expect(typeof channelReplyPipelineSdk.createChannelReplyPipeline).toBe("function");
    expect(typeof channelReplyPipelineSdk.createTypingCallbacks).toBe("function");
  });

  it("exports channel send-result helpers from the dedicated subpath", () => {
    expect(typeof channelSendResultSdk.attachChannelToResult).toBe("function");
    expect(typeof channelSendResultSdk.buildChannelSendResult).toBe("function");
  });

  it("exports provider setup helpers from the dedicated subpath", () => {
    expect(typeof providerSetupSdk.buildVllmProvider).toBe("function");
    expect(typeof providerSetupSdk.discoverOpenAICompatibleSelfHostedProvider).toBe("function");
  });

  it("keeps provider models focused on shared provider primitives", () => {
    expect(typeof providerModelsSdk.applyOpenAIConfig).toBe("function");
    expect(typeof providerModelsSdk.buildKilocodeModelDefinition).toBe("function");
    expect(typeof providerModelsSdk.discoverHuggingfaceModels).toBe("function");
    expect("buildMinimaxModelDefinition" in asExports(providerModelsSdk)).toBe(false);
    expect("buildMoonshotProvider" in asExports(providerModelsSdk)).toBe(false);
    expect("QIANFAN_BASE_URL" in asExports(providerModelsSdk)).toBe(false);
    expect("resolveZaiBaseUrl" in asExports(providerModelsSdk)).toBe(false);
  });

  it("exports shared setup helpers from the dedicated subpath", () => {
    expect(typeof setupSdk.DEFAULT_ACCOUNT_ID).toBe("string");
    expect(typeof setupSdk.createAllowFromSection).toBe("function");
    expect(typeof setupSdk.createDelegatedSetupWizardProxy).toBe("function");
    expect(typeof setupSdk.createTopLevelChannelDmPolicy).toBe("function");
    expect(typeof setupSdk.mergeAllowFromEntries).toBe("function");
  });

  it("exports shared lazy runtime helpers from the dedicated subpath", () => {
    expect(typeof lazyRuntimeSdk.createLazyRuntimeSurface).toBe("function");
    expect(typeof lazyRuntimeSdk.createLazyRuntimeModule).toBe("function");
  });

  it("exports narrow self-hosted provider setup helpers", () => {
    expect(typeof selfHostedProviderSetupSdk.buildVllmProvider).toBe("function");
    expect(typeof selfHostedProviderSetupSdk.buildSglangProvider).toBe("function");
    expect(
      typeof selfHostedProviderSetupSdk.configureOpenAICompatibleSelfHostedProviderNonInteractive,
    ).toBe("function");
  });

  it("exports narrow Ollama setup helpers", () => {
    expect(typeof ollamaSetupSdk.buildOllamaProvider).toBe("function");
    expect(typeof ollamaSetupSdk.configureOllamaNonInteractive).toBe("function");
  });

  it("exports sandbox helpers from the dedicated subpath", () => {
    expect(typeof sandboxSdk.registerSandboxBackend).toBe("function");
    expect(typeof sandboxSdk.runPluginCommandWithTimeout).toBe("function");
  });

  it("exports secret input helpers from the dedicated subpath", () => {
    expect(typeof secretInputSdk.buildSecretInputSchema).toBe("function");
    expect(typeof secretInputSdk.buildOptionalSecretInputSchema).toBe("function");
    expect(typeof secretInputSdk.normalizeSecretInputString).toBe("function");
  });

  it("exports webhook ingress helpers from the dedicated subpath", () => {
    expect(typeof webhookIngressSdk.resolveWebhookPath).toBe("function");
    expect(typeof webhookIngressSdk.readJsonWebhookBodyOrReject).toBe("function");
    expect(typeof webhookIngressSdk.withResolvedWebhookRequestPipeline).toBe("function");
  });

  it("exports shared core types used by bundled channels", () => {
    expectTypeOf<CoreOpenClawPluginApi>().toMatchTypeOf<OpenClawPluginApi>();
    expectTypeOf<CorePluginRuntime>().toMatchTypeOf<PluginRuntime>();
    expectTypeOf<CoreChannelMessageActionContext>().toMatchTypeOf<ChannelMessageActionContext>();
  });

  it("exports the public testing surface", () => {
    expect(typeof testingSdk.removeAckReactionAfterReply).toBe("function");
    expect(typeof testingSdk.shouldAckReaction).toBe("function");
  });

  it("keeps core shared types aligned with the channel prelude", () => {
    expectTypeOf<CoreOpenClawPluginApi>().toMatchTypeOf<SharedOpenClawPluginApi>();
    expectTypeOf<CorePluginRuntime>().toMatchTypeOf<SharedPluginRuntime>();
    expectTypeOf<CoreChannelMessageActionContext>().toMatchTypeOf<SharedChannelMessageActionContext>();
  });

  it("exports Discord helpers", () => {
    expect(typeof discordSdk.buildChannelConfigSchema).toBe("function");
    expect(typeof discordSdk.DiscordConfigSchema).toBe("object");
    expect(typeof discordSdk.projectCredentialSnapshotFields).toBe("function");
    expect("resolveDiscordAccount" in asExports(discordSdk)).toBe(false);
  });

  it("exports Slack helpers", () => {
    expect(typeof slackSdk.buildChannelConfigSchema).toBe("function");
    expect(typeof slackSdk.SlackConfigSchema).toBe("object");
    expect(typeof slackSdk.looksLikeSlackTargetId).toBe("function");
    expect("resolveSlackAccount" in asExports(slackSdk)).toBe(false);
  });

  it("exports Telegram helpers", () => {
    expect(typeof telegramSdk.buildChannelConfigSchema).toBe("function");
    expect(typeof telegramSdk.TelegramConfigSchema).toBe("object");
    expect(typeof telegramSdk.projectCredentialSnapshotFields).toBe("function");
    expect("resolveTelegramAccount" in asExports(telegramSdk)).toBe(false);
  });

  it("exports iMessage helpers", () => {
    expect(typeof imessageSdk.IMessageConfigSchema).toBe("object");
    expect(typeof imessageSdk.resolveIMessageConfigAllowFrom).toBe("function");
    expect(typeof imessageSdk.looksLikeIMessageTargetId).toBe("function");
    expect("resolveIMessageAccount" in asExports(imessageSdk)).toBe(false);
  });

  it("exports iMessage core helpers", () => {
    expect(typeof imessageCoreSdk.buildChannelConfigSchema).toBe("function");
    expect(typeof imessageCoreSdk.parseChatTargetPrefixesOrThrow).toBe("function");
    expect(typeof imessageCoreSdk.resolveServicePrefixedTarget).toBe("function");
    expect(typeof imessageCoreSdk.IMessageConfigSchema).toBe("object");
  });

  it("exports WhatsApp helpers", () => {
    expect(typeof whatsappSdk.WhatsAppConfigSchema).toBe("object");
    expect(typeof whatsappSdk.resolveWhatsAppOutboundTarget).toBe("function");
    expect(typeof whatsappSdk.resolveWhatsAppMentionStripRegexes).toBe("function");
  });

  it("exports WhatsApp QR login helpers from the dedicated subpath", () => {
    expect(typeof whatsappLoginQrSdk.startWebLoginWithQr).toBe("function");
    expect(typeof whatsappLoginQrSdk.waitForWebLogin).toBe("function");
  });

  it("exports WhatsApp action runtime helpers from the dedicated subpath", () => {
    expect(typeof whatsappActionRuntimeSdk.handleWhatsAppAction).toBe("function");
  });

  it("keeps the remaining bundled helper surface narrow", () => {
    expect(typeof bluebubblesSdk.parseFiniteNumber).toBe("function");
  });

  it("resolves every curated public subpath", async () => {
    for (const { id, load } of bundledExtensionSubpathLoaders) {
      const mod = await load();
      expect(typeof mod).toBe("object");
      expect(mod, `subpath ${id} should resolve`).toBeTruthy();
    }
  });
});
