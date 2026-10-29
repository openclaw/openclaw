import { captureSecretRedactionRegistrySnapshot } from "../logging/secret-redaction-registry.js";
import { containsSecretSentinel } from "../secrets/sentinel.js";

// Only fixed protocol paths are safe to disclose: custom paths can contain bearer credentials.
const DISPLAYABLE_ENDPOINT_PATHS = new Set([
  "/",
  "/v1",
  "/responses",
  "/v1/responses",
  "/backend-api/codex",
  "/backend-api/codex/responses",
  "/messages",
  "/v1/messages",
  "/chat/completions",
  "/v1/chat/completions",
]);

/** Bounded endpoint display for status; never retains URL credentials or custom paths. */
export function formatModelEndpointUrl(rawUrl: string): string | undefined {
  if (rawUrl.length > 8192) {
    return undefined;
  }
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      return undefined;
    }
    // Hostnames are case-normalized by URL parsing. Suppress the whole endpoint
    // when its origin contains a credential; redacting it would invent a destination.
    const hostname = url.hostname.toLowerCase();
    if (
      containsSecretSentinel(hostname) ||
      captureSecretRedactionRegistrySnapshot().values.some(
        (secret) => secret.length > 0 && hostname.includes(secret.toLowerCase()),
      )
    ) {
      return undefined;
    }
    const pathname = url.pathname.replace(/\/$/, "") || "/";
    const endpoint =
      url.origin +
      (DISPLAYABLE_ENDPOINT_PATHS.has(pathname)
        ? pathname === "/"
          ? ""
          : pathname
        : "/[path hidden]");
    return endpoint.length <= 512 ? endpoint : undefined;
  } catch {
    return undefined;
  }
}
