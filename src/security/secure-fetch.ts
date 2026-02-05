/**
 * Secure Fetch Wrapper
 *
 * Intercepts all fetch() calls and routes them through the secrets injection proxy.
 * This must be loaded BEFORE any other modules that make HTTP requests.
 *
 * P0 Fix: Properly handles Request objects by extracting method, headers, and body.
 */
import process from "node:process";

// In secure mode, PROXY_URL must be set (fail fast if not)
const PROXY_URL = process.env.PROXY_URL;
if (process.env.OPENCLAW_SECURE_MODE === "1" && !PROXY_URL) {
  throw new Error("PROXY_URL environment variable is required in secure mode");
}

// Store the original fetch
const originalFetch = globalThis.fetch;

/**
 * Checks if a URL should bypass the proxy.
 * Only bypass for true loopback addresses, NOT host.docker.internal
 * (which would allow container to access host services without allowlist).
 */
function shouldBypassProxy(url: string): boolean {
  // Only bypass for actual loopback - container talking to itself
  if (url.startsWith("http://localhost") || url.startsWith("http://127.0.0.1")) {
    return true;
  }
  // Also bypass requests TO the proxy itself to avoid infinite loop
  if (PROXY_URL && url.startsWith(PROXY_URL)) {
    return true;
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
  // Only intercept if we're in secure mode
  if (process.env.OPENCLAW_SECURE_MODE !== "1") {
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

  // Add X-Target-URL header
  headers.set("X-Target-URL", targetUrl);

  // Route through proxy, preserving all request details
  // PROXY_URL is guaranteed to be set in secure mode (we throw at startup if not)
  return originalFetch(PROXY_URL!, {
    method,
    headers,
    body,
    // Preserve other init options
    cache: init?.cache,
    credentials: init?.credentials,
    integrity: init?.integrity,
    keepalive: init?.keepalive,
    mode: init?.mode,
    redirect: init?.redirect,
    referrer: init?.referrer,
    referrerPolicy: init?.referrerPolicy,
    signal: init?.signal,
  });
}

/**
 * Installs the secure fetch wrapper globally.
 * Call this at the very start of your application in secure mode.
 */
export function installSecureFetch(): void {
  if (process.env.OPENCLAW_SECURE_MODE !== "1") {
    return;
  }

  // Replace global fetch
  globalThis.fetch = secureFetch as typeof fetch;

  console.log("[secure-fetch] Installed fetch wrapper, routing through:", PROXY_URL);
}

/**
 * Restores the original fetch (for testing).
 */
export function uninstallSecureFetch(): void {
  globalThis.fetch = originalFetch;
}
