
/**
 * ClarityBurst router client for contract routing decisions.
 */

import { ClarityBurstAbstainError } from './errors.js';
import type { ClarityBurstStageId } from './stages.js';
import configManager from './config.js';
import { createSubsystemLogger } from '../logging/subsystem.js';
import { applyNetworkIOGateAndFetch } from './network-io-gating.js';

const routerClientLog = createSubsystemLogger('clarityburst-router-client');

export type RouterContractMatch = {
  contract_id: string;
  score: number;
};

export type RouterInput = {
  stageId: string;
  packId: string;
  packVersion: string;
  allowedContractIds: string[];
  userText: string;
  context?: Record<string, unknown>;
};

export type RouterResponseData = {
  top1: RouterContractMatch;
  top2: RouterContractMatch;
  router_version?: string;
};

export type RouterResultOk = {
  ok: true;
  data: RouterResponseData;
};

export type RouterResultError = {
  ok: false;
  error: string;
  status?: number;
};

export type RouterResult = RouterResultOk | RouterResultError;

/**
 * Get router endpoint from configuration
 */
function getRouterEndpoint(): string {
  const baseUrl = configManager.getRouterUrl();
  return `${baseUrl}/api/route`;
}

/**
 * Get timeout from configuration
 */
function getTimeoutMs(): number {
  return configManager.getTimeoutMs();
}

/**
 * Validates that allowedContractIds is a properly formed array.
 *
 * INVARIANT: allowedContractIds must be:
 * 1. An array
 * 2. Contain only non-empty strings
 * 3. Contain no duplicates
 *
 * @param allowedContractIds - The array to validate
 * @param stageId - The stage ID for error reporting
 * @throws ClarityBurstAbstainError with ABSTAIN_CLARIFY/PACK_POLICY_INCOMPLETE if validation fails
 */
function validateAllowedContractIds(
  allowedContractIds: unknown,
  stageId: string
): void {
  // Validate Array.isArray
  if (!Array.isArray(allowedContractIds)) {
    throw new ClarityBurstAbstainError({
      stageId: stageId as ClarityBurstStageId,
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `allowedContractIds must be an array, received ${typeof allowedContractIds}`,
    });
  }

  // Validate every entry is a non-empty string
  for (let i = 0; i < allowedContractIds.length; i++) {
    const entry = allowedContractIds[i];
    if (typeof entry !== "string") {
      throw new ClarityBurstAbstainError({
        stageId: stageId as ClarityBurstStageId,
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
        instructions: `allowedContractIds[${i}] must be a string, received ${typeof entry}`,
      });
    }
    if (entry === "") {
      throw new ClarityBurstAbstainError({
        stageId: stageId as ClarityBurstStageId,
        outcome: "ABSTAIN_CLARIFY",
        reason: "PACK_POLICY_INCOMPLETE",
        contractId: null,
        instructions: `allowedContractIds[${i}] must be a non-empty string`,
      });
    }
  }

  // Validate uniqueness (no duplicates)
  const uniqueIds = new Set(allowedContractIds);
  if (uniqueIds.size !== allowedContractIds.length) {
    // Find the duplicate for better error message
    const seen = new Set<string>();
    for (const id of allowedContractIds) {
      if (seen.has(id)) {
        throw new ClarityBurstAbstainError({
          stageId: stageId as ClarityBurstStageId,
          outcome: "ABSTAIN_CLARIFY",
          reason: "PACK_POLICY_INCOMPLETE",
          contractId: null,
          instructions: `allowedContractIds contains duplicate entry: "${id}"`,
        });
      }
      seen.add(id);
    }
  }
}

/**
 * Routes a ClarityBurst request to the local router service.
 *
 * @param input - The routing input containing stage, pack, and user context.
 * @returns A result object with `ok: true` and `data` on success,
 *          or `ok: false` and `error` (with optional `status`) on failure.
 * @throws ClarityBurstAbstainError if allowedContractIds contains duplicates or non-string values
 */
