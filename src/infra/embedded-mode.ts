/**
 * Process-level flag indicating whether the current process is running in
 * embedded TUI mode (no gateway).  This is set once by `EmbeddedTuiBackend`
 * at startup and consulted by tool creation and hook evaluation code to
 * gracefully skip gateway-dependent operations.
 *
 * Pattern is consistent with the existing `getGlobalHookRunner()` singleton.
 */

let _embeddedMode = false;

/** Mark this process as running in embedded (gateway-less) mode. */
export function setEmbeddedMode(value: boolean): void {
  _embeddedMode = value;
}

/** Returns `true` when the process is running in embedded TUI mode (no gateway). */
export function isEmbeddedMode(): boolean {
  return _embeddedMode;
}
