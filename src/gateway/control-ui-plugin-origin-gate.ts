// Browser-Origin gate for Control-UI plugin-cookie requests — the only
// SameSite=None ambient-credential surface in the gateway. Kept separate from
// http-auth-utils so the cookie-path security policy stays readable as one unit.
import type { IncomingMessage } from "node:http";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { checkBrowserOrigin, resolveBrowserOriginPolicy } from "./origin-check.js";

/** Gather the canonical Gateway browser-origin policy inputs for one HTTP request. */
export function resolveHttpBrowserOriginPolicy(
  req: IncomingMessage,
  cfg = getRuntimeConfig(),
): ReturnType<typeof resolveBrowserOriginPolicy> {
  return resolveBrowserOriginPolicy({ req, cfg });
}

/**
 * Cookie-specific browser-Origin gate for Control UI plugin-tab requests.
 *
 * The default plugin-tab sandbox (`allow-scripts` without `allow-same-origin`)
 * produces an opaque-origin iframe whose requests carry `Origin: null` and
 * `Sec-Fetch-Site: cross-site`. This gate must accept that legitimate path
 * while still blocking the primary CSRF vector reported in #116241: a concrete
 * cross-site Origin like `https://attacker.example`.
 *
 * Strategy:
 * - Concrete cross-site Origin → rejected via checkBrowserOrigin.
 * - `Origin: null` (sandbox opaque iframe) → accepted. This is the intended
 *   plugin-tab frame; rejecting it would break the default embed mode.
 * - No Origin header → accepted (non-browser clients or same-origin fetches
 *   that omit Origin). A valid signed cookie is still required.
 *
 * The `Sec-Fetch-Site: cross-site` signal cannot distinguish the intended
 * sandbox frame from an attacker's page (both are cross-site from the opaque
 * origin), so it is not used to block null-Origin requests. A capability-bound
 * frame authorization mechanism would be needed for deeper protection; that is
 * a product decision tracked in #116241.
 */
export function controlUiPluginCookieOriginBlocked(
  req: IncomingMessage,
  cfg: OpenClawConfig | undefined,
): boolean {
  const policy = resolveBrowserOriginPolicy({ req, cfg });
  const origin = policy.origin?.trim();
  if (!origin || origin === "null") {
    // No Origin header (non-browser client) or the opaque-origin sandbox
    // iframe — the default plugin-tab embed mode. A valid signed cookie is
    // still required either way.
    return false;
  }
  // Concrete Origin: delegate to the canonical browser-origin validator. This
  // accepts same-host, loopback, private, and allowlisted origins; rejects
  // everything else (e.g. https://attacker.example).
  return !checkBrowserOrigin({
    requestHost: policy.requestHost,
    origin,
    allowedOrigins: policy.allowedOrigins,
    allowHostHeaderOriginFallback: policy.allowHostHeaderOriginFallback,
  }).ok;
}
