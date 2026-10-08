import { expectDefined } from "@openclaw/normalization-core";
/** Handles /allowlist commands across config and pairing-store targets. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { resolveExplicitConfigWriteTarget } from "../../channels/plugins/config-writes.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { normalizeChatChannelId } from "../../channels/registry.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import {
  addChannelAllowFromStoreEntry,
  readChannelAllowFromStore,
  removeChannelAllowFromStoreEntry,
} from "../../pairing/pairing-store.js";
import { DEFAULT_ACCOUNT_ID, normalizeOptionalAccountId } from "../../routing/session-key.js";
import { resolveChannelAccountId, resolveCommandSurfaceChannel } from "./channel-context.js";
import {
  commandReply,
  rejectNonOwnerCommand,
  rejectUnauthorizedCommand,
  requireCommandFlagEnabled,
  requireGatewayClientScope,
} from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";
import { applyAllowlistConfigMutation, AutoReplyConfigMutationError } from "./config-mutations.js";
import { resolveConfigWriteDeniedText } from "./config-write-authorization.js";

type AllowlistScope = "dm" | "group" | "all";
type AllowlistAction = "list" | "add" | "remove";
type AllowlistTarget = "both" | "config" | "store";
type AllowlistCommand =
  | {
      action: "list";
      scope: AllowlistScope;
      channel?: string;
      account?: string;
      resolve?: boolean;
    }
  | {
      action: "add" | "remove";
      scope: AllowlistScope;
      channel?: string;
      account?: string;
      entry: string;
      resolve?: boolean;
      target: AllowlistTarget;
    }
  | { action: "error"; message: string };

const ACTIONS = new Set(["list", "add", "remove"]);
const SCOPES = new Set<AllowlistScope>(["dm", "group", "all"]);

function parseAllowlistCommand(raw: string): AllowlistCommand | null {
  const trimmed = raw.trim();
  const trimmedLower = normalizeOptionalLowercaseString(trimmed) ?? "";
  if (!trimmedLower.startsWith("/allowlist")) {
    return null;
  }
  const rest = trimmed.slice("/allowlist".length).trim();
  if (!rest) {
    return { action: "list", scope: "dm" };
  }

  const tokens = rest.split(/\s+/);
  let action: AllowlistAction = "list";
  let scope: AllowlistScope = "dm";
  let resolve = false;
  let target: AllowlistTarget = "both";
  const route: { channel?: string; account?: string } = {};
  const entryTokens: string[] = [];

  let i = 0;
  const firstAction = normalizeOptionalLowercaseString(tokens[i]);
  if (firstAction && ACTIONS.has(firstAction)) {
    action = firstAction as AllowlistAction;
    i += 1;
  }
  const firstScope = normalizeOptionalLowercaseString(tokens[i]);
  if (firstScope && SCOPES.has(firstScope as AllowlistScope)) {
    scope = firstScope as AllowlistScope;
    i += 1;
  }

  for (; i < tokens.length; i += 1) {
    const token = expectDefined(tokens[i], "tokens entry at i");
    const lowered = normalizeOptionalLowercaseString(token) ?? "";
    const flag = lowered.replace(/^--/u, "");
    if (flag === "resolve") {
      resolve = true;
      continue;
    }
    if (flag === "config" || flag === "store") {
      target = flag;
      continue;
    }
    if ((lowered === "--channel" || lowered === "--account") && tokens[i + 1]) {
      route[lowered === "--channel" ? "channel" : "account"] = tokens[i + 1];
      i += 1;
      continue;
    }
    const kv = token.split("=");
    if (kv.length === 2) {
      const key = normalizeOptionalLowercaseString(kv[0]);
      const value = normalizeOptionalString(kv[1]);
      if (key === "channel" || key === "account") {
        if (value) {
          route[key] = value;
        }
        continue;
      }
      const normalizedValue = normalizeOptionalLowercaseString(value);
      if (key === "scope" && normalizedValue && SCOPES.has(normalizedValue as AllowlistScope)) {
        scope = normalizedValue as AllowlistScope;
        continue;
      }
    }
    entryTokens.push(token);
  }

  const { channel, account } = route;
  if (action === "add" || action === "remove") {
    const entry = entryTokens.join(" ").trim();
    if (!entry) {
      return { action: "error", message: "Usage: /allowlist add|remove <entry>" };
    }
    return { action, scope, entry, channel, account, resolve, target };
  }

  return { action: "list", scope, channel, account, resolve };
}

function formatEntryList(entries: string[], resolved?: Map<string, string>): string {
  if (entries.length === 0) {
    return "(none)";
  }
  return entries
    .map((entry) => {
      const name = resolved?.get(entry);
      return name ? `${entry} (${name})` : entry;
    })
    .join(", ");
}

/** Command handler for listing, adding, and removing allowlist entries. */
export const handleAllowlistCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const parsed = parseAllowlistCommand(params.command.commandBodyNormalized);
  if (!parsed) {
    return null;
  }
  if (parsed.action === "error") {
    return commandReply(`⚠️ ${parsed.message}`);
  }
  const unauthorized = rejectUnauthorizedCommand(params, "/allowlist");
  if (unauthorized) {
    return unauthorized;
  }
  if (parsed.action !== "list") {
    const nonOwner = rejectNonOwnerCommand(params, "/allowlist");
    if (nonOwner) {
      return nonOwner;
    }
  }
  const assertOwnerCurrent = params.command.assertOwnerCurrent;

  const channelId =
    normalizeChatChannelId(parsed.channel) ??
    params.command.channelId ??
    normalizeChatChannelId(params.command.channel);
  if (!channelId) {
    return commandReply("⚠️ Unknown channel. Add channel=<id> to the command.");
  }
  if (normalizeOptionalString(parsed.account) && !normalizeOptionalAccountId(parsed.account)) {
    return commandReply(
      "⚠️ Invalid account id. Reserved keys (__proto__, constructor, prototype) are blocked.",
    );
  }
  const accountId =
    normalizeOptionalAccountId(parsed.account) ||
    normalizeOptionalString(getChannelPlugin(channelId)?.config.defaultAccountId?.(params.cfg)) ||
    normalizeOptionalAccountId(params.ctx.AccountId) ||
    DEFAULT_ACCOUNT_ID;
  const originChannelId =
    params.command.channelId ?? normalizeChatChannelId(resolveCommandSurfaceChannel(params));
  const originAccountId = resolveChannelAccountId({
    cfg: params.cfg,
    ctx: params.ctx,
    command: params.command,
  });
  const plugin = getChannelPlugin(channelId);

  if (parsed.action === "list") {
    const supportsStore = Boolean(plugin?.pairing);
    if (!plugin?.allowlist?.readConfig && !supportsStore) {
      return commandReply(`⚠️ ${channelId} does not expose allowlist configuration.`);
    }
    let storeAllowFrom: string[] = [];
    let storeReadFailed = false;
    if (supportsStore) {
      try {
        storeAllowFrom = await readChannelAllowFromStore(channelId, process.env, accountId);
      } catch {
        storeReadFailed = true;
      }
    }
    const configState =
      (await getChannelPlugin(channelId)?.allowlist?.readConfig?.({
        cfg: params.cfg,
        accountId,
      })) ?? {};

    const dmAllowFrom = (configState.dmAllowFrom ?? []).map(String);
    const groupAllowFrom = (configState.groupAllowFrom ?? []).map(String);
    const groupOverrides = (configState.groupOverrides ?? []).map((entry) => ({
      label: entry.label,
      entries: entry.entries.map(String).filter(Boolean),
    }));

    const normalizeValues = (values: Array<string | number>) => {
      const currentPlugin = getChannelPlugin(channelId);
      return currentPlugin?.config.formatAllowFrom
        ? currentPlugin.config.formatAllowFrom({ cfg: params.cfg, accountId, allowFrom: values })
        : normalizeStringEntries(values);
    };
    const resolveNames = async (scope: "dm" | "group", entries: string[]) => {
      const resolved = await getChannelPlugin(channelId)?.allowlist?.resolveNames?.({
        cfg: params.cfg,
        accountId,
        scope,
        entries,
      });
      return new Map(
        (resolved ?? []).flatMap((entry) =>
          entry.resolved && entry.name ? [[entry.input, entry.name] as const] : [],
        ),
      );
    };
    const dmDisplay = normalizeValues(dmAllowFrom);
    const groupDisplay = normalizeValues(groupAllowFrom);
    const groupOverrideEntries = groupOverrides.flatMap((entry) => entry.entries);
    const groupOverrideDisplay = normalizeValues(groupOverrideEntries);

    const resolvedDm =
      parsed.resolve && dmDisplay.length > 0 ? await resolveNames("dm", dmDisplay) : undefined;
    const resolvedGroup =
      parsed.resolve && groupOverrideDisplay.length > 0
        ? await resolveNames("group", groupOverrideDisplay)
        : undefined;

    const lines: string[] = ["🧾 Allowlist"];
    lines.push(`Channel: ${channelId}${accountId ? ` (account ${accountId})` : ""}`);
    if (configState.dmPolicy) {
      lines.push(`DM policy: ${configState.dmPolicy}`);
    }
    if (configState.groupPolicy) {
      lines.push(`Group policy: ${configState.groupPolicy}`);
    }

    if (parsed.scope === "dm" || parsed.scope === "all") {
      lines.push(`DM allowFrom (config): ${formatEntryList(dmDisplay, resolvedDm)}`);
    }
    if (supportsStore && storeReadFailed) {
      lines.push(
        "Paired allowFrom (store): unavailable (read failed). Retry this command; if it still fails, run openclaw doctor.",
      );
    } else if (supportsStore && storeAllowFrom.length > 0) {
      lines.push(`Paired allowFrom (store): ${formatEntryList(normalizeValues(storeAllowFrom))}`);
    }
    if (parsed.scope === "group" || parsed.scope === "all") {
      if (groupAllowFrom.length > 0) {
        lines.push(`Group allowFrom (config): ${formatEntryList(groupDisplay, resolvedGroup)}`);
      }
      if (groupOverrides.length > 0) {
        lines.push("Group overrides:");
        for (const entry of groupOverrides) {
          lines.push(
            `- ${entry.label}: ${formatEntryList(normalizeValues(entry.entries), resolvedGroup)}`,
          );
        }
      }
    }

    return commandReply(lines.join("\n"));
  }

  const missingAdminScope = requireGatewayClientScope(params, {
    label: "/allowlist write",
    allowedScopes: ["operator.admin"],
    missingText: "❌ /allowlist add|remove requires operator.admin for gateway clients.",
  });
  if (missingAdminScope) {
    return missingAdminScope;
  }

  const disabled = requireCommandFlagEnabled(params.cfg, {
    label: "/allowlist edits",
    configKey: "config",
    disabledVerb: "are",
  });
  if (disabled) {
    return disabled;
  }

  if (parsed.scope === "group" && parsed.target === "store") {
    return commandReply(
      "⚠️ Pairing-store allowlist edits apply to DMs only; omit --store for groups.",
    );
  }

  // Pairing stores authorize DMs only. Group edits must stay config-scoped or a
  // group-only sender could gain or lose unrelated direct-message access.
  const shouldTouchStore =
    parsed.scope !== "group" && parsed.target !== "config" && Boolean(plugin?.pairing);
  const resolveWriteDeniedText = (
    target: Parameters<typeof resolveConfigWriteDeniedText>[0]["target"],
  ) =>
    resolveConfigWriteDeniedText({
      cfg: params.cfg,
      channel: params.command.channel,
      originChannelId,
      originAccountId,
      gatewayClientScopes: params.ctx.GatewayClientScopes,
      target,
      fallbackChannelId: channelId,
    });
  const updatePairingStore = async () => {
    const storeEntry = {
      channel: channelId,
      entry: parsed.entry,
      accountId,
      ...(assertOwnerCurrent ? { assertCurrent: assertOwnerCurrent } : {}),
    };
    const mutate =
      parsed.action === "add" ? addChannelAllowFromStoreEntry : removeChannelAllowFromStoreEntry;
    await mutate(storeEntry);
    if (parsed.action === "remove" && accountId === DEFAULT_ACCOUNT_ID) {
      const { accountId: _accountId, ...legacyEntry } = storeEntry;
      await removeChannelAllowFromStoreEntry(legacyEntry);
    }
  };

  const actionLabel = parsed.action === "add" ? "added" : "removed";
  if (parsed.target !== "store") {
    if (parsed.scope === "all") {
      return commandReply("⚠️ /allowlist add|remove requires scope dm or group.");
    }
    if (!plugin?.allowlist?.applyConfigEdit) {
      return commandReply(
        `⚠️ ${channelId} does not support ${parsed.scope} allowlist edits via /allowlist.`,
      );
    }
    const applyConfigEdit = plugin.allowlist.applyConfigEdit;
    const editScope = parsed.scope;

    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid || !snapshot.parsed || typeof snapshot.parsed !== "object") {
      return commandReply("⚠️ Config file is invalid; fix it before using /allowlist.");
    }
    const parsedConfig = structuredClone(snapshot.parsed as Record<string, unknown>);
    const editResult = await plugin.allowlist.applyConfigEdit({
      cfg: params.cfg,
      parsedConfig,
      accountId,
      scope: parsed.scope,
      action: parsed.action,
      entry: parsed.entry,
    });
    if (!editResult) {
      return commandReply(
        `⚠️ ${channelId} does not support ${parsed.scope} allowlist edits via /allowlist.`,
      );
    }
    if (editResult.kind === "invalid-entry") {
      return commandReply("⚠️ Invalid allowlist entry.");
    }
    const deniedText = resolveWriteDeniedText(editResult.writeTarget);
    if (deniedText) {
      return commandReply(deniedText);
    }
    const configChanged = editResult.changed;

    if (configChanged) {
      try {
        await applyAllowlistConfigMutation({
          cfg: params.cfg,
          accountId,
          scope: editScope,
          action: parsed.action,
          entry: parsed.entry,
          applyConfigEdit,
          assertCurrent: assertOwnerCurrent,
        });
      } catch (error) {
        if (error instanceof AutoReplyConfigMutationError) {
          return commandReply(`⚠️ ${error.message}`);
        }
        throw error;
      }
    }

    if (!configChanged && !shouldTouchStore) {
      const message = parsed.action === "add" ? "✅ Already allowlisted." : "⚠️ Entry not found.";
      return commandReply(message);
    }

    if (shouldTouchStore) {
      await updatePairingStore();
    }

    const scopeLabel = parsed.scope === "dm" ? "DM" : "group";
    const locations: string[] = [];
    if (configChanged) {
      locations.push(editResult.pathLabel);
    }
    if (shouldTouchStore) {
      locations.push("pairing store");
    }
    const targetLabel = locations.join(" + ");
    return commandReply(`✅ ${scopeLabel} allowlist ${actionLabel}: ${targetLabel}.`);
  }

  if (!shouldTouchStore) {
    return commandReply("⚠️ This channel does not support allowlist storage.");
  }

  const storeDeniedText = resolveWriteDeniedText(
    resolveExplicitConfigWriteTarget({ channelId, accountId }),
  );
  if (storeDeniedText) {
    return commandReply(storeDeniedText);
  }

  await updatePairingStore();

  return commandReply(`✅ DM allowlist ${actionLabel} in pairing store.`);
};
