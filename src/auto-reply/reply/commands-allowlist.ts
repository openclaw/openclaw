import { resolveExplicitConfigWriteTarget } from "../../channels/plugins/config-writes.js";
import { listPairingChannels } from "../../channels/plugins/pairing.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { normalizeChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  readConfigFileSnapshot,
  validateConfigObjectWithPlugins,
  writeConfigFile,
} from "../../config/config.js";
import { resolveTelegramAccount } from "../../telegram/accounts.js";
import { isBlockedObjectKey } from "../../infra/prototype-keys.js";
import {
  addChannelAllowFromStoreEntry,
  readChannelAllowFromStoreSync,
  removeChannelAllowFromStoreEntry,
} from "../../pairing/pairing-store.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../../routing/session-key.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import { rejectUnauthorizedCommand, requireCommandFlagEnabled } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { resolveConfigWriteDeniedText } from "./config-write-authorization.js";

type AllowlistScope = "dm" | "group" | "all";
type AllowlistAction = "list" | "add" | "remove";
type AllowlistTarget = "both" | "config" | "store";

const CHANNEL_SUPPORTS_STORE = new Set<ChannelId>(["telegram"]);
const CHANNEL_SUPPORTS_GROUP_OVERRIDES = new Set<ChannelId>(["telegram"]);

function parseAllowlistCommand(value: string): AllowlistCommand | null {
  const normalized = value.trim();
  if (!normalized.startsWith("/allowlist") && !normalized.startsWith("/allow")) {
    return null;
  }
  const rest = normalized.replace(/^\/allow(?:list)?/, "").trim();
  if (!rest) {
    return { action: "list", scope: "all", target: "both", resolve: false };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { action: "list", scope: "all", target: "both", resolve: false };
  }

  let action: AllowlistAction = "list";
  let scope: AllowlistScope = "all";
  let target: AllowlistTarget = "both";
  let entry: string | undefined;
  let channelId: ChannelId | null | undefined;
  let accountId: string | null | undefined;
  let resolve = false;

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    if (token === "dm" || token === "group" || token === "all") {
      scope = token;
      i++;
    } else if (token === "config" || token === "store" || token === "both") {
      target = token;
      i++;
    } else if (token === "--resolve" || token === "-r") {
      resolve = true;
      i++;
    } else if (token === "--channel" || token === "-c") {
      channelId = normalizeChannelId(tokens[i + 1]) ?? null;
      i += 2;
    } else if (token === "--account" || token === "-a") {
      accountId = tokens[i + 1] ?? null;
      i += 2;
    } else if (token === "add" || token === "remove") {
      action = token;
      i++;
    } else if (token === "list") {
      action = "list";
      i++;
    } else if (action !== "list" && !entry) {
      entry = token;
      i++;
    } else {
      return { action: "error", message: `Unknown argument: ${token}` };
    }
  }

  if ((action === "add" || action === "remove") && !entry) {
    return { action: "error", message: `Missing entry value for ${action} action.` };
  }

  return {
    action,
    scope,
    target,
    entry: entry!,
    resolve,
    channelId,
    accountId,
  };
}

type AllowlistCommand =
  | {
      action: "list";
      scope: AllowlistScope;
      target: AllowlistTarget;
      resolve: boolean;
      channelId?: ChannelId | null;
      accountId?: string | null;
    }
  | {
      action: "add" | "remove";
      scope: AllowlistScope;
      target: AllowlistTarget;
      entry: string;
      channelId?: ChannelId | null;
      accountId?: string | null;
    }
  | { action: "error"; message: string };

function resolveChannelAllowFromPaths(
  channelId: ChannelId,
  scope: AllowlistScope,
): string[] | null {
  if (channelId !== "telegram") {
    return null;
  }
  if (scope === "dm" || scope === "all") {
    return ["allowFrom"];
  }
  return ["groupAllowFrom"];
}

function formatEntryList(values: string[]): string {
  if (values.length === 0) {
    return "(empty)";
  }
  return values.join(", ");
}

