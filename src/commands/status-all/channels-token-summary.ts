// Summarizes channel token/account credential fields for `openclaw status --all`.
// The display path is intentionally secret-safe unless the caller explicitly requests disclosure.

import { sha256HexPrefixCore } from "@openclaw/normalization-core/node-crypto";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ChannelAccountInspectionResult } from "../../channels/account-inspection.js";
import { hasConfiguredUnavailableCredentialStatus } from "../../channels/account-snapshot-fields.js";

export type ChannelAccountTokenSummaryRow = Pick<
  ChannelAccountInspectionResult,
  "account" | "enabled" | "snapshot"
> & { liveCredentialAvailable?: boolean };

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

  // Accounts can select different identities and transports within one channel.
  const groups = new Map<string, ChannelAccountTokenSummaryRow[]>();
  for (const account of enabled) {
    const rec = asRecord(account.account);
    const key = JSON.stringify([normalizeOptionalString(rec.mode), rec.identity === "user"]);
    const group = groups.get(key) ?? [];
    group.push(account);
    groups.set(key, group);
  }
  if (groups.size > 1) {
    const summaries = [...groups.values()].map((accounts) =>
      summarizeTokenConfig({ accounts, showSecrets: params.showSecrets }),
    );
    const states = new Set(summaries.map((summary) => summary.state));
    return {
      state:
        states.has("warn") || (states.has("ok") && states.has("setup"))
          ? "warn"
          : states.has("ok")
            ? "ok"
            : states.has("setup")
              ? "setup"
              : null,
      detail:
        summaries
          .map((summary) => summary.detail)
          .filter(Boolean)
          .join("; ") || null,
    };
  }

  const accountRecs = enabled.map((a) => asRecord(a.account));
  const userIdentity = accountRecs[0]?.identity === "user";
  const relayMode = accountRecs[0]?.mode === "relay";
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

  const paired = !relayMode && (httpMode || (hasBotTokenField && hasAppTokenField));
  const identityLabel = userIdentity ? "user" : "bot";
  const tokenKey = userIdentity ? "userToken" : hasBotTokenField ? "botToken" : "token";
  const secondaryKey = httpMode ? "signingSecret" : "appToken";
  const secondaryLabel = httpMode ? "signing" : "app";
  const label = paired
    ? httpMode
      ? "credentials"
      : "tokens"
    : hasBotTokenField
      ? `${identityLabel} token`
      : "token";
  const need = paired ? ` (need ${identityLabel}+${secondaryLabel})` : "";
  const hasCredential = (entry: ChannelAccountTokenSummaryRow, key: string) => {
    const rec = asRecord(entry.account);
    return (
      Boolean(normalizeOptionalString(rec[key])) ||
      ((httpMode || entry.liveCredentialAvailable === true) && rec[`${key}Status`] === "available")
    );
  };
  const ready = enabled.filter((a) => {
    // Relay readiness includes plugin-owned configuration beyond the displayed token fields.
    return relayMode
      ? a.snapshot.configured === true
      : hasCredential(a, tokenKey) && (!paired || hasCredential(a, secondaryKey));
  });
  const partial = paired
    ? enabled.filter((a) => hasCredential(a, tokenKey) !== hasCredential(a, secondaryKey)).length
    : 0;

  // HTTP reports unavailable credentials first; socket mode prioritizes incomplete pairs.
  if (unavailable.length > 0 && (httpMode || partial === 0)) {
    return {
      state: "warn",
      detail: `configured ${httpMode ? "http credentials" : label} unavailable in this command path · accounts ${unavailable.length}`,
    };
  }
  if (partial > 0) {
    return { state: "warn", detail: `partial ${label}${need} · accounts ${partial}` };
  }
  if (ready.length === 0) {
    return { state: "setup", detail: relayMode ? "not configured" : `no ${label}${need}` };
  }

  const unconfigured = enabled.filter(
    (account) => account.snapshot.configured === false && !ready.includes(account),
  );
  if (unconfigured.length > 0) {
    return {
      state: "warn",
      detail: `incomplete configuration · accounts ${unconfigured.length}`,
    };
  }

  if (paired) {
    const identitySources = summarizeSources(
      ready.map((a) => a.snapshot[userIdentity ? "userTokenSource" : "botTokenSource"] ?? "none"),
    );
    const secondarySources = summarizeSources(
      ready.map((a) => a.snapshot[httpMode ? "signingSecretSource" : "appTokenSource"] ?? "none"),
    );
    const identityHint = tokenHint(ready[0]?.account, tokenKey);
    const secondaryHint = tokenHint(ready[0]?.account, secondaryKey);
    const hint =
      identityHint || secondaryHint
        ? ` (${identityLabel} ${identityHint || "?"}, ${secondaryLabel} ${secondaryHint || "?"})`
        : "";
    return {
      state: "ok",
      detail: `${label} ok (${identityLabel} ${identitySources}, ${secondaryLabel} ${secondarySources})${hint} · accounts ${ready.length}/${enabled.length}`,
    };
  }

  const source = relayMode
    ? summarizeSources(
        ready.map((a) => a.snapshot[userIdentity ? "userTokenSource" : "botTokenSource"] ?? "none"),
      )
    : hasBotTokenField
      ? "config"
      : summarizeSources(ready.map((a) => a.snapshot.tokenSource));
  const hint = tokenHint(ready[0]?.account, tokenKey);
  return {
    state: "ok",
    detail: `${label} ${source}${hint ? ` (${hint})` : ""} · accounts ${ready.length}/${enabled.length}`,
  };
}
