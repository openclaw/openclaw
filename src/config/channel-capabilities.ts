import { normalizeChannelId } from "../channels/plugins/index.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./config.js";
import type { SlackCapabilitiesConfig } from "./types.slack.js";
import type { TelegramCapabilitiesConfig } from "./types.telegram.js";

type CapabilitiesConfig = TelegramCapabilitiesConfig | SlackCapabilitiesConfig;

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

function normalizeCapabilities(capabilities: CapabilitiesConfig | undefined): string[] | undefined {
  if (isStringArray(capabilities)) {
    const normalized = capabilities.map((entry) => entry.trim()).filter(Boolean);
    return normalized.length > 0 ? normalized : undefined;
  }

  // Handle object-format capabilities (e.g., { inlineButtons: "dm" }).
  // Channel-specific handlers (like resolveTelegramInlineButtonsScope) process the detailed scope,
  // but we also surface known capability keys as string flags so the agent system-prompt can see them.
  if (capabilities && typeof capabilities === "object" && !Array.isArray(capabilities)) {
    const result: string[] = [];
    const cap = capabilities as Record<string, unknown>;
    // inlineButtons: "dm" | "group" | "all" | "allowlist" → surface as "inlinebuttons"
    if (cap["inlineButtons"] && cap["inlineButtons"] !== "off" && cap["inlineButtons"] !== false) {
      result.push("inlinebuttons");
    }
    return result.length > 0 ? result : undefined;
  }

  return undefined;
}

function resolveAccountCapabilities(params: {
  cfg?: { accounts?: Record<string, { capabilities?: CapabilitiesConfig }> } & {
    capabilities?: CapabilitiesConfig;
  };
  accountId?: string | null;
}): string[] | undefined {
  const cfg = params.cfg;
  if (!cfg) {
    return undefined;
  }
  const normalizedAccountId = normalizeAccountId(params.accountId);

  const accounts = cfg.accounts;
  if (accounts && typeof accounts === "object") {
    const match = resolveAccountEntry(accounts, normalizedAccountId);
    if (match) {
      return normalizeCapabilities(match.capabilities) ?? normalizeCapabilities(cfg.capabilities);
    }
  }

  return normalizeCapabilities(cfg.capabilities);
}

export function resolveChannelCapabilities(params: {
  cfg?: Partial<OpenClawConfig>;
  channel?: string | null;
  accountId?: string | null;
}): string[] | undefined {
  const cfg = params.cfg;
  const channel = normalizeChannelId(params.channel);
  if (!cfg || !channel) {
    return undefined;
  }

  const channelsConfig = cfg.channels as Record<string, unknown> | undefined;
  const channelConfig = (channelsConfig?.[channel] ?? (cfg as Record<string, unknown>)[channel]) as
    | {
        accounts?: Record<string, { capabilities?: CapabilitiesConfig }>;
        capabilities?: CapabilitiesConfig;
      }
    | undefined;
  return resolveAccountCapabilities({
    cfg: channelConfig,
    accountId: params.accountId,
  });
}