async function handleAllowlistStoreUpdate(params: {
  action: "add" | "remove";
  channelId: ChannelId;
  entry: string;
  accountId: string;
}) {
  const storeEntry = {
    channel: params.channelId,
    entry: params.entry,
    accountId: params.accountId,
  };
  if (params.action === "add") {
    await addChannelAllowFromStoreEntry(storeEntry);
    return;
  }

  await removeChannelAllowFromStoreEntry(storeEntry);
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    await removeChannelAllowFromStoreEntry({
      channel: params.channelId,
      entry: params.entry,
    });
  }
}

function resolveAccountTarget(
  parsed: Record<string, unknown>,
  channelId: ChannelId,
  accountId?: string | null,
) {
  const channels = (parsed.channels ??= {}) as Record<string, unknown>;
  const channel = (channels[channelId] ??= {}) as Record<string, unknown>;
  const normalizedAccountId = normalizeAccountId(accountId);
  if (isBlockedObjectKey(normalizedAccountId)) {
    return {
      target: channel,
      pathPrefix: `channels.${channelId}`,
      accountId: DEFAULT_ACCOUNT_ID,
    };
  }
  const hasAccounts = Boolean(channel.accounts && typeof channel.accounts === "object");
  const useAccount = normalizedAccountId !== DEFAULT_ACCOUNT_ID || hasAccounts;
  if (!useAccount) {
    return {
      target: channel,
      pathPrefix: `channels.${channelId}`,
      accountId: normalizedAccountId,
    };
  }
  const accounts = (channel.accounts ??= {}) as Record<string, unknown>;
  const existingAccount = Object.hasOwn(accounts, normalizedAccountId)
    ? accounts[normalizedAccountId]
    : undefined;
  if (!existingAccount || typeof existingAccount !== "object") {
    accounts[normalizedAccountId] = {};
  }
  const account = accounts[normalizedAccountId] as Record<string, unknown>;
  return {
    target: account,
    pathPrefix: `channels.${channelId}.accounts.${normalizedAccountId}`,
    accountId: normalizedAccountId,
  };
}

