const SSH_TOKEN = /^[A-Za-z0-9._-]+$/;
const BRACKETED_IPV6 = /^\[[0-9A-Fa-f:.%]+\]$/;
const WHITESPACE = /\s/;

function hasControlOrWhitespace(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || WHITESPACE.test(char)) {
      return true;
    }
  }
  return false;
}

export function normalizeScpRemoteHost(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (hasControlOrWhitespace(trimmed)) {
    return undefined;
  }
  if (trimmed.startsWith("-") || trimmed.includes("/") || trimmed.includes("\\")) {
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

  if (!host || host.startsWith("-") || host.includes("@")) {
    return undefined;
  }
  if (host.includes(":") && !BRACKETED_IPV6.test(host)) {
    return undefined;
  }
  if (!SSH_TOKEN.test(host) && !BRACKETED_IPV6.test(host)) {
    return undefined;
  }

  return user ? `${user}@${host}` : host;
}

export function isSafeScpRemoteHost(value: string | null | undefined): boolean {
  return normalizeScpRemoteHost(value) !== undefined;
}
