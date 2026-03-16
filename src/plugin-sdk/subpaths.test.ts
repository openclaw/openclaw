import * as extensionApi from "openclaw/extension-api";
import * as compatSdk from "openclaw/plugin-sdk/compat";
import * as coreSdk from "openclaw/plugin-sdk/core";
import type {
  ChannelMessageActionContext as CoreChannelMessageActionContext,
  OpenClawPluginApi as CoreOpenClawPluginApi,
  PluginRuntime as CorePluginRuntime,
} from "openclaw/plugin-sdk/core";
import * as discordSdk from "openclaw/plugin-sdk/discord";
import * as imessageSdk from "openclaw/plugin-sdk/imessage";
import * as lineSdk from "openclaw/plugin-sdk/line";
import * as msteamsSdk from "openclaw/plugin-sdk/msteams";
import * as nostrSdk from "openclaw/plugin-sdk/nostr";
import * as signalSdk from "openclaw/plugin-sdk/signal";
import * as slackSdk from "openclaw/plugin-sdk/slack";
import * as telegramSdk from "openclaw/plugin-sdk/telegram";
import * as whatsappSdk from "openclaw/plugin-sdk/whatsapp";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ChannelMessageActionContext } from "../channels/plugins/types.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { pluginSdkSubpaths } from "./entrypoints.js";

const bundledExtensionSubpathLoaders = [
  { id: "acpx", load: () => import("openclaw/plugin-sdk/acpx") },
  { id: "bluebubbles", load: () => import("openclaw/plugin-sdk/bluebubbles") },
  { id: "copilot-proxy", load: () => import("openclaw/plugin-sdk/copilot-proxy") },
  { id: "device-pair", load: () => import("openclaw/plugin-sdk/device-pair") },
  { id: "diagnostics-otel", load: () => import("openclaw/plugin-sdk/diagnostics-otel") },
  { id: "diffs", load: () => import("openclaw/plugin-sdk/diffs") },
  { id: "feishu", load: () => import("openclaw/plugin-sdk/feishu") },
  {
    id: "google-gemini-cli-auth",
    load: () => import("openclaw/plugin-sdk/google-gemini-cli-auth"),
  },
  { id: "googlechat", load: () => import("openclaw/plugin-sdk/googlechat") },
  { id: "irc", load: () => import("openclaw/plugin-sdk/irc") },
  { id: "llm-task", load: () => import("openclaw/plugin-sdk/llm-task") },
  { id: "lobster", load: () => import("openclaw/plugin-sdk/lobster") },
  { id: "matrix", load: () => import("openclaw/plugin-sdk/matrix") },
  { id: "mattermost", load: () => import("openclaw/plugin-sdk/mattermost") },
  { id: "memory-core", load: () => import("openclaw/plugin-sdk/memory-core") },
  { id: "memory-lancedb", load: () => import("openclaw/plugin-sdk/memory-lancedb") },
  { id: "memory-memoria", load: () => import("openclaw/plugin-sdk/memory-memoria") },
  {
    id: "minimax-portal-auth",
    load: () => import("openclaw/plugin-sdk/minimax-portal-auth"),
  },
  { id: "nextcloud-talk", load: () => import("openclaw/plugin-sdk/nextcloud-talk") },
  { id: "nostr", load: () => import("openclaw/plugin-sdk/nostr") },
  { id: "open-prose", load: () => import("openclaw/plugin-sdk/open-prose") },
  { id: "phone-control", load: () => import("openclaw/plugin-sdk/phone-control") },
  { id: "qwen-portal-auth", load: () => import("openclaw/plugin-sdk/qwen-portal-auth") },
  { id: "synology-chat", load: () => import("openclaw/plugin-sdk/synology-chat") },
  { id: "talk-voice", load: () => import("openclaw/plugin-sdk/talk-voice") },
  { id: "test-utils", load: () => import("openclaw/plugin-sdk/test-utils") },
  { id: "thread-ownership", load: () => import("openclaw/plugin-sdk/thread-ownership") },
  { id: "tlon", load: () => import("openclaw/plugin-sdk/tlon") },
  { id: "twitch", load: () => import("openclaw/plugin-sdk/twitch") },
  { id: "voice-call", load: () => import("openclaw/plugin-sdk/voice-call") },
  { id: "zalo", load: () => import("openclaw/plugin-sdk/zalo") },
  { id: "zalouser", load: () => import("openclaw/plugin-sdk/zalouser") },
] as const;
const importPluginSdkSubpath = (specifier: string) => import(/* @vite-ignore */ specifier);

const bundledExtensionSubpathLoaders = pluginSdkSubpaths.map((id: string) => ({
  id,
  load: () => importPluginSdkSubpath(`openclaw/plugin-sdk/${id}`),
}));

const asExports = (mod: object) => mod as Record<string, unknown>;

