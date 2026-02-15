/**
 * Secure Fetch Wrapper
 * 
 * Intercepts all fetch() calls and routes them through the secrets injection proxy.
 * This must be loaded BEFORE any other modules that make HTTP requests.
 * 
 * P0 Fix: Properly handles Request objects by extracting method, headers, and body.
 */
import process from "node:process";

const PROXY_URL = process.env.PROXY_URL || "http://host.docker.internal:8080";

// Store the original fetch
const originalFetch = globalThis.fetch;

/**
 * Checks if a URL should bypass the proxy (local requests).
 */
function shouldBypassProxy(url: string): boolean {
  return (
    url.startsWith("http://localhost") ||
    url.startsWith("http://127.0.0.1") ||
    url.startsWith("http://host.docker.internal")
  );
}

/**
 * Wraps fetch to route all requests through the secrets proxy.
 * Adds X-Target-URL header with the original destination.
 * 
 * Properly handles both Request objects and string URLs, preserving
 * method, headers, and body from the original request.
 */
async function secureFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
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
    
    // Body: init.body overrides, otherwise clone from Request if it has one
    if (init?.body !== undefined) {
      body = init.body;
    } else if (input.body && !input.bodyUsed) {
      // Clone the body from the original request
      body = input.clone().body;
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
  return originalFetch(PROXY_URL, {
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
