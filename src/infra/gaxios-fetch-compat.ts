/**
 * Compatibility shim for gaxios@7.x on Node.js 22+.
 *
 * gaxios checks `typeof window !== 'undefined'` to decide between
 * `window.fetch` (browser) and `import('node-fetch')` (Node.js).
 * On Node.js 22+, `globalThis.fetch` is available natively, but gaxios
 * does not check for it before falling back to node-fetch.
 *
 * node-fetch@3.x ESM loading is broken on Node.js 25 (ESM translator
 * calls hasOwnProperty on null, throwing "Cannot convert undefined or
 * null to object"). This causes ALL google-vertex auth requests to fail
 * before any network call is made.
 *
 * Fix: define a minimal `window` shim with `fetch = globalThis.fetch` so
 * gaxios uses the native fetch implementation instead of importing node-fetch.
 *
 * This module must be imported (as a side effect) before any google-auth-library
 * or gaxios request is made.
 */
if (
  typeof (globalThis as Record<string, unknown>)["window"] === "undefined" &&
  typeof globalThis.fetch === "function"
) {
  // Tell gaxios it's in a "browser-like" environment with a working fetch.
  // Only the `fetch` property is needed; gaxios only reads `window.fetch`.
  (globalThis as Record<string, unknown>)["window"] = { fetch: globalThis.fetch };
}
