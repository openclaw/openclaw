import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "./errors.js";
import { normalizeHostname } from "./net/hostname.js";

function readAllowHttp(value: string | undefined): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(value);
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isLoopbackRelayHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function normalizeApnsRelayBaseUrlWithPolicy(
  baseUrl: string,
  allowLoopbackHttpWithoutEnvOptIn: boolean,
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    if (!parsed.hostname) {
      throw new Error("host required");
    }
    // Plain HTTP is only for local relay development; production relay URLs must use TLS.
    if (parsed.protocol === "http:" && !allowLoopbackHttpWithoutEnvOptIn) {
      throw new Error(
        "http relay URLs require OPENCLAW_APNS_RELAY_ALLOW_HTTP=true (development only)",
      );
    }
    // Persisted development URLs may bypass only the current env opt-in;
    // the loopback boundary remains mandatory during every decode.
    if (parsed.protocol === "http:" && !isLoopbackRelayHostname(parsed.hostname)) {
      throw new Error("http relay URLs are limited to loopback hosts");
    }
    if (parsed.username || parsed.password) {
      throw new Error("userinfo is not allowed");
    }
    if (parsed.search || parsed.hash) {
      throw new Error("query and fragment are not allowed");
    }
    return { ok: true, value: parsed.toString().replace(/\/+$/, "") };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

/** Validate and canonicalize an APNs relay base URL for config and registration origins. */
export function normalizeApnsRelayBaseUrl(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; value: string } | { ok: false; error: string } {
  return normalizeApnsRelayBaseUrlWithPolicy(
    baseUrl,
    readAllowHttp(env.OPENCLAW_APNS_RELAY_ALLOW_HTTP),
  );
}

/** Revalidate a canonical persisted relay URL without reapplying current input policy. */
export function normalizePersistedApnsRelayBaseUrl(
  baseUrl: string,
): { ok: true; value: string } | { ok: false; error: string } {
  // Stored loopback HTTP URLs already passed the explicit development-only
  // policy before commit; decoding must survive later environment changes.
  return normalizeApnsRelayBaseUrlWithPolicy(baseUrl, true);
}
