/**
 * Allow-from list primitives and the compiled owner-allowlist cache used by
 * command authorization. Split from command-auth.ts to keep that file under the
 * 700-line limit; this module owns everything that turns raw configured
 * allow-from arrays into matchable owner identities.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { normalizeAnyChannelId } from "../channels/registry.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginCacheKey } from "../plugins/plugin-cache-primitives.js";

export function formatAllowFromList(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  allowFrom: Array<string | number>;
}): string[] {
  const { plugin, cfg, accountId, allowFrom } = params;
  if (!allowFrom || allowFrom.length === 0) {
    return [];
  }
  if (plugin?.config?.formatAllowFrom) {
    return plugin.config.formatAllowFrom({ cfg, accountId, allowFrom });
  }
  return normalizeStringEntries(allowFrom);
}

export function normalizeAllowFromEntry(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  value: string;
}): string[] {
  const normalized = formatAllowFromList({
    plugin: params.plugin,
    cfg: params.cfg,
    accountId: params.accountId,
    allowFrom: [params.value],
  });
  return normalized.filter((entry) => entry.trim().length > 0);
}

function isWildcardAllowFromEntry(entry: string): boolean {
  return entry.trim() === "*";
}

export function hasWildcardAllowFrom(list: string[]): boolean {
  return list.some((entry) => isWildcardAllowFromEntry(entry));
}

export function stripWildcardAllowFrom(list: string[]): string[] {
  return list.filter((entry) => !isWildcardAllowFromEntry(entry));
}
/**
 * Owner allowlists compiled once per raw config array identity. `cfg.commands
 * .ownerAllowFrom` is process-stable between reloads and plugin formatAllowFrom is
 * deterministic for a given (cfg, accountId, allowFrom), so recompiling per inbound
 * message made large ownerAllowFrom configs O(n) on every message (#50289).
 *
 * Only the config array benefits. `ctx.OwnerAllowFrom` is rebuilt per message by
 * channels (the Discord plugin's allow-list resolver returns a fresh array per
 * matched sender, for example), so that path always
 * misses and is collected right after; it stays on this helper for one code path,
 * not for cache hits. Entries are frozen because they are shared across messages.
 */
export type PreparedOwnerAllowFrom = {
  /** Wildcards dropped and duplicates collapsed once at prepare time. */
  stripped: readonly string[];
  strippedSet: ReadonlySet<string>;
};

/**
 * Config identity is the outer key because plugin formatAllowFrom receives the whole
 * config, and shallow config merges (`{...cfg, ...}`) hand a new config object the
 * same nested ownerAllowFrom array. Keying on the array alone would let one config
 * read normalization performed under another — a wrong-grant risk on an authorization
 * path. Both levels are weak, so a replaced config or array is collectable.
 *
 * Consequence: mutating a configured array in place is no longer observed mid-process.
 * Runtime reads canonical config and reloads produce fresh objects, so that is the
 * intended contract rather than an accident.
 */
const preparedOwnerAllowFrom = new WeakMap<
  OpenClawConfig,
  // Provider filtering and plugin/account formatting produce different lists from one
  // raw array; keys stay bounded by the providers x accounts actually seen.
  WeakMap<Array<string | number>, Map<string, PreparedOwnerAllowFrom>>
>();

const EMPTY_PREPARED_OWNER_ALLOW_FROM: PreparedOwnerAllowFrom = {
  stripped: Object.freeze<string[]>([]),
  strippedSet: new Set<string>(),
};

/** Collapses an already-resolved list. Used for per-message channel-derived owners. */
export function prepareStrippedList(list: readonly string[]): PreparedOwnerAllowFrom {
  if (list.length === 0) {
    return EMPTY_PREPARED_OWNER_ALLOW_FROM;
  }
  const stripped = Object.freeze(Array.from(new Set(list)));
  return { stripped, strippedSet: new Set(stripped) };
}

export function prepareOwnerAllowFrom(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  providerId?: ChannelId;
  allowFrom?: Array<string | number>;
}): PreparedOwnerAllowFrom {
  const raw = params.allowFrom ?? params.cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(raw) || raw.length === 0) {
    return EMPTY_PREPARED_OWNER_ALLOW_FROM;
  }
  let byArray = preparedOwnerAllowFrom.get(params.cfg);
  if (!byArray) {
    byArray = new WeakMap();
    preparedOwnerAllowFrom.set(params.cfg, byArray);
  }
  let scopes = byArray.get(raw);
  if (!scopes) {
    scopes = new Map();
    byArray.set(raw, scopes);
  }
  // accountId is operator-supplied, so encode dimensions through the shared
  // structured key helper rather than a separator a value could itself contain.
  const key = createPluginCacheKey([params.providerId, params.plugin?.id, params.accountId]);
  const cached = scopes.get(key);
  if (cached) {
    return cached;
  }
  const stripped = Object.freeze(
    Array.from(new Set(stripWildcardAllowFrom(resolveOwnerAllowFromList(params)))),
  );
  const prepared: PreparedOwnerAllowFrom = {
    stripped,
    strippedSet: new Set(stripped),
  };
  scopes.set(key, prepared);
  return prepared;
}

function resolveOwnerAllowFromList(params: {
  plugin?: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId?: string | null;
  providerId?: ChannelId;
  allowFrom?: Array<string | number>;
}): string[] {
  const raw = params.allowFrom ?? params.cfg.commands?.ownerAllowFrom;
  if (!Array.isArray(raw) || raw.length === 0) {
    return [];
  }
  const filtered: string[] = [];
  for (const entry of raw) {
    const trimmed = normalizeOptionalString(String(entry ?? "")) ?? "";
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex > 0) {
      const prefix = trimmed.slice(0, separatorIndex);
      const channel = normalizeAnyChannelId(prefix);
      if (channel) {
        // Channel-prefixed entries require a known matching provider; webchat leaves it unset.
        if (!params.providerId || channel !== params.providerId) {
          continue;
        }
        const remainder = trimmed.slice(separatorIndex + 1).trim();
        if (remainder) {
          filtered.push(remainder);
        }
        continue;
      }
    }
    filtered.push(trimmed);
  }
  return formatAllowFromList({
    plugin: params.plugin,
    cfg: params.cfg,
    accountId: params.accountId,
    allowFrom: filtered,
  });
}
