/**
 * Network I/O Gating Wrapper for ClarityBurst
 *
 * This module provides utilities for wrapping HTTP request calls with ClarityBurst
 * NETWORK_IO execution-boundary gating. All outbound network requests must pass through
 * the gate before execution.
 *
 * Pattern:
 *   const response = await applyNetworkIOGateAndFetch(url, options);
 *
 * The gate will:
 * 1. Extract operation (GET/POST/etc) and URL from request parameters
 * 2. Route through ClarityBurst NETWORK_IO gate
 * 3. Throw ClarityBurstAbstainError if the gate abstains (CONFIRM or CLARIFY)
 * 4. Execute the fetch if the gate approves (PROCEED)
 * 5. Log the decision with contractId, outcome, and target URL
 */

import { ClarityBurstAbstainError } from "./errors";
import { applyNetworkOverrides, type NetworkContext } from "./decision-override";
import { createSubsystemLogger } from "../logging/subsystem";

const gatingLog = createSubsystemLogger("clarityburst-network-io-gating");

/**
 * Extract HTTP method from fetch options
 */
function extractMethodFromOptions(init?: RequestInit): string {
  const method = init?.method?.toUpperCase() ?? "GET";
  return method;
}

/**
 * Extract hostname from URL for logging
 */
function extractHostname(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/**
 * Apply NETWORK_IO gate and execute fetch
 *
 * This is the primary wrapper for all fetch calls that should be gated.
 * It applies the ClarityBurst NETWORK_IO gate immediately before the request
 * is sent to the network.
 *
 * @param url - The target URL
 * @param init - Optional fetch request init parameters
 * @returns The fetch response if gate approves, or throws on abstain
 * @throws ClarityBurstAbstainError if the gate returns ABSTAIN_CONFIRM or ABSTAIN_CLARIFY
 *
 * @example
 * ```typescript
 * const response = await applyNetworkIOGateAndFetch("https://api.example.com/data", {
 *   method: "POST",
 *   headers: { "Content-Type": "application/json" },
 *   body: JSON.stringify({ key: "value" })
 * });
 * ```
 */
export async function applyNetworkIOGateAndFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const method = extractMethodFromOptions(init);
  const hostname = extractHostname(url);

  // Create context for the NETWORK_IO gate
  const context: NetworkContext = {
    stageId: "NETWORK_IO",
    operation: method,
    url: hostname,
    userConfirmed: false,
  };

  // Apply the NETWORK_IO gate
  const gateResult = await applyNetworkOverrides(context);

  // Log the gating decision
  gatingLog.debug("NETWORK_IO gate decision", {
    contractId: gateResult.contractId,
    outcome: gateResult.outcome,
    method,
    hostname,
  });

  // If gate abstains, throw the appropriate error
  if (gateResult.outcome.startsWith("ABSTAIN")) {
    const error = new ClarityBurstAbstainError({
      stageId: "NETWORK_IO",
      outcome: gateResult.outcome as "ABSTAIN_CONFIRM" | "ABSTAIN_CLARIFY",
      reason: gateResult.reason as any,
      contractId: gateResult.contractId,
      instructions: gateResult.instructions ?? `Network request to ${hostname} blocked by ClarityBurst NETWORK_IO gate.`,
    });
    gatingLog.warn("NETWORK_IO gate blocked request", {
      contractId: gateResult.contractId,
      reason: gateResult.reason,
      hostname,
    });
    throw error;
  }

  // Gate approved: execute the fetch
  gatingLog.debug("NETWORK_IO gate approved request", {
    contractId: gateResult.contractId,
    hostname,
  });

  return fetch(url, init);
}

/**
 * Type-safe wrapper for fetch that ensures gating
 *
 * This can be used as a drop-in replacement for fetch() that automatically applies gating.
 *
 * @param input - URL or Request object
 * @param init - Optional fetch request init parameters
 * @returns The fetch response if gate approves
 * @throws ClarityBurstAbstainError if the gate abstains
 */
export async function gateFetch(
  input: string | Request,
  init?: RequestInit
): Promise<Response> {
  const url = typeof input === "string" ? input : input.url;
  const method = typeof input === "string" 
    ? extractMethodFromOptions(init)
    : (input.method?.toUpperCase() ?? "GET");
  
  const finalInit = typeof input === "string" ? init : undefined;
  
  return applyNetworkIOGateAndFetch(url, finalInit);
}
