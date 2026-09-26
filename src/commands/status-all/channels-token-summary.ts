// Summarizes channel token/account credential fields for `openclaw status --all`.
// The display path is intentionally secret-safe unless the caller explicitly requests disclosure.

import { sha256HexPrefixCore } from "@openclaw/normalization-core/node-crypto";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { hasConfiguredUnavailableCredentialStatus } from "../../channels/account-snapshot-fields.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";

export type ChannelAccountTokenSummaryRow = {
  account: unknown;
  enabled: boolean;
  snapshot: ChannelAccountSnapshot;
};

function summarizeSources(sources: Array<string | undefined>): string {
  const counts = new Map<string, number>();
  for (const source of sources) {
    const key = source?.trim() || "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (
    [...counts.entries()]
      .toSorted((a, b) => b[1] - a[1])
      .map(([key, count]) => `${key}${count > 1 ? `×${count}` : ""}`)
      .join("+") || "unknown"
  );
}

function formatTokenHint(token: string, opts: { showSecrets: boolean }): string {
  const t = token.trim();
  if (!opts.showSecrets) {
    // Show a stable fingerprint and length so operators can compare tokens without leaking them.
    return `sha256:${sha256HexPrefixCore(t, 8)} · len ${t.length}`;
  }
  const head = sliceUtf16Safe(t, 0, 4);
  const tail = sliceUtf16Safe(t, -4);
  if (t.length <= 10) {
    return `${t} · len ${t.length}`;
  }
  return `${head}…${tail} · len ${t.length}`;
}

/** Returns the credential status sentence for enabled channel accounts, if the plugin exposes token fields. */
export function summarizeTokenConfig(params: {
  accounts: ChannelAccountTokenSummaryRow[];
  showSecrets: boolean;
}): { state: "ok" | "setup" | "warn" | null; detail: string | null } {
  const enabled = params.accounts.filter((a) => a.enabled);
  if (enabled.length === 0) {
    return { state: null, detail: null };
  }

  const accountRecs = enabled.map((a) => asRecord(a.account));
  // Token field names are plugin-owned; infer the credential mode from the fields the plugin exposes.
  const hasBotTokenField = accountRecs.some((r) => "botToken" in r);
  const hasAppTokenField = accountRecs.some((r) => "appToken" in r);
  const hasSigningSecretField = accountRecs.some(
    (r) => "signingSecret" in r || "signingSecretSource" in r || "signingSecretStatus" in r,
  );
  const hasTokenField = accountRecs.some((r) => "token" in r);

  if (!hasBotTokenField && !hasAppTokenField && !hasSigningSecretField && !hasTokenField) {
    return { state: null, detail: null };
  }

  const httpMode =
    hasBotTokenField &&
    hasSigningSecretField &&
    accountRecs.every((rec) => typeof rec.mode === "string" && rec.mode.trim() === "http");
  const unavailable = enabled.filter((a) => hasConfiguredUnavailableCredentialStatus(a.account));
  const tokenHint = (account: unknown, key: string) => {
    const value = asRecord(account)[key];
    return typeof value === "string" && value.trim()
      ? formatTokenHint(value, { showSecrets: params.showSecrets })
      : "";
  };

  if (httpMode || (hasBotTokenField && hasAppTokenField)) {
    const secondaryKey = httpMode ? "signingSecret" : "appToken";
    const secondaryLabel = httpMode ? "signing" : "app";
    const credentialLabel = httpMode ? "credentials" : "tokens";
    const need = `bot+${secondaryLabel}`;
    const hasCredential = (rec: Record<string, unknown>, key: string) =>
      Boolean(normalizeOptionalString(rec[key])) ||
      (httpMode && rec[`${key}Status`] === "available");
    const ready = enabled.filter((a) => {
      const rec = asRecord(a.account);
      return hasCredential(rec, "botToken") && hasCredential(rec, secondaryKey);
    });
    const partial = enabled.filter((a) => {
      const rec = asRecord(a.account);
      return hasCredential(rec, "botToken") !== hasCredential(rec, secondaryKey);
    });

    // HTTP reports unavailable credentials first; socket mode prioritizes incomplete pairs.
    if (unavailable.length > 0 && (httpMode || partial.length === 0)) {
      return {
        state: "warn",
        detail: `configured ${httpMode ? "http credentials" : "tokens"} unavailable in this command path · accounts ${unavailable.length}`,
      };
    }
    if (partial.length > 0) {
      return {
        state: "warn",
        detail: `partial ${credentialLabel} (need ${need}) · accounts ${partial.length}`,
      };
    }
    if (ready.length === 0) {
      return { state: "setup", detail: `no ${credentialLabel} (need ${need})` };
    }

    const botSources = summarizeSources(ready.map((a) => a.snapshot.botTokenSource ?? "none"));
    const secondarySources = summarizeSources(
      ready.map((a) => a.snapshot[httpMode ? "signingSecretSource" : "appTokenSource"] ?? "none"),
    );
    const botHint = tokenHint(ready[0]?.account, "botToken");
    const secondaryHint = tokenHint(ready[0]?.account, secondaryKey);
    const hint =
      botHint || secondaryHint
        ? ` (bot ${botHint || "?"}, ${secondaryLabel} ${secondaryHint || "?"})`
        : "";
    return {
      state: "ok",
      detail: `${credentialLabel} ok (bot ${botSources}, ${secondaryLabel} ${secondarySources})${hint} · accounts ${ready.length}/${enabled.length}`,
    };
  }

  const tokenKey = hasBotTokenField ? "botToken" : "token";
  const label = hasBotTokenField ? "bot token" : "token";
  const ready = enabled.filter((a) =>
    Boolean(normalizeOptionalString(asRecord(a.account)[tokenKey])),
  );
  if (unavailable.length > 0) {
    return {
      state: "warn",
      detail: `configured ${label} unavailable in this command path · accounts ${unavailable.length}`,
    };
  }
  if (ready.length === 0) {
    return { state: "setup", detail: `no ${label}` };
  }

  const source = hasBotTokenField
    ? "config"
    : summarizeSources(ready.map((a) => a.snapshot.tokenSource));
  const hint = tokenHint(ready[0]?.account, tokenKey);
  return {
    state: "ok",
    detail: `${label} ${source}${hint ? ` (${hint})` : ""} · accounts ${ready.length}/${enabled.length}`,
  };
}
