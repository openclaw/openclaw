/**
 * ClarityBurst router client for contract routing decisions.
 */

import { ClarityBurstAbstainError } from './errors.js';
import type { ClarityBurstStageId } from './stages.js';
import configManager from './config.js';

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

  try {
    const response = await fetch(routerEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
        status: response.status,
      };
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
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
      return {
        ok: false,
        error: "Invalid response shape: missing or malformed top1/top2",
        status: response.status,
      };
    }

    return {
      ok: true,
      data: {
        top1: parsed.top1 as RouterContractMatch,
        top2: parsed.top2 as RouterContractMatch,
        router_version:
          typeof parsed.router_version === "string" ? parsed.router_version : undefined,
      },
    };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof Error) {
      if (err.name === "AbortError") {
        return {
          ok: false,
          error: `Request timed out after ${timeoutMs}ms`,
        };
      }
      return {
        ok: false,
        error: err.message,
      };
    }

    return {
      ok: false,
      error: "Unknown error",
    };
  }
}
