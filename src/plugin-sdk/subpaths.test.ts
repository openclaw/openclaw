import * as compatSdk from "openclaw/plugin-sdk/compat";
import * as coreSdk from "openclaw/plugin-sdk/core";
import type {
  ChannelMessageActionContext as CoreChannelMessageActionContext,
  OpenClawPluginApi as CoreOpenClawPluginApi,
  PluginRuntime as CorePluginRuntime,
} from "openclaw/plugin-sdk/core";
import * as discordSdk from "openclaw/plugin-sdk/discord";
import * as imessageSdk from "openclaw/plugin-sdk/imessage";
import * as lazyRuntimeSdk from "openclaw/plugin-sdk/lazy-runtime";
import * as lineSdk from "openclaw/plugin-sdk/line";
import * as lineCoreSdk from "openclaw/plugin-sdk/line-core";
import * as msteamsSdk from "openclaw/plugin-sdk/msteams";
import * as nostrSdk from "openclaw/plugin-sdk/nostr";
import * as ollamaSetupSdk from "openclaw/plugin-sdk/ollama-setup";
import * as providerSetupSdk from "openclaw/plugin-sdk/provider-setup";
import * as routingSdk from "openclaw/plugin-sdk/routing";
import * as runtimeSdk from "openclaw/plugin-sdk/runtime";
import * as sandboxSdk from "openclaw/plugin-sdk/sandbox";
import * as selfHostedProviderSetupSdk from "openclaw/plugin-sdk/self-hosted-provider-setup";
import * as setupSdk from "openclaw/plugin-sdk/setup";
import * as signalSdk from "openclaw/plugin-sdk/signal";
import * as slackSdk from "openclaw/plugin-sdk/slack";
import * as telegramSdk from "openclaw/plugin-sdk/telegram";
import * as testingSdk from "openclaw/plugin-sdk/testing";
import * as whatsappSdk from "openclaw/plugin-sdk/whatsapp";
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

const trimmedLegacyExtensionSubpaths = [
  "copilot-proxy",
  "device-pair",
  "diagnostics-otel",
  "diffs",
  "llm-task",
  "memory-lancedb",
  "open-prose",
  "phone-control",
  "talk-voice",
  "thread-ownership",
  "voice-call",
] as const;

const asExports = (mod: object) => mod as Record<string, unknown>;
const ircSdk = await import("openclaw/plugin-sdk/irc");
const feishuSdk = await import("openclaw/plugin-sdk/feishu");
const googlechatSdk = await import("openclaw/plugin-sdk/googlechat");
const zaloSdk = await import("openclaw/plugin-sdk/zalo");
const synologyChatSdk = await import("openclaw/plugin-sdk/synology-chat");
const zalouserSdk = await import("openclaw/plugin-sdk/zalouser");
const tlonSdk = await import("openclaw/plugin-sdk/tlon");
const acpxSdk = await import("openclaw/plugin-sdk/acpx");
const bluebubblesSdk = await import("openclaw/plugin-sdk/bluebubbles");
const matrixSdk = await import("openclaw/plugin-sdk/matrix");
const mattermostSdk = await import("openclaw/plugin-sdk/mattermost");
const nextcloudTalkSdk = await import("openclaw/plugin-sdk/nextcloud-talk");
const twitchSdk = await import("openclaw/plugin-sdk/twitch");
const accountHelpersSdk = await import("openclaw/plugin-sdk/account-helpers");

