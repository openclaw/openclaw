/**
 * ClarityBurst router client for contract routing decisions.
 */

import type { OntologyPack, PackContract } from "./pack-registry.js";
import type { ClarityBurstStageId } from "./stages.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import configManager from "./config.js";
import { ClarityBurstAbstainError } from "./errors.js";
import { applyNetworkIOGateAndFetch } from "./network-io-gating.js";
import { scorePackPhaseA } from "./pack-scoring-phase-a.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const routerClientLog = createSubsystemLogger("clarityburst-router-client");

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
  /** Canonical locally-resolved ontology pack. Included when a pack has already been
   *  loaded for the current stage so the remote router can use it directly.
   *  Omitted when no local pack is available (backward-compatible). */
  pack?: OntologyPack;
  sessionId?: string;
};

export type RouterResponseData = {
  top1: RouterContractMatch;
  top2: RouterContractMatch;
  router_version?: string;
  /** UUID v4 requestId from the router — propagates to execution/logging layer */
  requestId?: string;
  sessionId?: string;
};

export type RouterResultOk = {
  ok: true;
  data: RouterResponseData;
};

export type RouterResultError = {
  ok: false;
  error: string;
  status?: number;
  /** Set to true when ClarityBurst is disabled (bypass mode, not an error) */
  disabled?: true;
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
function validateAllowedContractIds(allowedContractIds: unknown, stageId: string): void {
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
 * Converts a snake_case token string to Title Case by splitting on '_'.
 * e.g. "file_system_write" → "File System Write"
 */
function toTitleCase(s: string): string {
  return s
    .split("_")
    .map((t) => (t.length > 0 ? t[0].toUpperCase() + t.slice(1).toLowerCase() : ""))
    .join(" ");
}

/**
 * Maps an OntologyPack (local snake_case shape) to the router's inline pack schema (camelCase).
 * Applied just before serialization so the remote /api/route endpoint receives the expected shape.
 * Does not mutate the original pack or affect any local decision logic.
 *
 * Synthesized fields (deterministic, no runtime state):
 *   version            — always 1
 *   domain             — first dot-segment of pack_id
 *   name               — title-case of stage_id tokenized on '_'
 *   policy.failClosed  — true if any contract has deny_by_default === true
 *   policy.minConfidence        — thresholds.min_confidence_T
 *   policy.escalationActionId   — first CRITICAL+deny_by_default contract_id,
 *                                 then first CRITICAL contract_id, else null
 *   actions            — per-contract { id, label, description, canonicalPhrases }
 */
function normalizePackForRouter(pack: OntologyPack): Record<string, unknown> {
  // Synthesized top-level scalars
  const domain = pack.pack_id.split(".")[0];
  const name = toTitleCase(pack.stage_id);

  // Synthesized policy block
  const failClosed = pack.contracts.some((c) => c.deny_by_default);
  const minConfidence = pack.thresholds?.min_confidence_T ?? null;

  // escalationActionId: prefer CRITICAL+deny_by_default, then CRITICAL, then null
  const criticalDeny = pack.contracts.find((c) => c.risk_class === "CRITICAL" && c.deny_by_default);
  const criticalAny = pack.contracts.find((c) => c.risk_class === "CRITICAL");
  const escalationActionId = criticalDeny?.contract_id ?? criticalAny?.contract_id ?? null;

  // Synthesized actions array
  const actions = pack.contracts.map((c) => {
    const contractWithDesc = c as PackContract & { description?: string };
    return {
      id: c.contract_id,
      label: toTitleCase(c.contract_id),
      description: contractWithDesc.description ?? c.contract_id,
      canonicalPhrases: [c.contract_id.toLowerCase().replace(/_/g, " ")],
    };
  });

  return {
    // Fixed version sentinel
    version: 1,
    // Synthesized structural fields
    domain,
    name,
    // Direct renames — preserved from original adapter
    packId: pack.pack_id,
    packVersion: pack.pack_version,
    stageId: pack.stage_id,
    description: pack.description,
    thresholds: pack.thresholds
      ? {
          minConfidenceT: pack.thresholds.min_confidence_T,
          dominanceMarginDelta: pack.thresholds.dominance_margin_Delta,
        }
      : null,
    fieldSchema: pack.field_schema,
    // Synthesized policy block
    policy: {
      failClosed,
      minConfidence,
      escalationActionId,
    },
    // Synthesized actions (one entry per contract)
    actions,
    // Direct camelCase rename of full contracts array — preserved from original adapter
    contracts: pack.contracts.map((c) => ({
      contractId: c.contract_id,
      riskClass: c.risk_class,
      requiredFields: c.required_fields,
      limits: c.limits,
      needsConfirmation: c.needs_confirmation,
      denyByDefault: c.deny_by_default,
      capabilityRequirements: c.capability_requirements,
    })),
  };
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
  routerClientLog.info("CB_RT_SENTINEL_ROUTE_ENTER", {
    stageId: input.stageId,
    packId: input.packId,
    routerUrl: configManager.getRouterUrl(),
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // INVARIANT: allowedContractIds must be valid before routing
  // Hard-blocks with ClarityBurstAbstainError(ABSTAIN_CLARIFY, PACK_POLICY_INCOMPLETE)
  // if allowedContractIds contains duplicates or non-string values.
  // ─────────────────────────────────────────────────────────────────────────────
  validateAllowedContractIds(input.allowedContractIds, input.stageId);

  // ─────────────────────────────────────────────────────────────────────────────
  // EARLY SHORT-CIRCUIT: If ClarityBurst is disabled, return a deterministic
  // bypass result without any network activity, timeout machinery, or controller setup.
  // ─────────────────────────────────────────────────────────────────────────────
  if (!configManager.isEnabled()) {
    const disabledPayload: Record<string, unknown> = {
      stageId: input.stageId,
      packId: input.packId,
      contractId: input.allowedContractIds[0],
      mode: "disabled_bypass",
      governance: "CLARITYBURST_CONFIG",
    };
    const runId = typeof input.context?.runId === "string" ? input.context.runId : undefined;
    if (runId) {
      disabledPayload.runId = runId;
    }
    routerClientLog.info("CLARITYBURST_DISABLED_BYPASS", disabledPayload);

    // Return a deterministic error result indicating disabled mode (no network activity)
    // The disabled: true flag signals to callers that this is a bypass, not a routing failure
    return {
      ok: false,
      error: "ClarityBurst is disabled",
      disabled: true,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // PHASE A LOCAL SCORING: Run deterministic contract-based scoring when an
  // ontology pack is present (contracts[] → canonicalPhrases + keywordWeights).
  //
  // Per PHASE_A_DETERMINISTIC_SCORING_SPEC.md, scoring uses only:
  //   - contracts[].canonicalPhrases  (exact phrase match after normalization)
  //   - contracts[].keywordWeights    (weighted token overlap)
  //   - contracts[].scoring.lambdas   (lambda_phrase, lambda_keyword, lambda_semantic=0)
  //
  // actions[] is never used here. No network call is made.
  // Existing abstain/threshold/dominance behavior is enforced via meetsThreshold
  // and isDominant flags (thresholds.min_confidence_T, dominance_margin_Delta).
  // ─────────────────────────────────────────────────────────────────────────────
  if (input.pack) {
    const phaseAResult = scorePackPhaseA(input.pack, input.allowedContractIds, input.userText);

    routerClientLog.info("PHASE_A_LOCAL_SCORE", {
      stageId: input.stageId,
      packId: input.packId,
      top1ContractId: phaseAResult.top1.contract_id,
      top1Score: phaseAResult.top1.score,
      top2ContractId: phaseAResult.top2.contract_id,
      top2Score: phaseAResult.top2.score,
      meetsThreshold: phaseAResult.meetsThreshold,
      isDominant: phaseAResult.isDominant,
      router_version: phaseAResult.router_version,
    });

    return {
      ok: true,
      data: {
        top1: phaseAResult.top1,
        top2: phaseAResult.top2,
        router_version: phaseAResult.router_version,
      },
    };
  }

  const routerEndpoint = getRouterEndpoint();
  const timeoutMs = getTimeoutMs();

  console.log("[ClarityBurst Runtime] routeClarityBurst invoked", {
    stageId: input.stageId,
    packId: input.packId,
    "allowedContractIds.length": input.allowedContractIds.length,
    "userText.length": input.userText.length,
  });

  const t0 = Date.now();

  // Extract runId from context if available
  const runId = typeof input.context?.runId === "string" ? input.context.runId : undefined;

  let lastError: unknown;
  let controller: AbortController;
  let timeoutId: NodeJS.Timeout;

  for (let attempt = 1; attempt <= 2; attempt++) {
    controller = new AbortController();
    timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      routerClientLog.info("[routeClarityBurst] Routing request", {
        stageId: input.stageId,
        packId: input.packId,
        "allowedContractIds.length": input.allowedContractIds.length,
        routerUrl: routerEndpoint,
        attempt,
      });

      // Log router self-call being gated through NETWORK_IO
      const logStartPayload: Record<string, unknown> = {
        routerUrl: routerEndpoint,
        method: "POST",
        contractId: input.allowedContractIds[0],
        stageId: input.stageId,
        packId: input.packId,
        timeoutMs: timeoutMs,
        governance: "NETWORK_IO_GATE",
        callType: "ROUTER_SELF_CALL_INTERNAL",
        attempt,
      };
      if (runId) {
        logStartPayload.runId = runId;
      }
      routerClientLog.info("ROUTER_CALL_START", logStartPayload);

      // SECURITY: Router self-call bypasses NETWORK_IO gating (bypassGate=true) to prevent
      // infinite recursion: routeClarityBurst → applyNetworkIOGate → applyNetworkOverrides → routeClarityBurst.
      // Router invocation is trusted internal infrastructure; NETWORK_IO gate applies only to user-initiated requests.
      // Normalize the inline pack from local snake_case (OntologyPack) to the
      // router's camelCase validation shape before sending to /api/route.
      // [DIAG] Capture normalized pack once so pre-fetch diagnostics and bodyPayload share the same value.
      const _diagNormalizedPack = input.pack ? normalizePackForRouter(input.pack) : undefined;
      const bodyPayload = _diagNormalizedPack ? { ...input, pack: _diagNormalizedPack } : input;

      // [DIAG] Temporary pre-fetch diagnostics – one debugging pass only; remove after investigation.
      routerClientLog.info(
        `CB_DIAG_PRE_FETCH ${JSON.stringify({
          routerEndpoint,
          stageId: input.stageId,
          packId: input.packId,
          packVersion: input.packVersion,
          packPresent: _diagNormalizedPack !== undefined,
          normalizedPackTopLevelKeys: _diagNormalizedPack
            ? Object.keys(_diagNormalizedPack)
            : undefined,
          firstContractKeys:
            _diagNormalizedPack &&
            Array.isArray(_diagNormalizedPack.contracts) &&
            (_diagNormalizedPack.contracts as unknown[]).length > 0
              ? Object.keys((_diagNormalizedPack.contracts as Record<string, unknown>[])[0])
              : undefined,
          serializedBodyLength: JSON.stringify(bodyPayload).length,
          attempt,
        })}`,
      );

      // Build request headers. The Authorization header is included only when an API key
      // is configured — this allows the local dev stub (start-clarityburst-router.ts) to
      // run without requiring CLARITYBURST_API_KEY while ensuring every call to the
      // production Fly.io router is authenticated against its api_keys table.
      const apiKey = configManager.getApiKey();
      const requestHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiKey) {
        requestHeaders["Authorization"] = `Bearer ${apiKey}`;
      }
      if (input.sessionId) {
        requestHeaders["X-Session-Id"] = input.sessionId;
      }

      const response = await applyNetworkIOGateAndFetch(
        routerEndpoint,
        {
          method: "POST",
          headers: requestHeaders,
          body: JSON.stringify(bodyPayload),
          signal: controller.signal,
        },
        true,
      );

      // [DIAG] Temporary post-fetch diagnostics – one debugging pass only; remove after investigation.
      // Clone the response so the body stream remains available for the existing response.json() call below.
      const _diagRawBody = await response.clone().text();
      routerClientLog.info(
        `CB_DIAG_POST_FETCH ${JSON.stringify({
          httpStatus: response.status,
          rawBodyLength: _diagRawBody.length,
          rawBodyPreview: _diagRawBody.slice(0, 100),
        })}`,
      );

      clearTimeout(timeoutId);

      if (response.status >= 400) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const data = (await response.json()) as RouterResponseData;
      const t1 = Date.now();
      routerClientLog.info("ROUTER_CALL_SUCCESS", {
        stageId: input.stageId,
        packId: input.packId,
        top1ContractId: data.top1.contract_id,
        top1Score: data.top1.score,
        router_version: data.router_version,
        requestId: data.requestId,
        latencyMs: t1 - t0,
        attempt,
      });

      return {
        ok: true,
        data,
      };
    } catch (err: unknown) {
      clearTimeout(timeoutId);
      lastError = err;

      // Type guard to check if error has name and code properties
      const isErrorWithProps = (
        e: unknown,
      ): e is { name?: string; code?: string; message?: string } =>
        typeof e === "object" && e !== null;

      if (
        attempt === 1 &&
        isErrorWithProps(err) &&
        (err.name === "AbortError" || err.code === "ECONNREFUSED")
      ) {
        routerClientLog.warn("ROUTER_RETRY", {
          attempt,
          error:
            err.message ||
            (typeof err === "object" && err !== null ? JSON.stringify(err) : String(err)),
        });
        await delay(200);
        continue;
      }
      throw err;
    }
  }

  throw lastError || new Error("Router call failed after all attempts");
}
