import { normalizeAccountId } from "../routing/session-key.js";
import type { ClawdbotConfig } from "./config.js";

function normalizeCapabilities(
  capabilities: string[] | undefined,
): string[] | undefined {
  if (!capabilities) return undefined;
  const normalized = capabilities.map((entry) => entry.trim()).filter(Boolean);
  return normalized.length > 0 ? normalized : undefined;
}

function resolveAccountCapabilities(params: {
  cfg?: { accounts?: Record<string, { capabilities?: string[] }> } & {
    capabilities?: string[];
  };
  accountId?: string | null;
}): string[] | undefined {
  const cfg = params.cfg;
  if (!cfg) return undefined;
  const normalizedAccountId = normalizeAccountId(params.accountId);

  const accounts = cfg.accounts;
  if (accounts && typeof accounts === "object") {
    const direct = accounts[normalizedAccountId];
    if (direct) {
      return (
        normalizeCapabilities(direct.capabilities) ??
        normalizeCapabilities(cfg.capabilities)
      );
    }
    const matchKey = Object.keys(accounts).find(
      (key) => key.toLowerCase() === normalizedAccountId.toLowerCase(),
    );
    const match = matchKey ? accounts[matchKey] : undefined;
    if (match) {
      return (
        normalizeCapabilities(match.capabilities) ??
        normalizeCapabilities(cfg.capabilities)
      );
    }
  }

  return normalizeCapabilities(cfg.capabilities);
}

export function resolveProviderCapabilities(params: {
  cfg?: ClawdbotConfig;
  provider?: string | null;
  accountId?: string | null;
}): string[] | undefined {
  const cfg = params.cfg;
  const provider = params.provider?.trim().toLowerCase();
  if (!cfg || !provider) return undefined;

  switch (provider) {
    case "whatsapp":
      return resolveAccountCapabilities({
        cfg: cfg.whatsapp,
        accountId: params.accountId,
      });
    case "telegram":
      return resolveAccountCapabilities({
        cfg: cfg.telegram,
        accountId: params.accountId,
      });
    case "discord":
      return resolveAccountCapabilities({
        cfg: cfg.discord,
        accountId: params.accountId,
      });
    case "slack":
      return resolveAccountCapabilities({
        cfg: cfg.slack,
        accountId: params.accountId,
      });
    case "signal":
      return resolveAccountCapabilities({
        cfg: cfg.signal,
        accountId: params.accountId,
      });
    case "imessage":
      return resolveAccountCapabilities({
        cfg: cfg.imessage,
        accountId: params.accountId,
      });
    case "msteams":
      return normalizeCapabilities(cfg.msteams?.capabilities);
    default:
      return undefined;
  }
}