function getNestedValue(root: Record<string, unknown>, path: string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function ensureNestedObject(
  root: Record<string, unknown>,
  path: string[],
): Record<string, unknown> {
  let current = root;
  for (const key of path) {
    const existing = current[key];
    if (!existing || typeof existing !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  return current;
}

function setNestedValue(root: Record<string, unknown>, path: string[], value: unknown) {
  if (path.length === 0) {
    return;
  }
  if (path.length === 1) {
    root[path[0]] = value;
    return;
  }
  const parent = ensureNestedObject(root, path.slice(0, -1));
  parent[path[path.length - 1]] = value;
}

function normalizeAllowFrom(params: {
  cfg: OpenClawConfig;
  channelId: ChannelId;
  accountId?: string | null;
  values: string[];
}): string[] {
  return normalizeStringEntries(params.values);
}

export const handleAllowlistCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseAllowlistCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  if (parsed.action === "error") {
    return { shouldContinue: false, reply: { text: `⚠️ ${parsed.message}` } };
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/allowlist");
  if (unauthorized) {
    return unauthorized;
  }

  const channelId =
    normalizeChannelId(parsed.channelId) ??
    params.command.channelId ??
    "telegram";
  const supportsStore = CHANNEL_SUPPORTS_STORE.has(channelId);
  const scope = parsed.scope;

  if (parsed.action === "list") {
    const accountId = normalizeOptionalAccountId(parsed.accountId) as string | null;
    const cfg = params.cfg;

    let dmAllowFrom: string[] = [];
    let groupAllowFrom: string[] = [];
    let dmPolicy: string | undefined;
    let groupPolicy: string | undefined;
    let storeAllowFrom: string[] = [];

    if (channelId === "telegram") {
      const account = resolveTelegramAccount({ cfg, accountId });
      const config = account.config;
      dmAllowFrom = (config.allowFrom ?? []).map(String);
      groupAllowFrom = (config.groupAllowFrom ?? []).map(String);
      dmPolicy = config.dmPolicy;
      groupPolicy = config.groupPolicy;
    }

    if (supportsStore) {
      storeAllowFrom = readChannelAllowFromStoreSync(channelId, process.env, accountId ?? undefined);
    }

    const dmDisplay = normalizeAllowFrom({
      cfg: params.cfg,
      channelId,
      accountId,
      values: dmAllowFrom,
    });
    const groupDisplay = normalizeAllowFrom({
      cfg: params.cfg,
      channelId,
      accountId,
      values: groupAllowFrom,
    });

    const lines: string[] = ["🧾 Allowlist"];
    lines.push(`Channel: ${channelId}${accountId ? ` (account ${accountId})` : ""}`);
    if (dmPolicy) {
      lines.push(`DM policy: ${dmPolicy}`);
    }
    if (groupPolicy) {
      lines.push(`Group policy: ${groupPolicy}`);
    }

    const showDm = scope === "dm" || scope === "all";
    const showGroup = scope === "group" || scope === "all";
    if (showDm) {
      lines.push(`DM allowFrom (config): ${formatEntryList(dmDisplay)}`);
    }
    if (supportsStore && storeAllowFrom.length > 0) {
      const storeLabel = normalizeAllowFrom({
        cfg: params.cfg,
        channelId,
        accountId,
        values: storeAllowFrom,
      });
      lines.push(`Paired allowFrom (store): ${formatEntryList(storeLabel)}`);
    }
    if (showGroup) {
      if (groupAllowFrom.length > 0) {
        lines.push(`Group allowFrom (config): ${formatEntryList(groupDisplay)}`);
      }
    }

    return { shouldContinue: false, reply: { text: lines.join("\n") } };
  }

  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/allowlist edits",
    configKey: "config",
    disabledVerb: "are",
  });
  if (disabled) {
    return disabled;
  }

  const shouldUpdateConfig = parsed.target !== "store";
  const shouldTouchStore = parsed.target !== "config" && listPairingChannels().includes(channelId);

  if (shouldUpdateConfig) {
    const allowlistPath = resolveChannelAllowFromPaths(channelId, scope);
    if (!allowlistPath) {
      return {
        shouldContinue: false,
        reply: { text: `⚠️ ${channelId} does not support ${scope} allowlist configuration.` },
      };
    }
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
      return {
        shouldContinue: false,
        reply: { text: "⚠️ Config file is invalid; fix it before using /allowlist." },
      };
    }
    const parsedConfig = structuredClone(snapshot.parsed as Record<string, unknown>);
    const { target, pathPrefix, accountId: resolvedAccountId } = resolveAccountTarget(
      parsedConfig,
      channelId,
      parsed.accountId,
    );

    const existingValue = getNestedValue(target as Record<string, unknown>, allowlistPath);
    let allowFrom = Array.isArray(existingValue) ? [...existingValue] : [];
    const entry = parsed.entry!.trim();

    if (parsed.action === "add") {
      if (!allowFrom.includes(entry)) {
        allowFrom.push(entry);
      }
    } else {
      allowFrom = allowFrom.filter((v) => v !== entry);
    }

    setNestedValue(parsedConfig, [...pathPrefix.split("."), ...allowlistPath], allowFrom);
    const validated = await validateConfigObjectWithPlugins(parsedConfig);
    if (!validated.ok) {
      const issue = validated.issues[0];
      return {
        shouldContinue: false,
        reply: { text: `⚠️ Config invalid after allowlist change (${issue.path}: ${issue.message}).` },
      };
    }
    const denied = resolveConfigWriteDeniedText({
      cfg: params.cfg,
      channelId,
      accountId: resolvedAccountId,
      target: resolveExplicitConfigWriteTarget({ channelId, accountId: resolvedAccountId }),
    });
    if (denied) {
      return { shouldContinue: false, reply: { text: denied } };
    }
    await writeConfigFile(validated.config);
  }

  if (shouldTouchStore && parsed.entry) {
    await handleAllowlistStoreUpdate({
      action: parsed.action,
      channelId,
      entry: parsed.entry,
      accountId: normalizeAccountId(parsed.accountId),
    });
  }

  const verb = parsed.action === "add" ? "Added" : "Removed";
  const targets = [];
  if (shouldUpdateConfig) {
    targets.push("config");
  }
  if (shouldTouchStore) {
    targets.push("paired store");
  }
  return {
    shouldContinue: false,
    reply: { text: `${verb} \`${parsed.entry}\` from ${targets.join(" and ")}.` },
  };
};
