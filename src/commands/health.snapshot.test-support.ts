import fs from "node:fs";
import type { collectGatewayHealthSnapshot } from "../gateway/health/collector.js";
import type { HealthSummary } from "../gateway/health/types.js";

export type LegacyHealthSnapshotParams = Partial<
  Omit<Parameters<typeof collectGatewayHealthSnapshot>[0], "audience">
> & {
  includeSensitive?: boolean;
};

export function createLegacyHealthSnapshotCollector(
  collectSnapshot: typeof collectGatewayHealthSnapshot,
) {
  return (params: LegacyHealthSnapshotParams = {}): Promise<HealthSummary> => {
    const { includeSensitive, probe, ...rest } = params;
    return collectSnapshot({
      ...rest,
      audience: includeSensitive === false ? "public" : "admin",
      probe: probe !== false,
    });
  };
}

export type TelegramHealthAccount = {
  accountId: string;
  token: string;
  configured: boolean;
  config: {
    proxy?: string;
    network?: Record<string, unknown>;
    apiRoot?: string;
  };
};

function getTelegramChannelConfig(cfg: Record<string, unknown>) {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return (channels?.telegram as Record<string, unknown> | undefined) ?? {};
}

export function listTelegramAccountIdsForTest(cfg: Record<string, unknown>): string[] {
  const telegram = getTelegramChannelConfig(cfg);
  const accounts = telegram.accounts as Record<string, unknown> | undefined;
  const ids: string[] = [];
  for (const accountId of Object.keys(accounts ?? {})) {
    if (accountId) {
      ids.push(accountId);
    }
  }
  return ids.length > 0 ? ids : ["default"];
}

function readTokenFromFile(tokenFile: unknown): string {
  if (typeof tokenFile !== "string" || !tokenFile.trim()) {
    return "";
  }
  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

export function resolveTelegramAccountForTest(params: {
  cfg: Record<string, unknown>;
  accountId?: string | null;
}): TelegramHealthAccount {
  const telegram = getTelegramChannelConfig(params.cfg);
  const accounts = (telegram.accounts as Record<string, Record<string, unknown>> | undefined) ?? {};
  const accountId = params.accountId?.trim() || "default";
  const channelConfig = { ...telegram };
  delete (channelConfig as { accounts?: unknown }).accounts;
  const merged = {
    ...channelConfig,
    ...accounts[accountId],
  };
  const tokenFromConfig =
    typeof merged.botToken === "string" && merged.botToken.trim() ? merged.botToken.trim() : "";
  const token =
    tokenFromConfig ||
    readTokenFromFile(merged.tokenFile) ||
    (accountId === "default" ? (process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "") : "");
  return {
    accountId,
    token,
    configured: token.length > 0,
    config: {
      ...(typeof merged.proxy === "string" && merged.proxy.trim()
        ? { proxy: merged.proxy.trim() }
        : {}),
      ...(merged.network && typeof merged.network === "object" && !Array.isArray(merged.network)
        ? { network: merged.network as Record<string, unknown> }
        : {}),
      ...(typeof merged.apiRoot === "string" && merged.apiRoot.trim()
        ? { apiRoot: merged.apiRoot.trim() }
        : {}),
    },
  };
}
