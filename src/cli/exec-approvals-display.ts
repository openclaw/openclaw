import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { ApprovalResolveResult } from "../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalStandingGrant } from "../../packages/gateway-protocol/src/schema/exec-approvals.js";

export const APPROVAL_ID_TOKEN_PREFIX = "id64_";

const APPROVAL_TERMINAL_UNSAFE_CHAR =
  /^[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\u115F\u1160\u3164\uFFA0]$/u;

const PENDING_APPROVAL_SUMMARY_MAX_LENGTH = 96;

export function shortenPendingApprovalSummary(value: string): string {
  if (value.length <= PENDING_APPROVAL_SUMMARY_MAX_LENGTH) {
    return value;
  }
  return `${truncateUtf16Safe(value, PENDING_APPROVAL_SUMMARY_MAX_LENGTH - 3)}...`;
}

export function escapeApprovalTextForTerminal(value: string): string {
  let escaped = "";
  for (const char of value) {
    if (char === "\\") {
      escaped += "\\\\";
      continue;
    }
    if (APPROVAL_TERMINAL_UNSAFE_CHAR.test(char)) {
      escaped += `\\u{${char.codePointAt(0)?.toString(16).toUpperCase() ?? "FFFD"}}`;
      continue;
    }
    escaped += char;
  }
  return escaped;
}

// Gateway-minted ids are UUID-shaped, but explicit ids from an agent host are
// stored verbatim, so hostile ids (ANSI escapes, controls) are possible. Show
// the raw id when it is terminal-safe; wrap only unsafe ids in a copyable
// token that `resolve` decodes.
// Leading hyphen excluded: a raw `-x`/`--flag` id could not be pasted into
// `approvals resolve <id>` without Commander eating it as an option.
const APPROVAL_ID_TERMINAL_SAFE_RE = /^[A-Za-z0-9._:][A-Za-z0-9._:-]{0,127}$/;

// Tokens encode UTF-16 code units, not UTF-8: ids are opaque JS strings and
// UTF-8 replaces lone surrogates with U+FFFD, which would let two distinct
// ids collide into one token on this remote-execution surface.
export function formatApprovalIdForTerminal(value: string): string {
  if (APPROVAL_ID_TERMINAL_SAFE_RE.test(value)) {
    return value;
  }
  return `${APPROVAL_ID_TOKEN_PREFIX}${Buffer.from(value, "utf16le").toString("base64url")}`;
}

export function decodeDisplayedApprovalId(value: string): string | null {
  if (!value.startsWith(APPROVAL_ID_TOKEN_PREFIX)) {
    return null;
  }
  const encoded = value.slice(APPROVAL_ID_TOKEN_PREFIX.length);
  if (!encoded || !/^[a-zA-Z0-9_-]+$/.test(encoded)) {
    return null;
  }
  const decoded = Buffer.from(encoded, "base64url").toString("utf16le");
  return Buffer.from(decoded, "utf16le").toString("base64url") === encoded ? decoded : null;
}

export function describeGrantState(grant: ExecApprovalStandingGrant, nowMs: number): string {
  if (grant.revokedAtMs !== null) {
    // revokedBy carries the revoking client's self-reported display name;
    // escape it visibly rather than relying on the table's silent strip.
    return `revoked${grant.revokedBy ? ` by ${escapeApprovalTextForTerminal(grant.revokedBy)}` : ""}`;
  }
  if (grant.expiresAtMs !== null && grant.expiresAtMs <= nowMs) {
    return "expired";
  }
  if (grant.expiresAtMs !== null) {
    const days = Math.max(1, Math.ceil((grant.expiresAtMs - nowMs) / 86_400_000));
    return `expires in ${days}d`;
  }
  return "until revoked";
}

export function formatResolver(approval: ApprovalResolveResult["approval"]): string {
  const resolver = approval.resolver;
  if (!resolver) {
    return "unknown resolver";
  }
  return resolver.id
    ? `${resolver.kind}:${escapeApprovalTextForTerminal(resolver.id)}`
    : resolver.kind;
}
