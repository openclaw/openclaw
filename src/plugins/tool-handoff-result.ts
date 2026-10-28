import { AsyncLocalStorage } from "node:async_hooks";
import type { AgentToolResult } from "../agents/runtime/index.js";

/** An unforgeable process-local marker for a tool result returned after its owner yielded. */
const accepted = new WeakSet<object>();
const yieldingTools = new WeakSet<object>();
const invocation = new AsyncLocalStorage<{ accepted: boolean }>();

/** Each wrapped execute gets its own host marker, even when sibling calls share a run signal. */
export function createPluginGatewayHandoffInvocation() {
  const state = { accepted: false };
  return {
    run: <T>(operation: () => T): T => invocation.run(state, operation),
    isAccepted: () => state.accepted,
  };
}

/** Called only at the accepted handoff's onYield boundary. */
export function acceptCurrentPluginGatewayHandoffInvocation(): void {
  const state = invocation.getStore();
  if (state) {
    state.accepted = true;
  }
}

/** Host-only registration fact: this exact tool can request a Gateway-owned turn handoff. */
export function markPluginGatewayHandoffTool<T extends object>(tool: T): T {
  yieldingTools.add(tool);
  return tool;
}

export function copyPluginGatewayHandoffTool(source: object, target: object): void {
  if (yieldingTools.has(source)) {
    yieldingTools.add(target);
  }
}

export function isPluginGatewayHandoffTool(tool: object): boolean {
  return yieldingTools.has(tool);
}

export function markAcceptedPluginToolHandoffResult<T extends AgentToolResult<unknown>>(
  result: T,
): T {
  accepted.add(result);
  return result;
}

export function isAcceptedPluginToolHandoffResult(value: unknown): boolean {
  return typeof value === "object" && value !== null && accepted.has(value);
}
