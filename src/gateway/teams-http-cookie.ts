import type { IncomingMessage } from "node:http";
import { isLoopbackHost } from "./net.js";

export const TEAMS_SESSION_COOKIE_NAME = "openclaw_teams_session";

function hasCookieControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

function parseCookieHeader(header: string | undefined): Map<string, string[]> {
  const cookies = new Map<string, string[]>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    const values = cookies.get(name) ?? [];
    values.push(value);
    cookies.set(name, values);
  }
  return cookies;
}

/** Reads the one opaque Teams token; duplicates fail closed to avoid proxy/parser ambiguity. */
export function readTeamsSessionCookie(req: IncomingMessage): string | undefined {
  const values = parseCookieHeader(req.headers.cookie).get(TEAMS_SESSION_COOKIE_NAME);
  if (values?.length !== 1) {
    return undefined;
  }
  const token = values[0];
  if (!token || token.length > 1_024 || hasCookieControlCharacter(token)) {
    return undefined;
  }
  return token;
}

export function isExplicitLoopbackHttpDev(params: {
  directLocalRequest: boolean;
  requestHost?: string;
  requestOrigin?: string;
}): boolean {
  if (!params.directLocalRequest || !params.requestHost || !params.requestOrigin) {
    return false;
  }
  try {
    const origin = new URL(params.requestOrigin);
    const requestHost = new URL(`http://${params.requestHost}`).hostname;
    return (
      origin.protocol === "http:" && isLoopbackHost(origin.hostname) && isLoopbackHost(requestHost)
    );
  } catch {
    return false;
  }
}

export function serializeTeamsSessionCookie(token: string, secure: boolean): string {
  const attributes = [
    `${TEAMS_SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    ...(secure ? ["Secure"] : []),
    "SameSite=Strict",
  ];
  return attributes.join("; ");
}

export function serializeExpiredTeamsSessionCookie(secure: boolean): string {
  return `${serializeTeamsSessionCookie("", secure)}; Max-Age=0`;
}
