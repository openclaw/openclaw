import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { containsAsciiControlCharacter } from "@openclaw/normalization-core/string-normalization";

// SCP host/path normalization rejects shell metacharacters before values are
// embedded in remote-copy commands.
const SSH_TOKEN = /^[A-Za-z0-9._-]+$/;
const BRACKETED_IPV6 = /^\[[0-9A-Fa-f:.%]+\]$/;
const WHITESPACE = /\s/;
const SCP_REMOTE_PATH_UNSAFE_CHARS = /[\\'"`$;|&<>]/;

/** Normalize an optional `[user@]host` SCP target or reject unsafe tokens. */
export function normalizeScpRemoteHost(value: string | null | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (containsAsciiControlCharacter(trimmed) || WHITESPACE.test(trimmed)) {
    return undefined;
  }
  if (trimmed.startsWith("-")) {
    return undefined;
  }

  const firstAt = trimmed.indexOf("@");
  const lastAt = trimmed.lastIndexOf("@");

  let user: string | undefined;
  let host = trimmed;

  if (firstAt !== -1) {
    if (firstAt !== lastAt || firstAt === 0 || firstAt === trimmed.length - 1) {
      return undefined;
    }
    user = trimmed.slice(0, firstAt);
    host = trimmed.slice(firstAt + 1);
    if (!SSH_TOKEN.test(user)) {
      return undefined;
    }
  }

  if (host.startsWith("-") || (!SSH_TOKEN.test(host) && !BRACKETED_IPV6.test(host))) {
    return undefined;
  }

  return user ? `${user}@${host}` : host;
}

/** Return true when a value is safe for the SCP host position. */
export function isSafeScpRemoteHost(value: string | null | undefined): boolean {
  return normalizeScpRemoteHost(value) !== undefined;
}

/** Normalize an absolute remote path that is safe for SCP command construction. */
export function normalizeScpRemotePath(value: string | null | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed || !trimmed.startsWith("/")) {
    return undefined;
  }

  if (containsAsciiControlCharacter(trimmed) || SCP_REMOTE_PATH_UNSAFE_CHARS.test(trimmed)) {
    return undefined;
  }

  return trimmed;
}