export async function routeClarityBurst(input: RouterInput): Promise<RouterResult> {
   routerClientLog.info('CB_RT_SENTINEL_ROUTE_ENTER', { stageId: input.stageId, packId: input.packId, routerUrl: configManager.getRouterUrl() });

   // ─────────────────────────────────────────────────────────────────────────────
   // INVARIANT: allowedContractIds must be valid before routing
   // Hard-blocks with ClarityBurstAbstainError(ABSTAIN_CLARIFY, PACK_POLICY_INCOMPLETE)
   // if allowedContractIds contains duplicates or non-string values.
   // ─────────────────────────────────────────────────────────────────────────────
   validateAllowedContractIds(input.allowedContractIds, input.stageId);

   const routerEndpoint = getRouterEndpoint();
   const timeoutMs = getTimeoutMs();

   const controller = new AbortController();
   const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

   console.log('[ClarityBurst Runtime] routeClarityBurst invoked', {
     stageId: input.stageId,
     packId: input.packId,
     'allowedContractIds.length': input.allowedContractIds.length,
     'userText.length': input.userText.length,
   });

   const t0 = Date.now();

   // Extract runId from context if available
   const runId = typeof input.context?.runId === 'string' ? (input.context.runId) : undefined;

   try {
     routerClientLog.info('[routeClarityBurst] Routing request', {
       stageId: input.stageId,
       packId: input.packId,
       'allowedContractIds.length': input.allowedContractIds.length,
       routerUrl: routerEndpoint,
     });

     // Log router self-call being gated through NETWORK_IO
     const logStartPayload: Record<string, unknown> = {
       routerUrl: routerEndpoint,
       method: 'POST',
       contractId: input.allowedContractIds[0],
       stageId: input.stageId,
       packId: input.packId,
       timeoutMs: timeoutMs,
       governance: 'NETWORK_IO_GATE',
       callType: 'ROUTER_SELF_CALL_INTERNAL',
     };
     if (runId) {logStartPayload.runId = runId;}
     routerClientLog.info('ROUTER_CALL_START', logStartPayload);

     // SECURITY: Router self-call must pass through NETWORK_IO gate
     // This ensures the router invocation is subject to ClarityBurst execution-boundary control
     // and cannot bypass governance constraints.
     const response = await applyNetworkIOGateAndFetch(routerEndpoint, {
       method: "POST",
       headers: {
         "Content-Type": "application/json",
       },
       body: JSON.stringify(input),
       signal: controller.signal,
     });

     clearTimeout(timeoutId);
     const latencyMs = Date.now() - t0;

     if (!response.ok) {
       const errPayload: Record<string, unknown> = {
         latencyMs,
         errorName: 'HttpError',
         errorMessage: `HTTP ${response.status}: ${response.statusText}`,
         httpStatus: response.status,
         contractId: input.allowedContractIds[0],
         governance: 'NETWORK_IO_GATE',
         callType: 'ROUTER_SELF_CALL_INTERNAL',
       };
       if (runId) {errPayload.runId = runId;}
       routerClientLog.warn('ROUTER_CALL_ERR', errPayload);
       return {
         ok: false,
         error: `HTTP ${response.status}: ${response.statusText}`,
         status: response.status,
       };
     }

     let data: unknown;
     try {
       data = await response.json();
     } catch (parseErr) {
       const latencyMsOnErr = Date.now() - t0;
       const errPayload: Record<string, unknown> = {
         latencyMs: latencyMsOnErr,
         errorName: 'JsonParseError',
         errorMessage: 'Failed to parse JSON response',
         httpStatus: response.status,
         contractId: input.allowedContractIds[0],
         governance: 'NETWORK_IO_GATE',
         callType: 'ROUTER_SELF_CALL_INTERNAL',
       };
       if (runId) {errPayload.runId = runId;}
       routerClientLog.warn('ROUTER_CALL_ERR', errPayload);
       return {
         ok: false,
         error: "Failed to parse JSON response",
         status: response.status,
       };
     }

     // Basic shape validation
     const parsed = data as Record<string, unknown>;
     if (
       !parsed ||
       typeof parsed !== "object" ||
       !parsed.top1 ||
       !parsed.top2 ||
       typeof (parsed.top1 as RouterContractMatch).contract_id !== "string" ||
       typeof (parsed.top1 as RouterContractMatch).score !== "number" ||
       typeof (parsed.top2 as RouterContractMatch).contract_id !== "string" ||
       typeof (parsed.top2 as RouterContractMatch).score !== "number"
     ) {
       const errPayload: Record<string, unknown> = {
         latencyMs,
         errorName: 'InvalidResponseShape',
         errorMessage: 'Invalid response shape: missing or malformed top1/top2',
         httpStatus: response.status,
         contractId: input.allowedContractIds[0],
         governance: 'NETWORK_IO_GATE',
         callType: 'ROUTER_SELF_CALL_INTERNAL',
       };
       if (runId) {errPayload.runId = runId;}
       routerClientLog.warn('ROUTER_CALL_ERR', errPayload);
       return {
         ok: false,
         error: "Invalid response shape: missing or malformed top1/top2",
         status: response.status,
       };
     }

     const result: RouterResult = {
       ok: true,
       data: {
         top1: parsed.top1 as RouterContractMatch,
         top2: parsed.top2 as RouterContractMatch,
         router_version:
           typeof parsed.router_version === "string" ? parsed.router_version : undefined,
       },
     };

     const okPayload: Record<string, unknown> = {
       latencyMs,
       httpStatus: response.status,
       routeOk: result.ok,
       contractId: result.data.top1.contract_id,
       governance: 'NETWORK_IO_GATE',
       callType: 'ROUTER_SELF_CALL_INTERNAL',
     };
     if (runId) {okPayload.runId = runId;}
     routerClientLog.info('ROUTER_CALL_OK', okPayload);

     return result;
   } catch (err) {
     clearTimeout(timeoutId);
     const latencyMs = Date.now() - t0;

     if (err instanceof Error) {
       if (err.name === "AbortError") {
         const errPayload: Record<string, unknown> = {
           latencyMs,
           errorName: 'AbortError',
           errorMessage: `Request timed out after ${timeoutMs}ms`,
           contractId: input.allowedContractIds[0],
           governance: 'NETWORK_IO_GATE',
           callType: 'ROUTER_SELF_CALL_INTERNAL',
         };
         if (runId) {errPayload.runId = runId;}
         routerClientLog.warn('ROUTER_CALL_ERR', errPayload);
         return {
           ok: false,
           error: `Request timed out after ${timeoutMs}ms`,
         };
       }
       const errorMsg = err.message.slice(0, 200);
       const errPayload: Record<string, unknown> = {
         latencyMs,
         errorName: err.name,
         errorMessage: errorMsg,
         contractId: input.allowedContractIds[0],
         governance: 'NETWORK_IO_GATE',
         callType: 'ROUTER_SELF_CALL_INTERNAL',
       };
       if (runId) {errPayload.runId = runId;}
       routerClientLog.warn('ROUTER_CALL_ERR', errPayload);
       return {
         ok: false,
         error: err.message,
       };
     }

     const errPayload: Record<string, unknown> = {
       latencyMs,
       errorName: 'UnknownError',
       errorMessage: 'Unknown error',
       contractId: input.allowedContractIds[0],
       governance: 'NETWORK_IO_GATE',
       callType: 'ROUTER_SELF_CALL_INTERNAL',
     };
     if (runId) {errPayload.runId = runId;}
     routerClientLog.warn('ROUTER_CALL_ERR', errPayload);
     return {
       ok: false,
       error: "Unknown error",
     };
   }
 }
