import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import * as compatSdk from "openclaw/plugin-sdk/compat";
import * as discordSdk from "openclaw/plugin-sdk/discord";
import * as imessageSdk from "openclaw/plugin-sdk/imessage";
import * as lineSdk from "openclaw/plugin-sdk/line";
import * as msteamsSdk from "openclaw/plugin-sdk/msteams";
import * as signalSdk from "openclaw/plugin-sdk/signal";
import * as slackSdk from "openclaw/plugin-sdk/slack";
import * as telegramSdk from "openclaw/plugin-sdk/telegram";
import * as whatsappSdk from "openclaw/plugin-sdk/whatsapp";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

async function loadBundledSubpath(specifier: string) {
  try {
    const resolved = require.resolve(specifier);
    return import(pathToFileURL(resolved).href);
  } catch (error) {
    // Unit tests run from source without a built dist tree.
    // Fall back to Vite-resolved source modules in that environment.
    if (
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code === "MODULE_NOT_FOUND"
    ) {
      return import(specifier);
    }
    throw error;
  }
}

const bundledExtensionSubpathLoaders = [
  { id: "acpx", load: () => loadBundledSubpath("openclaw/plugin-sdk/acpx") },
  { id: "bluebubbles", load: () => loadBundledSubpath("openclaw/plugin-sdk/bluebubbles") },
  { id: "copilot-proxy", load: () => loadBundledSubpath("openclaw/plugin-sdk/copilot-proxy") },
  { id: "device-pair", load: () => loadBundledSubpath("openclaw/plugin-sdk/device-pair") },
  {
    id: "diagnostics-otel",
    load: () => loadBundledSubpath("openclaw/plugin-sdk/diagnostics-otel"),
  },
  { id: "diffs", load: () => loadBundledSubpath("openclaw/plugin-sdk/diffs") },
  { id: "feishu", load: () => loadBundledSubpath("openclaw/plugin-sdk/feishu") },
  {
    id: "google-gemini-cli-auth",
    load: () => loadBundledSubpath("openclaw/plugin-sdk/google-gemini-cli-auth"),
  },
  { id: "googlechat", load: () => loadBundledSubpath("openclaw/plugin-sdk/googlechat") },
  { id: "irc", load: () => loadBundledSubpath("openclaw/plugin-sdk/irc") },
  { id: "llm-task", load: () => loadBundledSubpath("openclaw/plugin-sdk/llm-task") },
  { id: "lobster", load: () => loadBundledSubpath("openclaw/plugin-sdk/lobster") },
  { id: "matrix", load: () => loadBundledSubpath("openclaw/plugin-sdk/matrix") },
  { id: "mattermost", load: () => loadBundledSubpath("openclaw/plugin-sdk/mattermost") },
  { id: "continuity", load: () => loadBundledSubpath("openclaw/plugin-sdk/continuity") },
  { id: "memory-core", load: () => loadBundledSubpath("openclaw/plugin-sdk/memory-core") },
  {
    id: "memory-lancedb",
    load: () => loadBundledSubpath("openclaw/plugin-sdk/memory-lancedb"),
  },
  {
    id: "minimax-portal-auth",
    load: () => loadBundledSubpath("openclaw/plugin-sdk/minimax-portal-auth"),
  },
  { id: "nextcloud-talk", load: () => loadBundledSubpath("openclaw/plugin-sdk/nextcloud-talk") },
  { id: "nostr", load: () => loadBundledSubpath("openclaw/plugin-sdk/nostr") },
  { id: "open-prose", load: () => loadBundledSubpath("openclaw/plugin-sdk/open-prose") },
  { id: "phone-control", load: () => loadBundledSubpath("openclaw/plugin-sdk/phone-control") },
  {
    id: "qwen-portal-auth",
    load: () => loadBundledSubpath("openclaw/plugin-sdk/qwen-portal-auth"),
  },
  { id: "synology-chat", load: () => loadBundledSubpath("openclaw/plugin-sdk/synology-chat") },
  { id: "talk-voice", load: () => loadBundledSubpath("openclaw/plugin-sdk/talk-voice") },
  { id: "test-utils", load: () => loadBundledSubpath("openclaw/plugin-sdk/test-utils") },
  {
    id: "thread-ownership",
    load: () => loadBundledSubpath("openclaw/plugin-sdk/thread-ownership"),
  },
  { id: "tlon", load: () => loadBundledSubpath("openclaw/plugin-sdk/tlon") },
  { id: "twitch", load: () => loadBundledSubpath("openclaw/plugin-sdk/twitch") },
  { id: "voice-call", load: () => loadBundledSubpath("openclaw/plugin-sdk/voice-call") },
  { id: "zalo", load: () => loadBundledSubpath("openclaw/plugin-sdk/zalo") },
  { id: "zalouser", load: () => loadBundledSubpath("openclaw/plugin-sdk/zalouser") },
] as const;

describe("plugin-sdk subpath exports", () => {
  it("exports compat helpers", () => {
    expect(typeof compatSdk.emptyPluginConfigSchema).toBe("function");
    expect(typeof compatSdk.resolveControlCommandGate).toBe("function");
  });

  it("exports Discord helpers", () => {
    expect(typeof discordSdk.resolveDiscordAccount).toBe("function");
    expect(typeof discordSdk.inspectDiscordAccount).toBe("function");
    expect(typeof discordSdk.discordOnboardingAdapter).toBe("object");
  });

  it("exports Slack helpers", () => {
    expect(typeof slackSdk.resolveSlackAccount).toBe("function");
    expect(typeof slackSdk.inspectSlackAccount).toBe("function");
    expect(typeof slackSdk.handleSlackMessageAction).toBe("function");
  });

  it("exports Telegram helpers", () => {
    expect(typeof telegramSdk.resolveTelegramAccount).toBe("function");
    expect(typeof telegramSdk.inspectTelegramAccount).toBe("function");
    expect(typeof telegramSdk.telegramOnboardingAdapter).toBe("object");
  });

  it("exports Signal helpers", () => {
    expect(typeof signalSdk.resolveSignalAccount).toBe("function");
    expect(typeof signalSdk.signalOnboardingAdapter).toBe("object");
  });

  it("exports iMessage helpers", () => {
    expect(typeof imessageSdk.resolveIMessageAccount).toBe("function");
    expect(typeof imessageSdk.imessageOnboardingAdapter).toBe("object");
  });

  it("exports WhatsApp helpers", () => {
    expect(typeof whatsappSdk.resolveWhatsAppAccount).toBe("function");
    expect(typeof whatsappSdk.whatsappOnboardingAdapter).toBe("object");
  });

  it("exports LINE helpers", () => {
    expect(typeof lineSdk.processLineMessage).toBe("function");
    expect(typeof lineSdk.createInfoCard).toBe("function");
  });

  it("exports Microsoft Teams helpers", () => {
    expect(typeof msteamsSdk.resolveControlCommandGate).toBe("function");
    expect(typeof msteamsSdk.loadOutboundMediaFromUrl).toBe("function");
  });

  it("resolves bundled extension subpaths", async () => {
    for (const { id, load } of bundledExtensionSubpathLoaders) {
      const mod = await load();
      expect(typeof mod).toBe("object");
      expect(mod, `subpath ${id} should resolve`).toBeTruthy();
    }
  });
});
