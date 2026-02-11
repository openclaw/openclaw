/**
 * Secure Fetch Wrapper
 *
 * Intercepts all fetch() calls and routes them through the secrets injection proxy.
 * This must be loaded BEFORE any other modules that make HTTP requests.
 *
 * P0 Fix: Properly handles Request objects by extracting method, headers, and body.
 */
import process from "node:process";

// Resolved lazily in installSecureFetch(); read by secureFetch() at call time.
let PROXY_URL: string | undefined;

// Store the original fetch
const originalFetch = globalThis.fetch;

/** Returns true only for valid 127.0.0.0/8 IPv4 addresses (octets 0-255). */
function isLoopbackIPv4(hostname: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!m) return false;
  const octets = [+m[1], +m[2], +m[3], +m[4]];
  return octets[0] === 127 && octets.every((o) => o >= 0 && o <= 255);
}

/**
 * Checks if a URL should bypass the proxy.
 * Only bypass for true loopback addresses, NOT host.docker.internal
 * (which would allow container to access host services without allowlist).
 */
function shouldBypassProxy(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    // Bypass loopback: localhost, IPv6 ::1, and valid IPv4 127.0.0.0/8 range
    if (hostname === "localhost" || hostname === "::1" || isLoopbackIPv4(hostname)) {
      return true;
    }
    // Also bypass requests TO the proxy itself to avoid infinite loop.
    // Compare origins (scheme+host+port) so default ports (80/443) are normalized.
    if (PROXY_URL) {
      const proxyParsed = new URL(PROXY_URL);
      if (parsed.origin === proxyParsed.origin) {
        return true;
      }
    }
  } catch {
    // Invalid URL, don't bypass
  }
  return false;
}

/**
 * Wraps fetch to route all requests through the secrets proxy.
 * Adds X-Target-URL header with the original destination.
 *
 * Properly handles both Request objects and string URLs, preserving
 * method, headers, and body from the original request.
 */
async function secureFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  // Only intercept when running inside the container (PROXY_URL is injected by Docker flow)
  if (!PROXY_URL) {
    return originalFetch(input, init);
  }

  // Extract request details based on input type
  let targetUrl: string;
  let method: string;
  let headers: Headers;
  let body: BodyInit | null | undefined;

  if (typeof input === "string") {
    targetUrl = input;
    method = init?.method || "GET";
    headers = new Headers(init?.headers);
    body = init?.body;
  } else if (input instanceof URL) {
    targetUrl = input.toString();
    method = init?.method || "GET";
    headers = new Headers(init?.headers);
    body = init?.body;
  } else if (input instanceof Request) {
    // P0 Fix: Extract all details from Request object
    targetUrl = input.url;
    // init overrides Request properties if provided
    method = init?.method || input.method;

    // Merge headers: Request headers first, then init headers override
    headers = new Headers(input.headers);
    if (init?.headers) {
      const initHeaders = new Headers(init.headers);
      initHeaders.forEach((value, key) => {
        headers.set(key, value);
      });
    }

    // Body: init.body overrides, otherwise read from Request if it has one
    if (init?.body !== undefined) {
      body = init.body;
    } else if (input.body && !input.bodyUsed) {
      // P0 Fix: Read body into ArrayBuffer for Node/undici compatibility
      // ReadableStream is not directly usable as RequestInit.body in Node
      body = await input.clone().arrayBuffer();
    } else {
      body = undefined;
    }
  } else {
    // Fallback - shouldn't happen but just in case
    return originalFetch(input, init);
  }

  // Skip proxy for local requests
  if (shouldBypassProxy(targetUrl)) {
    return originalFetch(input, init);
  }

  // Add proxy headers
  headers.set("X-Target-URL", targetUrl);
  const proxyAuthToken = process.env.PROXY_AUTH_TOKEN;
  if (proxyAuthToken) {
    headers.set("X-Proxy-Token", proxyAuthToken);
  }

  // Route through proxy, preserving all request details
  // Spread init first, then override with proxy-specific fields
  return originalFetch(PROXY_URL, {
    ...init,
    method,
    headers,
    body,
  });
}

/**
 * Installs the secure fetch wrapper globally.
 * Only activates when PROXY_URL is set (injected by the Docker secure flow).
 * Safe to call unconditionally at startup — no-op on the host.
 */
export function installSecureFetch(): void {
  PROXY_URL = process.env.PROXY_URL;
  if (!PROXY_URL) {
    return;
  }

  // Replace global fetch
  globalThis.fetch = secureFetch as typeof fetch;

  // Activated — routing all fetch() calls through the host secrets proxy.
}

/**
 * Restores the original fetch (for testing).
 */
export function uninstallSecureFetch(): void {
  globalThis.fetch = originalFetch;
}
