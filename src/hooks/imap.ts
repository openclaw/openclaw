/**
 * IMAP Hook Configuration
 *
 * Defaults, type definitions, and config resolution for the himalaya-based
 * IMAP email watcher integration.
 */

import { type OpenClawConfig, DEFAULT_GATEWAY_PORT, resolveGatewayPort } from "../config/config.js";
import { normalizeHooksPath } from "./gmail.js";

export const DEFAULT_IMAP_FOLDER = "INBOX";
export const DEFAULT_IMAP_POLL_INTERVAL_SECONDS = 20;
export const DEFAULT_IMAP_MAX_BYTES = 20_000;
export const DEFAULT_IMAP_QUERY = "not flag Seen";
export const MIN_IMAP_POLL_INTERVAL_SECONDS = 5;

export type ImapHookOverrides = {
  account?: string;
  folder?: string;
  pollIntervalSeconds?: number;
  includeBody?: boolean;
  maxBytes?: number;
  markSeen?: boolean;
  hookUrl?: string;
  hookToken?: string;
  himalayaConfig?: string;
  query?: string;
};

export type ImapHookRuntimeConfig = {
  account: string;
  folder: string;
  pollIntervalSeconds: number;
  includeBody: boolean;
  maxBytes: number;
  markSeen: boolean;
  hookUrl: string;
  hookToken: string;
  himalayaConfig?: string;
  query: string;
};

export function buildDefaultImapHookUrl(
  hooksPath?: string,
  port: number = DEFAULT_GATEWAY_PORT,
): string {
  const basePath = normalizeHooksPath(hooksPath);
  return `http://127.0.0.1:${port}${basePath}/imap`;
}

export function resolveImapHookRuntimeConfig(
  cfg: OpenClawConfig,
  overrides: ImapHookOverrides,
): { ok: true; value: ImapHookRuntimeConfig } | { ok: false; error: string } {
  const hooks = cfg.hooks;
  const imap = hooks?.imap;
  const hookToken = overrides.hookToken ?? hooks?.token ?? "";
  if (!hookToken) {
    return { ok: false, error: "hooks.token missing (needed for imap hook)" };
  }

  const account = overrides.account ?? imap?.account ?? "";
  if (!account) {
    return { ok: false, error: "imap account required" };
  }

  const folder = overrides.folder ?? imap?.folder ?? DEFAULT_IMAP_FOLDER;

  const pollRaw = overrides.pollIntervalSeconds ?? imap?.pollIntervalSeconds;
  const pollIntervalSeconds =
    typeof pollRaw === "number" && Number.isFinite(pollRaw) && pollRaw > 0
      ? Math.max(MIN_IMAP_POLL_INTERVAL_SECONDS, Math.floor(pollRaw))
      : DEFAULT_IMAP_POLL_INTERVAL_SECONDS;

  const includeBody = overrides.includeBody ?? imap?.includeBody ?? true;

  const maxBytesRaw = overrides.maxBytes ?? imap?.maxBytes;
  const maxBytes =
    typeof maxBytesRaw === "number" && Number.isFinite(maxBytesRaw) && maxBytesRaw > 0
      ? Math.floor(maxBytesRaw)
      : DEFAULT_IMAP_MAX_BYTES;

  const markSeen = overrides.markSeen ?? imap?.markSeen ?? true;

  const hookUrl =
    overrides.hookUrl ??
    imap?.hookUrl ??
    buildDefaultImapHookUrl(hooks?.path, resolveGatewayPort(cfg));

  const himalayaConfig = overrides.himalayaConfig ?? imap?.himalayaConfig;
  const query = overrides.query ?? imap?.query ?? DEFAULT_IMAP_QUERY;

  return {
    ok: true,
    value: {
      account,
      folder,
      pollIntervalSeconds,
      includeBody,
      maxBytes,
      markSeen,
      hookUrl,
      hookToken,
      himalayaConfig: himalayaConfig?.trim() || undefined,
      query,
    },
  };
}
