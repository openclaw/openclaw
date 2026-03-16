import type { ConfigWriteTarget } from "../channels/plugins/config-writes.js";
import type { ChannelAllowlistAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelId } from "../channels/plugins/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";

type AllowlistConfigPaths = {
  readPaths: string[][];
  writePath: string[];
  cleanupPaths?: string[][];
};

function resolveAccountScopedWriteTarget(
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
      writeTarget: { kind: "channel", scope: { channelId } } as const satisfies ConfigWriteTarget,
    };
  }
  const hasAccounts = Boolean(channel.accounts && typeof channel.accounts === "object");
  const useAccount = normalizedAccountId !== DEFAULT_ACCOUNT_ID || hasAccounts;
  if (!useAccount) {
    return {
      target: channel,
      pathPrefix: `channels.${channelId}`,
      writeTarget: { kind: "channel", scope: { channelId } } as const satisfies ConfigWriteTarget,
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
    writeTarget: {
      kind: "account",
      scope: { channelId, accountId: normalizedAccountId },
    } as const satisfies ConfigWriteTarget,
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

function deleteNestedValue(root: Record<string, unknown>, path: string[]) {
  if (path.length === 0) {
    return;
  }
  if (path.length === 1) {
    delete root[path[0]];
    return;
  }
  const parent = getNestedValue(root, path.slice(0, -1));
  if (!parent || typeof parent !== "object") {
    return;
  }
  delete (parent as Record<string, unknown>)[path[path.length - 1]];
}

function applyAccountScopedAllowlistConfigEdit(params: {
  parsedConfig: Record<string, unknown>;
  channelId: ChannelId;
  accountId?: string | null;
  action: "add" | "remove";
  entry: string;
  normalize: (values: Array<string | number>) => string[];
  paths: AllowlistConfigPaths;
}): NonNullable<Awaited<ReturnType<NonNullable<ChannelAllowlistAdapter["applyConfigEdit"]>>>> {
  const resolvedTarget = resolveAccountScopedWriteTarget(
    params.parsedConfig,
    params.channelId,
    params.accountId,
  );
  const existing: string[] = [];
  for (const path of params.paths.readPaths) {
    const existingRaw = getNestedValue(resolvedTarget.target, path);
    if (!Array.isArray(existingRaw)) {
      continue;
    }
    for (const entry of existingRaw) {
      const value = String(entry).trim();
      if (!value || existing.includes(value)) {
        continue;
      }
      existing.push(value);
    }
  }

  const normalizedEntry = params.normalize([params.entry]);
  if (normalizedEntry.length === 0) {
    return { kind: "invalid-entry" };
  }

  const existingNormalized = params.normalize(existing);
  const shouldMatch = (value: string) => normalizedEntry.includes(value);

  let changed = false;
  let next = existing;
  const configHasEntry = existingNormalized.some((value) => shouldMatch(value));
  if (params.action === "add") {
    if (!configHasEntry) {
      next = [...existing, params.entry.trim()];
      changed = true;
    }
  } else {
    const keep: string[] = [];
    for (const entry of existing) {
      const normalized = params.normalize([entry]);
      if (normalized.some((value) => shouldMatch(value))) {
        changed = true;
        continue;
      }
      keep.push(entry);
    }
    next = keep;
  }

  if (changed) {
    if (next.length === 0) {
      deleteNestedValue(resolvedTarget.target, params.paths.writePath);
    } else {
      setNestedValue(resolvedTarget.target, params.paths.writePath, next);
    }
    for (const path of params.paths.cleanupPaths ?? []) {
      deleteNestedValue(resolvedTarget.target, path);
    }
  }

  return {
    kind: "ok",
    changed,
    pathLabel: `${resolvedTarget.pathPrefix}.${params.paths.writePath.join(".")}`,
    writeTarget: resolvedTarget.writeTarget,
  };
}

/** Build the default account-scoped allowlist editor used by channel plugins with config-backed lists. */
export function buildAccountScopedAllowlistConfigEditor(params: {
  channelId: ChannelId;
  normalize: (params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    values: Array<string | number>;
  }) => string[];
  resolvePaths: (scope: "dm" | "group") => AllowlistConfigPaths | null;
}): NonNullable<ChannelAllowlistAdapter["applyConfigEdit"]> {
  return ({ cfg, parsedConfig, accountId, scope, action, entry }) => {
    const paths = params.resolvePaths(scope);
    if (!paths) {
      return null;
    }
    return applyAccountScopedAllowlistConfigEdit({
      parsedConfig,
      channelId: params.channelId,
      accountId,
      action,
      entry,
      normalize: (values) => params.normalize({ cfg, accountId, values }),
      paths,
    });
  };
}
