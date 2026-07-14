// Control UI plugin-tab cookie auth lets an authenticated UI open gateway-auth plugin iframes.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { isOperatorScope, type OperatorScope } from "./operator-scopes.js";

const CONTROL_UI_PLUGIN_AUTH_COOKIE = "__openclaw_plugin_tab_auth";
const CONTROL_UI_PLUGIN_AUTH_COOKIE_SCOPE = "plugin-tab";
const CONTROL_UI_PLUGIN_AUTH_COOKIE_TTL_MS = 5 * 60 * 1000;
const controlUiPluginAuthCookieSecret = randomBytes(32);

type PluginAuthCookiePayload = {
  scope: typeof CONTROL_UI_PLUGIN_AUTH_COOKIE_SCOPE;
  scopes: OperatorScope[];
  path: string;
  generation: string;
  exp: number;
};

function signPayload(encodedPayload: string): string {
  return createHmac("sha256", controlUiPluginAuthCookieSecret)
    .update(encodedPayload)
    .digest("base64url");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function readCookieHeaderValues(header: string | string[] | undefined, name: string): string[] {
  const raw = Array.isArray(header) ? header.join(";") : header;
  const values: string[] = [];
  for (const part of raw?.split(";") ?? []) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key === name) {
      values.push(value);
    }
  }
  return values;
}

function normalizeCookiePath(path: string): string | undefined {
  try {
    return new URL(path, "http://localhost").pathname;
  } catch {
    return undefined;
  }
}

function createControlUiPluginAuthCookie(
  scopes: readonly string[],
  params: {
    path: string;
    generation: string | undefined;
    nowMs?: number;
  },
) {
  const path = normalizeCookiePath(params.path);
  if (!path || !params.generation) {
    return undefined;
  }
  const now = asDateTimestampMs(params.nowMs ?? Date.now());
  if (now === undefined) {
    return undefined;
  }
  const exp = asDateTimestampMs(now + CONTROL_UI_PLUGIN_AUTH_COOKIE_TTL_MS);
  if (exp === undefined) {
    return undefined;
  }
  const payload: PluginAuthCookiePayload = {
    scope: CONTROL_UI_PLUGIN_AUTH_COOKIE_SCOPE,
    scopes: scopes.filter(isOperatorScope),
    path,
    generation: params.generation,
    exp,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = signPayload(encodedPayload);
  return `${CONTROL_UI_PLUGIN_AUTH_COOKIE}=v1.${encodedPayload}.${sig}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.ceil(CONTROL_UI_PLUGIN_AUTH_COOKIE_TTL_MS / 1000)}`;
}

export function setControlUiPluginAuthCookie(
  res: ServerResponse,
  scopes: readonly string[],
  params: {
    paths: readonly string[];
    generation: string | undefined;
    nowMs?: number;
  },
) {
  const cookiesToAdd = [...new Set(params.paths)]
    .map((path) =>
      createControlUiPluginAuthCookie(scopes, {
        path,
        generation: params.generation,
        nowMs: params.nowMs,
      }),
    )
    .filter((cookie): cookie is string => typeof cookie === "string");
  if (cookiesToAdd.length === 0) {
    return;
  }
  const existing = typeof res.getHeader === "function" ? res.getHeader("Set-Cookie") : undefined;
  const cookies = Array.isArray(existing)
    ? [...existing, ...cookiesToAdd]
    : typeof existing === "string"
      ? [existing, ...cookiesToAdd]
      : cookiesToAdd;
  res.setHeader("Set-Cookie", cookies);
}

function cookiePathMatchesRequest(cookiePath: string, requestPath: string): boolean {
  return (
    requestPath === cookiePath || (cookiePath !== "/" && requestPath.startsWith(`${cookiePath}/`))
  );
}

export function resolveControlUiPluginAuthCookieScopes(
  req: IncomingMessage,
  params: {
    requestPath: string;
    generation: string | undefined;
    nowMs?: number;
  },
): OperatorScope[] | null {
  const now = asDateTimestampMs(params.nowMs ?? Date.now());
  if (now === undefined) {
    return null;
  }
  const requestPath = normalizeCookiePath(params.requestPath);
  if (!requestPath || !params.generation) {
    return null;
  }
  for (const value of readCookieHeaderValues(req.headers.cookie, CONTROL_UI_PLUGIN_AUTH_COOKIE)) {
    const parts = value.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") {
      continue;
    }
    const [, encodedPayload, sig] = parts;
    if (!encodedPayload || !sig || !safeEqual(sig, signPayload(encodedPayload))) {
      continue;
    }
    try {
      const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as
        | PluginAuthCookiePayload
        | undefined;
      if (
        payload?.scope !== CONTROL_UI_PLUGIN_AUTH_COOKIE_SCOPE ||
        payload.exp < now ||
        payload.generation !== params.generation ||
        !Array.isArray(payload.scopes) ||
        typeof payload.path !== "string" ||
        !cookiePathMatchesRequest(payload.path, requestPath)
      ) {
        continue;
      }
      return payload.scopes.filter(isOperatorScope);
    } catch {
      continue;
    }
  }
  return null;
}
