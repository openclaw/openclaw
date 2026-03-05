import { normalizeWhatsAppAllowFromEntries } from "../channels/plugins/normalize/whatsapp.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveIMessageAccount } from "../imessage/accounts.js";
import { normalizeAccountId } from "../routing/session-key.js";
import { resolveWhatsAppAccount } from "../web/accounts.js";

export function formatTrimmedAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return allowFrom.map((entry) => String(entry).trim()).filter(Boolean);
}

export function resolveWhatsAppConfigAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  return resolveWhatsAppAccount(params).allowFrom ?? [];
}

export function formatWhatsAppConfigAllowFromEntries(allowFrom: Array<string | number>): string[] {
  return normalizeWhatsAppAllowFromEntries(allowFrom);
}

export function resolveWhatsAppConfigDefaultTo(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string | undefined {
  const root = params.cfg.channels?.whatsapp;
  const normalized = normalizeAccountId(params.accountId);
  const account = root?.accounts?.[normalized];
  return (account?.defaultTo ?? root?.defaultTo)?.trim() || undefined;
}

export function resolveIMessageConfigAllowFrom(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string[] {
  return (resolveIMessageAccount(params).config.allowFrom ?? []).map((entry) => String(entry));
}

export function resolveIMessageConfigDefaultTo(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): string | undefined {
  return resolveIMessageAccount(params).config.defaultTo?.trim() || undefined;
}