describe("plugin-sdk subpath exports", () => {
  it("exports compat helpers", () => {
    expect(typeof compatSdk.emptyPluginConfigSchema).toBe("function");
    expect(typeof compatSdk.resolveControlCommandGate).toBe("function");
    expect(typeof compatSdk.createScopedChannelConfigAdapter).toBe("function");
    expect(typeof compatSdk.createTopLevelChannelConfigAdapter).toBe("function");
    expect(typeof compatSdk.createHybridChannelConfigAdapter).toBe("function");
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
    expect("promptAndConfigureOpenAICompatibleSelfHostedProviderAuth" in asExports(coreSdk)).toBe(
      false,
    );
  });

  it("exports routing helpers from the dedicated subpath", () => {
    expect(typeof routingSdk.buildAgentSessionKey).toBe("function");
    expect(typeof routingSdk.resolveThreadSessionKeys).toBe("function");
  });

  it("exports account helper builders from the dedicated subpath", () => {
    expect(typeof accountHelpersSdk.createAccountListHelpers).toBe("function");
  });

  it("exports runtime helpers from the dedicated subpath", () => {
    expect(typeof runtimeSdk.createLoggerBackedRuntime).toBe("function");
  });

  it("exports provider setup helpers from the dedicated subpath", () => {
    expect(typeof providerSetupSdk.buildVllmProvider).toBe("function");
    expect(typeof providerSetupSdk.discoverOpenAICompatibleSelfHostedProvider).toBe("function");
    expect(typeof providerSetupSdk.promptAndConfigureOpenAICompatibleSelfHostedProviderAuth).toBe(
      "function",
    );
  });

  it("exports shared setup helpers from the dedicated subpath", () => {
    expect(typeof setupSdk.DEFAULT_ACCOUNT_ID).toBe("string");
    expect(typeof setupSdk.createAccountScopedAllowFromSection).toBe("function");
    expect(typeof setupSdk.createAccountScopedGroupAccessSection).toBe("function");
    expect(typeof setupSdk.createAllowFromSection).toBe("function");
    expect(typeof setupSdk.createCliPathTextInput).toBe("function");
    expect(typeof setupSdk.createDelegatedFinalize).toBe("function");
    expect(typeof setupSdk.createDelegatedPrepare).toBe("function");
    expect(typeof setupSdk.createDelegatedResolveConfigured).toBe("function");
    expect(typeof setupSdk.createDelegatedSetupWizardProxy).toBe("function");
    expect(typeof setupSdk.createDelegatedSetupWizardStatusResolvers).toBe("function");
    expect(typeof setupSdk.createDelegatedTextInputShouldPrompt).toBe("function");
    expect(typeof setupSdk.createDetectedBinaryStatus).toBe("function");
    expect(typeof setupSdk.createLegacyCompatChannelDmPolicy).toBe("function");
    expect(typeof setupSdk.createNestedChannelDmPolicy).toBe("function");
    expect(typeof setupSdk.createTopLevelChannelDmPolicy).toBe("function");
    expect(typeof setupSdk.createTopLevelChannelDmPolicySetter).toBe("function");
    expect(typeof setupSdk.formatDocsLink).toBe("function");
    expect(typeof setupSdk.mergeAllowFromEntries).toBe("function");
    expect(typeof setupSdk.patchNestedChannelConfigSection).toBe("function");
    expect(typeof setupSdk.patchTopLevelChannelConfigSection).toBe("function");
    expect(typeof setupSdk.promptParsedAllowFromForAccount).toBe("function");
    expect(typeof setupSdk.resolveParsedAllowFromEntries).toBe("function");
    expect(typeof setupSdk.resolveGroupAllowlistWithLookupNotes).toBe("function");
    expect(typeof setupSdk.setAccountAllowFromForChannel).toBe("function");
    expect(typeof setupSdk.setAccountDmAllowFromForChannel).toBe("function");
    expect(typeof setupSdk.setTopLevelChannelDmPolicyWithAllowFrom).toBe("function");
    expect(typeof setupSdk.formatResolvedUnresolvedNote).toBe("function");
  });

  it("exports shared lazy runtime helpers from the dedicated subpath", () => {
    expect(typeof lazyRuntimeSdk.createLazyRuntimeSurface).toBe("function");
    expect(typeof lazyRuntimeSdk.createLazyRuntimeModule).toBe("function");
    expect(typeof lazyRuntimeSdk.createLazyRuntimeNamedExport).toBe("function");
  });

  it("exports narrow self-hosted provider setup helpers", () => {
    expect(typeof selfHostedProviderSetupSdk.buildVllmProvider).toBe("function");
    expect(typeof selfHostedProviderSetupSdk.buildSglangProvider).toBe("function");
    expect(typeof selfHostedProviderSetupSdk.discoverOpenAICompatibleSelfHostedProvider).toBe(
      "function",
    );
    expect(
      typeof selfHostedProviderSetupSdk.configureOpenAICompatibleSelfHostedProviderNonInteractive,
    ).toBe("function");
  });

  it("exports narrow Ollama setup helpers", () => {
    expect(typeof ollamaSetupSdk.buildOllamaProvider).toBe("function");
    expect(typeof ollamaSetupSdk.configureOllamaNonInteractive).toBe("function");
    expect(typeof ollamaSetupSdk.ensureOllamaModelPulled).toBe("function");
  });

  it("exports sandbox helpers from the dedicated subpath", () => {
    expect(typeof sandboxSdk.registerSandboxBackend).toBe("function");
    expect(typeof sandboxSdk.runPluginCommandWithTimeout).toBe("function");
    expect(typeof sandboxSdk.createRemoteShellSandboxFsBridge).toBe("function");
  });

  it("exports shared core types used by bundled channels", () => {
    expectTypeOf<CoreOpenClawPluginApi>().toMatchTypeOf<OpenClawPluginApi>();
    expectTypeOf<CorePluginRuntime>().toMatchTypeOf<PluginRuntime>();
    expectTypeOf<CoreChannelMessageActionContext>().toMatchTypeOf<ChannelMessageActionContext>();
  });

  it("exports the public testing seam", () => {
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

  it("exports Signal helpers", () => {
    expect(typeof signalSdk.buildBaseAccountStatusSnapshot).toBe("function");
    expect(typeof signalSdk.SignalConfigSchema).toBe("object");
    expect(typeof signalSdk.normalizeSignalMessagingTarget).toBe("function");
    expect("resolveSignalAccount" in asExports(signalSdk)).toBe(false);
  });

  it("exports iMessage helpers", () => {
    expect(typeof imessageSdk.IMessageConfigSchema).toBe("object");
    expect(typeof imessageSdk.resolveIMessageConfigAllowFrom).toBe("function");
    expect(typeof imessageSdk.looksLikeIMessageTargetId).toBe("function");
    expect("resolveIMessageAccount" in asExports(imessageSdk)).toBe(false);
  });

  it("exports IRC helpers", async () => {
    expect(typeof ircSdk.resolveIrcAccount).toBe("function");
    expect(typeof ircSdk.ircSetupWizard).toBe("object");
    expect(typeof ircSdk.ircSetupAdapter).toBe("object");
  });

  it("exports WhatsApp helpers", () => {
    // WhatsApp-specific functions (resolveWhatsAppAccount, whatsappOnboardingAdapter) moved to extensions/whatsapp/src/
    expect(typeof whatsappSdk.WhatsAppConfigSchema).toBe("object");
    expect(typeof whatsappSdk.resolveWhatsAppOutboundTarget).toBe("function");
    expect(typeof whatsappSdk.resolveWhatsAppMentionStripRegexes).toBe("function");
    expect("resolveWhatsAppMentionStripPatterns" in whatsappSdk).toBe(false);
  });

  it("exports Feishu helpers", async () => {
    expect(typeof feishuSdk.feishuSetupWizard).toBe("object");
    expect(typeof feishuSdk.feishuSetupAdapter).toBe("object");
  });

  it("exports LINE helpers", () => {
    expect(typeof lineSdk.processLineMessage).toBe("function");
    expect(typeof lineSdk.createInfoCard).toBe("function");
    expect(typeof lineSdk.lineSetupWizard).toBe("object");
    expect(typeof lineSdk.lineSetupAdapter).toBe("object");
  });

  it("exports narrow LINE core helpers", () => {
    expect(typeof lineCoreSdk.resolveLineAccount).toBe("function");
    expect(typeof lineCoreSdk.listLineAccountIds).toBe("function");
    expect(typeof lineCoreSdk.LineConfigSchema).toBe("object");
  });

  it("exports Microsoft Teams helpers", () => {
    expect(typeof msteamsSdk.resolveControlCommandGate).toBe("function");
    expect(typeof msteamsSdk.loadOutboundMediaFromUrl).toBe("function");
    expect(typeof msteamsSdk.msteamsSetupWizard).toBe("object");
    expect(typeof msteamsSdk.msteamsSetupAdapter).toBe("object");
  });

  it("exports Nostr helpers", () => {
    expect(typeof nostrSdk.nostrSetupWizard).toBe("object");
    expect(typeof nostrSdk.nostrSetupAdapter).toBe("object");
  });

  it("exports Google Chat helpers", async () => {
    expect(typeof googlechatSdk.buildChannelConfigSchema).toBe("function");
    expect(typeof googlechatSdk.createWebhookInFlightLimiter).toBe("function");
    expect(typeof googlechatSdk.fetchWithSsrFGuard).toBe("function");
    expect(typeof googlechatSdk.googlechatSetupWizard).toBe("object");
    expect(typeof googlechatSdk.googlechatSetupAdapter).toBe("object");
    expect(typeof googlechatSdk.resolveGoogleChatGroupRequireMention).toBe("function");
  });

  it("keeps the Google Chat runtime seam aligned with the public SDK subpath", async () => {
    const googlechatRuntimeApi = await import("../../extensions/googlechat/runtime-api.js");

    expect(typeof googlechatRuntimeApi.buildChannelConfigSchema).toBe("function");
    expect(typeof googlechatRuntimeApi.createWebhookInFlightLimiter).toBe("function");
    expect(typeof googlechatRuntimeApi.fetchWithSsrFGuard).toBe("function");
    expect(typeof googlechatRuntimeApi.createActionGate).toBe("function");
    expect(typeof googlechatRuntimeApi.resolveWebhookTargetWithAuthOrReject).toBe("function");
  });

  it("exports Zalo helpers", async () => {
    expect(typeof zaloSdk.zaloSetupWizard).toBe("object");
    expect(typeof zaloSdk.zaloSetupAdapter).toBe("object");
  });

  it("exports Synology Chat helpers", async () => {
    expect(typeof synologyChatSdk.synologyChatSetupWizard).toBe("object");
    expect(typeof synologyChatSdk.synologyChatSetupAdapter).toBe("object");
  });

  it("exports Zalouser helpers", async () => {
    expect(typeof zalouserSdk.zalouserSetupWizard).toBe("object");
    expect(typeof zalouserSdk.zalouserSetupAdapter).toBe("object");
  });

  it("exports Tlon helpers", async () => {
    expect(typeof tlonSdk.fetchWithSsrFGuard).toBe("function");
    expect(typeof tlonSdk.tlonSetupWizard).toBe("object");
    expect(typeof tlonSdk.tlonSetupAdapter).toBe("object");
  });

  it("exports acpx helpers", async () => {
    expect(typeof acpxSdk.listKnownProviderAuthEnvVarNames).toBe("function");
    expect(typeof acpxSdk.omitEnvKeysCaseInsensitive).toBe("function");
  });

  it("resolves bundled extension subpaths", async () => {
    for (const { id, load } of bundledExtensionSubpathLoaders) {
      const mod = await load();
      expect(typeof mod).toBe("object");
      expect(mod, `subpath ${id} should resolve`).toBeTruthy();
    }
  });

  it("does not advertise trimmed legacy extension helper seams", () => {
    for (const id of trimmedLegacyExtensionSubpaths) {
      expect(pluginSdkSubpaths).not.toContain(id);
    }
  });

  it("keeps the newly added bundled plugin-sdk contracts available", async () => {
    expect(typeof bluebubblesSdk.parseFiniteNumber).toBe("function");
    expect(typeof matrixSdk.matrixSetupWizard).toBe("object");
    expect(typeof matrixSdk.matrixSetupAdapter).toBe("object");
    expect(typeof mattermostSdk.parseStrictPositiveInteger).toBe("function");
    expect(typeof nextcloudTalkSdk.waitForAbortSignal).toBe("function");
    expect(typeof twitchSdk.DEFAULT_ACCOUNT_ID).toBe("string");
    expect(typeof twitchSdk.normalizeAccountId).toBe("function");
    expect(typeof twitchSdk.twitchSetupWizard).toBe("object");
    expect(typeof twitchSdk.twitchSetupAdapter).toBe("object");
    expect(typeof zaloSdk.resolveClientIp).toBe("function");
  });
});
