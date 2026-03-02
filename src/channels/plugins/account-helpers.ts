import type { OpenClawConfig } from "../../config/config.js";
import { normalizeAccountId, normalizeOptionalAccountId } from "../../routing/account-id.js";
import { resolveDefaultAgentBoundAccountId } from "../../routing/bindings.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";

export type AccountListHelpersOptions = {
  /**
   * When provided, `listAccountIds` includes the implicit "default" account
   * alongside named accounts if this callback returns true. This handles the
   * mixed-mode config pattern where a channel has both named accounts AND a
   * base-level token (e.g. `channels.discord.token` + `channels.discord.accounts`).
   *
   * Each channel implements its own check because token field names vary
   * (Telegram: `botToken`, Discord: `token`, etc.). A future standardization
   * of the channel config interface would eliminate the need for this callback.
   */
  hasBaseLevelToken?: (cfg: OpenClawConfig) => boolean;
};

/**
 * Canonical account listing and default resolution for all channels.
 * USE THIS — do not write per-channel account listing/default resolution.
 * Handles ID normalization, binding-aware default resolution, and sorted listing.
 * @see CLAUDE.md "Channel account listing" for project-level guidance.
 */
export function createAccountListHelpers(channelKey: string, options?: AccountListHelpersOptions) {
  function resolveConfiguredDefaultAccountId(cfg: OpenClawConfig): string | undefined {
    const channel = cfg.channels?.[channelKey] as Record<string, unknown> | undefined;
    const preferred = normalizeOptionalAccountId(
      typeof channel?.defaultAccount === "string" ? channel.defaultAccount : undefined,
    );
    if (!preferred) {
      return undefined;
    }
    const ids = listAccountIds(cfg);
    if (ids.some((id) => normalizeAccountId(id) === preferred)) {
      return preferred;
    }
    return undefined;
  }

  function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
    const channel = cfg.channels?.[channelKey];
    const accounts = (channel as Record<string, unknown> | undefined)?.accounts;
    if (!accounts || typeof accounts !== "object") {
      return [];
    }
    // Deduplicate by lowercase key but preserve original casing so downstream
    // config writes (e.g. patchChannelConfigForAccount) target the real key.
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const key of Object.keys(accounts as Record<string, unknown>)) {
      if (!key) {
        continue;
      }
      const lower = key.toLowerCase();
      if (!seen.has(lower)) {
        seen.add(lower);
        ids.push(key);
      }
    }
    return ids;
  }

  function listAccountIds(cfg: OpenClawConfig): string[] {
    // Only list configured accounts — do NOT merge bound IDs here.
    // Bindings that reference non-existent accounts produce a missing-token
    // error at runtime, which is the right failure mode.
    const configured = listConfiguredAccountIds(cfg);
    if (configured.length === 0) {
      return [DEFAULT_ACCOUNT_ID];
    }
    // When named accounts exist and a base-level token is available,
    // include the implicit "default" account alongside named ones.
    if (options?.hasBaseLevelToken?.(cfg)) {
      const ids = new Set(configured);
      ids.add(DEFAULT_ACCOUNT_ID);
      return Array.from(ids).toSorted((a, b) => a.localeCompare(b));
    }
    return configured.toSorted((a, b) => a.localeCompare(b));
  }

  function resolveDefaultAccountId(cfg: OpenClawConfig): string {
    // 1. Explicit defaultAccount config takes priority
    const preferred = resolveConfiguredDefaultAccountId(cfg);
    if (preferred) {
      return preferred;
    }
    // 2. Binding-aware default resolution (skips scoped bindings)
    const ids = listAccountIds(cfg);
    const boundDefault = resolveDefaultAgentBoundAccountId(cfg, channelKey);
    if (boundDefault) {
      // Normalize both sides: IDs may be lowercased raw keys (e.g. "my.bot"),
      // while boundDefault is fully normalized (e.g. "my-bot"). Return the
      // configured key (not the normalized form) so downstream resolvers like
      // resolveAccountEntry() can find the original config entry.
      const match = ids.find((id) => normalizeAccountId(id) === boundDefault);
      if (match) {
        return match;
      }
      // Bound account is not valid for this config — fall through.
    }
    // 3. Fallback: "default" if present, else first alphabetical
    if (ids.includes(DEFAULT_ACCOUNT_ID)) {
      return DEFAULT_ACCOUNT_ID;
    }
    return ids[0] ?? DEFAULT_ACCOUNT_ID;
  }

  return { listConfiguredAccountIds, listAccountIds, resolveDefaultAccountId };
}
