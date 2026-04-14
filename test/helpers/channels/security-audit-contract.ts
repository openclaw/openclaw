import { loadBundledPluginPublicSurfaceSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type DiscordSecuritySurface = typeof import("@openclaw/discord/contract-api.js");
type FeishuSecuritySurface = typeof import("@openclaw/feishu/security-contract-api.js");
type SlackSecuritySurface = typeof import("@openclaw/slack/security-contract-api.js");
type SynologyChatSecuritySurface = typeof import("@openclaw/synology-chat/contract-api.js");
type TelegramSecuritySurface = typeof import("@openclaw/telegram/contract-api.js");
type ZalouserSecuritySurface = typeof import("@openclaw/zalouser/contract-api.js");

function loadDiscordSecuritySurface(): DiscordSecuritySurface {
  return loadBundledPluginPublicSurfaceSync<DiscordSecuritySurface>({
    pluginId: "discord",
    artifactBasename: "contract-api.js",
  });
}

function loadFeishuSecuritySurface(): FeishuSecuritySurface {
  return loadBundledPluginPublicSurfaceSync<FeishuSecuritySurface>({
    pluginId: "feishu",
    artifactBasename: "security-contract-api.js",
  });
}

function loadSlackSecuritySurface(): SlackSecuritySurface {
  return loadBundledPluginPublicSurfaceSync<SlackSecuritySurface>({
    pluginId: "slack",
    artifactBasename: "security-contract-api.js",
  });
}

function loadSynologyChatSecuritySurface(): SynologyChatSecuritySurface {
  return loadBundledPluginPublicSurfaceSync<SynologyChatSecuritySurface>({
    pluginId: "synology-chat",
    artifactBasename: "contract-api.js",
  });
}

function loadTelegramSecuritySurface(): TelegramSecuritySurface {
  return loadBundledPluginPublicSurfaceSync<TelegramSecuritySurface>({
    pluginId: "telegram",
    artifactBasename: "contract-api.js",
  });
}

function loadZalouserSecuritySurface(): ZalouserSecuritySurface {
  return loadBundledPluginPublicSurfaceSync<ZalouserSecuritySurface>({
    pluginId: "zalouser",
    artifactBasename: "contract-api.js",
  });
}

export const collectDiscordSecurityAuditFindings: DiscordSecuritySurface["collectDiscordSecurityAuditFindings"] =
  ((...args) =>
    loadDiscordSecuritySurface().collectDiscordSecurityAuditFindings(
      ...args,
    )) as DiscordSecuritySurface["collectDiscordSecurityAuditFindings"];

export const collectFeishuSecurityAuditFindings: FeishuSecuritySurface["collectFeishuSecurityAuditFindings"] =
  ((...args) =>
    loadFeishuSecuritySurface().collectFeishuSecurityAuditFindings(
      ...args,
    )) as FeishuSecuritySurface["collectFeishuSecurityAuditFindings"];

export const collectSlackSecurityAuditFindings: SlackSecuritySurface["collectSlackSecurityAuditFindings"] =
  ((...args) =>
    loadSlackSecuritySurface().collectSlackSecurityAuditFindings(
      ...args,
    )) as SlackSecuritySurface["collectSlackSecurityAuditFindings"];

export const collectSynologyChatSecurityAuditFindings: SynologyChatSecuritySurface["collectSynologyChatSecurityAuditFindings"] =
  ((...args) =>
    loadSynologyChatSecuritySurface().collectSynologyChatSecurityAuditFindings(
      ...args,
    )) as SynologyChatSecuritySurface["collectSynologyChatSecurityAuditFindings"];

export const collectTelegramSecurityAuditFindings: TelegramSecuritySurface["collectTelegramSecurityAuditFindings"] =
  ((...args) =>
    loadTelegramSecuritySurface().collectTelegramSecurityAuditFindings(
      ...args,
    )) as TelegramSecuritySurface["collectTelegramSecurityAuditFindings"];

export const collectZalouserSecurityAuditFindings: ZalouserSecuritySurface["collectZalouserSecurityAuditFindings"] =
  ((...args) =>
    loadZalouserSecuritySurface().collectZalouserSecurityAuditFindings(
      ...args,
    )) as ZalouserSecuritySurface["collectZalouserSecurityAuditFindings"];
