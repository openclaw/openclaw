/**
 * Lightweight registry for in-process gateway method dispatch.
 *
 * The gateway server registers a dispatcher at startup so that agent tools
 * running inside the same process can call gateway methods directly instead
 * of opening a new WebSocket connection.  This avoids event-loop
 * self-contention when a tool call originates from an active LLM session
 * on the same gateway (see #40237).
 *
 * CLI / external callers never register a dispatcher, so
 * `tryLocalGatewayDispatch` returns `undefined` and the caller falls back
 * to the normal WS path.
 */

type LocalDispatchFn = <T>(method: string, params: Record<string, unknown>) => Promise<T>;

let _localDispatch: LocalDispatchFn | undefined;

/**
 * Called once by the gateway server after setup to enable in-process dispatch.
 */
export function registerLocalGatewayDispatch(fn: LocalDispatchFn): void {
  _localDispatch = fn;
}

/**
 * Returns a promise for the result if in-process dispatch is available,
 * or `undefined` when running outside the gateway (e.g. CLI).
 */
export function tryLocalGatewayDispatch<T>(
  method: string,
  params: Record<string, unknown>,
): Promise<T> | undefined {
  return _localDispatch ? _localDispatch<T>(method, params) : undefined;
}

/**
 * Test helper — resets the registered dispatcher.
 */
export function _resetLocalGatewayDispatch(): void {
  _localDispatch = undefined;
}
