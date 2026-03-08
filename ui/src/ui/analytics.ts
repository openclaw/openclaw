/**
 * Microsoft Clarity analytics helpers.
 *
 * Thin wrappers around the Clarity browser API so the rest of the UI stays
 * clean and doesn't scatter `window.clarity` checks everywhere. All calls
 * silently no-op if Clarity isn't loaded (ad-blockers, local dev, etc.).
 *
 * Clarity API reference:
 *   https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-api
 */

declare global {
  interface Window {
    clarity?: (method: string, ...args: unknown[]) => void;
  }
}

/**
 * Fire a Clarity custom event. Appears under Filters → Custom events in the
 * Clarity dashboard and can be used to create funnels / segments.
 *
 * @param name  - Stable event name (snake_case, e.g. "message_sent")
 * @param value - Optional string value attached to the event
 */
export function trackEvent(name: string, value?: string): void {
  try {
    if (value != null) {
      window.clarity?.("event", name, value);
    } else {
      window.clarity?.("event", name);
    }
  } catch {
    // Analytics must never crash the UI.
  }
}

/**
 * Set a Clarity custom tag (key/value pair visible on session recordings).
 * Useful for identifying the connected gateway version, session key, theme, etc.
 *
 * @param key   - Tag key (e.g. "theme", "session_key")
 * @param value - Tag value
 */
export function setTag(key: string, value: string): void {
  try {
    window.clarity?.("set", key, value);
  } catch {
    // Silently ignore.
  }
}
