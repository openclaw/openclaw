import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { SystemAgentOperation } from "../system-agent/operation-types.js";

// Source tools and the published Gateway share request data, not new authority.
// The ordinary openclaw.chat router and approval owner still admit every operation.
const operations = resolveGlobalSingleton<WeakMap<object, SystemAgentOperation>>(
  Symbol.for("openclaw.systemAgentOperationInput"),
  () => new WeakMap(),
);

export function bindSystemAgentOperationInput<T extends object>(
  request: T,
  operation: SystemAgentOperation,
): T {
  operations.set(request, operation);
  return request;
}

/** Wire copies and model-authored fields cannot select this internal input path. */
export function takeSystemAgentOperationInput(request: object): SystemAgentOperation | undefined {
  const operation = operations.get(request);
  operations.delete(request);
  return operation;
}
