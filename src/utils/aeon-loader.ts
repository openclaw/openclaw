/**
 * Shared loader for the optional aeon-memory plugin.
 *
 * Provides both sync and async loading strategies to avoid **floating
 * promises** that crash Windows CI during vitest teardown (Node.js fires
 * `unhandledRejection` after vitest removes its handler → exit code 1 even
 * when all tests pass).
 *
 * • `ensureAeonLoaded()`  — sync, uses `createRequire()`.  Works in production.
 *                           **Does NOT work with `vi.doMock()`** in vitest.
 * • `loadAeonMemoryAsync()` — async, uses `await import()`. **Compatible with
 *                           `vi.doMock()`** and should be used in test-facing
 *                           code paths (or anywhere async is acceptable).
 * • `getAeonPlugin()`    — returns the cached plugin reference (or null).
 * • `triggerAeonLoad()`  — sync fire-and-forget with void-swallowed promise
 *                           (no floating rejections). Plugin becomes available
 *                           on next tick.
 */

import { createRequire } from "node:module";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _plugin: any = null;
let _loaded = false;

/**
 * Synchronously load aeon-memory using `createRequire`.
 * Returns the AeonMemory class or null.  Safe to call repeatedly.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ensureAeonLoaded(): any {
  if (_loaded) {
    return _plugin;
  }
  _loaded = true;
  try {
    const _require = createRequire(import.meta.url);
    const m = _require("aeon-memory");
    _plugin = m.AeonMemory ?? null;
  } catch {
    _plugin = null;
  }
  return _plugin;
}

/**
 * Async variant that uses `await import()`.  Compatible with vitest mocking.
 */
export async function loadAeonMemoryAsync(): Promise<void> {
  if (_loaded) {
    return;
  }
  _loaded = true;
  try {
    // @ts-ignore: Optional dependency for ultra-low-latency memory
    const m = await import("aeon-memory");
    _plugin = m.AeonMemory ?? null;
  } catch {
    _plugin = null;
  }
}

/**
 * Synchronous fire-and-forget loader.  The promise is void-consumed so it
 * never appears as an unhandled rejection.  Plugin becomes available on next
 * tick.
 */
export function triggerAeonLoad(): void {
  if (_loaded) {
    return;
  }
  _loaded = true;
  void (async () => {
    try {
      // @ts-ignore: Optional dependency for ultra-low-latency memory
      const m = await import("aeon-memory");
      _plugin = m.AeonMemory ?? null;
    } catch {
      _plugin = null;
    }
  })();
}

/**
 * Return the cached AeonMemory class, or null if not loaded (yet).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getAeonPlugin(): any {
  return _plugin;
}

/**
 * Reset internal state — used exclusively by tests.
 * @internal
 */
export function _resetForTesting(): void {
  _plugin = null;
  _loaded = false;
}
