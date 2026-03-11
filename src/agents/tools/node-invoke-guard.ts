/**
 * @fileoverview
 * Centralized agent-side NODE_INVOKE dispatch wrapper that enforces mandatory
 * ClarityBurst gating before any node.invoke gateway call.
 *
 * This helper consolidates the gating pattern used across canvas-tool, nodes-tool,
 * browser-tool, and bash-tools.exec-host-node to ensure consistent fail-closed behavior.
 */

import { applyNodeInvokeOverrides } from "../../clarityburst/decision-override.js";
import { callGatewayTool } from "./gateway.js";
import type {
  NodeInvokeContext,
  AbstainConfirmOutcome,
  AbstainClarifyOutcome,
} from "../../clarityburst/decision-override.js";

/**
 * Options passed to the gateway for a node.invoke call
 */
export interface NodeInvokeGatewayOpts {
  timeoutMs?: number;
  [key: string]: unknown;
}

/**
 * Parameters for invoking a node function
 */
export interface NodeInvokeParams {
  nodeId: string;
  command: string;
  params?: Record<string, unknown>;
  idempotencyKey?: string;
  [key: string]: unknown;
}

/**
 * Structured data for a blocked NODE_INVOKE outcome
 */
export interface NodeInvokeBlockedData {
  outcome: string;
  reason: string;
  instructions?: string;
  contractId?: string | null;
  stageId: "NODE_INVOKE";
}

/**
 * Custom error thrown when NODE_INVOKE gating blocks dispatch.
 * Provides structured access to gating decision data.
 */
export class NodeInvokeBlockedError extends Error {
  readonly data: NodeInvokeBlockedData;

  constructor(data: NodeInvokeBlockedData, functionName: string) {
    const instructionsMsg = data.instructions ? `. ${data.instructions}` : "";
    super(
      `node.invoke gated (${data.outcome}): ${functionName}. Reason: ${data.reason}${instructionsMsg}`,
    );
    this.name = "NodeInvokeBlockedError";
    this.data = data;
  }
}

/**
 * Dispatch a node.invoke call through ClarityBurst NODE_INVOKE gating.
 *
 * This wrapper enforces mandatory gating before any gateway dispatch:
 * 1. Calls applyNodeInvokeOverrides() with stageId: "NODE_INVOKE"
 * 2. Fails closed (throws NodeInvokeBlockedError) on ABSTAIN_CONFIRM or ABSTAIN_CLARIFY
 * 3. Calls callGatewayTool("node.invoke", ...) only after PROCEED outcome
 *
 * @param functionName - The node function/command name (e.g., "system.run", "browser.proxy")
 * @param nodeId - The target node ID
 * @param params - Parameters to pass to node.invoke (command, command params, etc.)
 * @param gatewayOpts - Gateway options (timeoutMs, etc.)
 * @param additionalContext - Optional additional context for NODE_INVOKE gating
 * @returns The raw gateway response from callGatewayTool
 * @throws NodeInvokeBlockedError if gating outcome is ABSTAIN_CONFIRM or ABSTAIN_CLARIFY
 *
 * @example
 * ```typescript
 * try {
 *   const result = await dispatchNodeInvokeGuarded(
 *     "system.run",
 *     nodeId,
 *     { nodeId, command: "system.run", params: { cmd: "echo hello" } },
 *     { timeoutMs: 30000 }
 *   );
 * } catch (err) {
 *   if (err instanceof NodeInvokeBlockedError) {
 *     const { outcome, reason, instructions } = err.data;
 *     // Handle blocked outcome
 *   }
 * }
 * ```
 */
export async function dispatchNodeInvokeGuarded<T = unknown>(
  functionName: string,
  nodeId: string,
  params: NodeInvokeParams,
  gatewayOpts: NodeInvokeGatewayOpts,
  additionalContext?: Partial<NodeInvokeContext>,
): Promise<T> {
  // Build the NODE_INVOKE context for ClarityBurst gating.
  // Identity fields (stageId, functionName) are applied AFTER spreading additionalContext
  // to ensure they cannot be overridden by caller-supplied values.
  const context: NodeInvokeContext = {
    ...additionalContext,
    stageId: "NODE_INVOKE",      // Mandatory: always NODE_INVOKE
    functionName,                 // Mandatory: from explicit function argument
  };

  // Apply mandatory ClarityBurst gating
  const gatingResult = await applyNodeInvokeOverrides(context);

  // Fail closed: block dispatch if gate returns ABSTAIN_CONFIRM or ABSTAIN_CLARIFY
  if (gatingResult.outcome !== "PROCEED") {
    // Type narrowing: gatingResult is now AbstainConfirmOutcome | AbstainClarifyOutcome
    const blockedOutcome = gatingResult;
    
    const blockedData: NodeInvokeBlockedData = {
      outcome: blockedOutcome.outcome,
      reason: blockedOutcome.reason ?? "unknown",
      instructions: blockedOutcome.instructions,
      contractId: blockedOutcome.contractId,
      stageId: "NODE_INVOKE",
    };
    throw new NodeInvokeBlockedError(blockedData, functionName);
  }

  // Only after PROCEED: dispatch to gateway
  const result = await callGatewayTool<T>("node.invoke", gatewayOpts, params);
  return result;
}