describe("plugin-sdk subpath exports", () => {
  it("exports compat helpers", () => {
    expect(typeof compatSdk.emptyPluginConfigSchema).toBe("function");
    expect(typeof compatSdk.resolveControlCommandGate).toBe("function");
  });

  it("exports core routing helpers", () => {
    expect(typeof coreSdk.buildAgentSessionKey).toBe("function");
    expect(typeof coreSdk.resolveThreadSessionKeys).toBe("function");
    expect(typeof coreSdk.runPassiveAccountLifecycle).toBe("function");
    expect(typeof coreSdk.createLoggerBackedRuntime).toBe("function");
  });

  it("exports shared core types used by bundled channels", () => {
    expectTypeOf<CoreOpenClawPluginApi>().toMatchTypeOf<OpenClawPluginApi>();
    expectTypeOf<CorePluginRuntime>().toMatchTypeOf<PluginRuntime>();
    expectTypeOf<CoreChannelMessageActionContext>().toMatchTypeOf<ChannelMessageActionContext>();
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
    const ircSdk = await import("openclaw/plugin-sdk/irc");
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
    const feishuSdk = await import("openclaw/plugin-sdk/feishu");
    expect(typeof feishuSdk.feishuSetupWizard).toBe("object");
    expect(typeof feishuSdk.feishuSetupAdapter).toBe("object");
  });

  it("exports LINE helpers", () => {
    expect(typeof lineSdk.processLineMessage).toBe("function");
    expect(typeof lineSdk.createInfoCard).toBe("function");
    expect(typeof lineSdk.lineSetupWizard).toBe("object");
    expect(typeof lineSdk.lineSetupAdapter).toBe("object");
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
    const googlechatSdk = await import("openclaw/plugin-sdk/googlechat");
    expect(typeof googlechatSdk.googlechatSetupWizard).toBe("object");
    expect(typeof googlechatSdk.googlechatSetupAdapter).toBe("object");
  });

  it("exports Zalo helpers", async () => {
    const zaloSdk = await import("openclaw/plugin-sdk/zalo");
    expect(typeof zaloSdk.zaloSetupWizard).toBe("object");
    expect(typeof zaloSdk.zaloSetupAdapter).toBe("object");
  });

  it("exports Synology Chat helpers", async () => {
    const synologyChatSdk = await import("openclaw/plugin-sdk/synology-chat");
    expect(typeof synologyChatSdk.synologyChatSetupWizard).toBe("object");
    expect(typeof synologyChatSdk.synologyChatSetupAdapter).toBe("object");
  });

  it("exports Zalouser helpers", async () => {
    const zalouserSdk = await import("openclaw/plugin-sdk/zalouser");
    expect(typeof zalouserSdk.zalouserSetupWizard).toBe("object");
    expect(typeof zalouserSdk.zalouserSetupAdapter).toBe("object");
  });

  it("exports Tlon helpers", async () => {
    const tlonSdk = await import("openclaw/plugin-sdk/tlon");
    expect(typeof tlonSdk.fetchWithSsrFGuard).toBe("function");
    expect(typeof tlonSdk.tlonSetupWizard).toBe("object");
    expect(typeof tlonSdk.tlonSetupAdapter).toBe("object");
  });

  it("exports acpx helpers", async () => {
    const acpxSdk = await import("openclaw/plugin-sdk/acpx");
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

  it("keeps the newly added bundled plugin-sdk contracts available", async () => {
    const bluebubbles = await import("openclaw/plugin-sdk/bluebubbles");
    expect(typeof bluebubbles.parseFiniteNumber).toBe("function");

    const matrix = await import("openclaw/plugin-sdk/matrix");
    expect(typeof matrix.matrixSetupWizard).toBe("object");
    expect(typeof matrix.matrixSetupAdapter).toBe("object");

    const mattermost = await import("openclaw/plugin-sdk/mattermost");
    expect(typeof mattermost.parseStrictPositiveInteger).toBe("function");

    const nextcloudTalk = await import("openclaw/plugin-sdk/nextcloud-talk");
    expect(typeof nextcloudTalk.waitForAbortSignal).toBe("function");

    const twitch = await import("openclaw/plugin-sdk/twitch");
    expect(typeof twitch.DEFAULT_ACCOUNT_ID).toBe("string");
    expect(typeof twitch.normalizeAccountId).toBe("function");
    expect(typeof twitch.twitchSetupWizard).toBe("object");
    expect(typeof twitch.twitchSetupAdapter).toBe("object");

    const zalo = await import("openclaw/plugin-sdk/zalo");
    expect(typeof zalo.resolveClientIp).toBe("function");
  });

  it("exports the extension api bridge", () => {
    expect(typeof extensionApi.runEmbeddedPiAgent).toBe("function");
  });
});
