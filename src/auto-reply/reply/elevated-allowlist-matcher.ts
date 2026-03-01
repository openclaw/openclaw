import { CHAT_CHANNEL_ORDER } from "../../channels/registry.js";
import { normalizeAtHashSlug } from "../../shared/string-normalization.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";

export type ExplicitElevatedAllowField = "id" | "from" | "e164" | "name" | "username" | "tag";

const EXPLICIT_ELEVATED_ALLOW_FIELDS = new Set<ExplicitElevatedAllowField>([
  "id",
  "from",
  "e164",
  "name",
  "username",
  "tag",
]);

const SENDER_PREFIXES = [
  ...CHAT_CHANNEL_ORDER,
  INTERNAL_MESSAGE_CHANNEL,
  "user",
  "group",
  "channel",
];
const SENDER_PREFIX_RE = new RegExp(`^(${SENDER_PREFIXES.join("|")}):`, "i");

export type AllowFromFormatter = (values: string[]) => string[];

export function stripSenderPrefix(value?: string): string {
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  return trimmed.replace(SENDER_PREFIX_RE, "");
}

export function parseExplicitElevatedAllowEntry(
  entry: string,
): { field: ExplicitElevatedAllowField; value: string } | null {
  const separatorIndex = entry.indexOf(":");
  if (separatorIndex <= 0) {
    return null;
  }
  const fieldRaw = entry.slice(0, separatorIndex).trim().toLowerCase();
  if (!EXPLICIT_ELEVATED_ALLOW_FIELDS.has(fieldRaw as ExplicitElevatedAllowField)) {
    return null;
  }
  const value = entry.slice(separatorIndex + 1).trim();
  if (!value) {
    return null;
  }
  return {
    field: fieldRaw as ExplicitElevatedAllowField,
    value,
  };
}

function normalizeAllowToken(value?: string): string {
  if (!value) {
    return "";
  }
  return value.trim().toLowerCase();
}

function slugAllowToken(value?: string): string {
  return normalizeAtHashSlug(value);
}

function addTokenVariants(tokens: Set<string>, value: string): void {
  if (!value) {
    return;
  }
  tokens.add(value);
  const normalized = normalizeAllowToken(value);
  if (normalized) {
    tokens.add(normalized);
  }
}

export function addFormattedTokens(params: {
  formatAllowFrom: AllowFromFormatter;
  values: string[];
  tokens: Set<string>;
}): void {
  const formatted = params.formatAllowFrom(params.values);
  for (const entry of formatted) {
    addTokenVariants(params.tokens, entry);
  }
}

export function matchesFormattedTokens(params: {
  formatAllowFrom: AllowFromFormatter;
  value: string;
  includeStripped?: boolean;
  tokens: Set<string>;
}): boolean {
  const probeTokens = new Set<string>();
  const values = params.includeStripped
    ? [params.value, stripSenderPrefix(params.value)].filter(Boolean)
    : [params.value];
  addFormattedTokens({
    formatAllowFrom: params.formatAllowFrom,
    values,
    tokens: probeTokens,
  });
  for (const token of probeTokens) {
    if (params.tokens.has(token)) {
      return true;
    }
  }
  return false;
}

export function buildMutableTokens(value?: string): Set<string> {
  const tokens = new Set<string>();
  const trimmed = value?.trim();
  if (!trimmed) {
    return tokens;
  }
  addTokenVariants(tokens, trimmed);
  const slugged = slugAllowToken(trimmed);
  if (slugged) {
    addTokenVariants(tokens, slugged);
  }
  return tokens;
}

export function matchesMutableTokens(value: string, tokens: Set<string>): boolean {
  if (!value || tokens.size === 0) {
    return false;
  }
  const probes = new Set<string>();
  addTokenVariants(probes, value);
  const slugged = slugAllowToken(value);
  if (slugged) {
    addTokenVariants(probes, slugged);
  }
  for (const probe of probes) {
    if (tokens.has(probe)) {
      return true;
    }
  }
  return false;
}
