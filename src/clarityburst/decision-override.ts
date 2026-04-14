/**
 * Decision Override Module for ClarityBurst
 *
 * Provides specialized override logic for the TOOL_DISPATCH_GATE stage,
 * implementing confirmation requirements based on contract risk levels.
 */

import type { OntologyPack, PackContract } from "./pack-registry";
import { loadPackOrAbstain } from "./pack-load";
import { routeClarityBurst } from "./router-client";
import {
  createFullCapabilities,
  deriveAllowedContracts,
  assertNonEmptyAllowedContracts,
  type RuntimeCapabilities,
} from "./allowed-contracts";
import { ClarityBurstAbstainError } from "./errors";
import { incRouter, incOutcome } from "./run-metrics.js";
import type { RunMetrics } from "./run-metrics.js";
import {
  checkCronDispatchCapability,
  isCronMode,
} from "./cron-dispatch-checker.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import configManager from "./config.js";
import { getUserText } from "./user-text-context.js";

const decisionOverrideLog = createSubsystemLogger("clarityburst-decision-override");

/**
 * Check if router-outage fail-closed mode is enabled via CLARITYBURST_ROUTER_REQUIRED=1.
 * When enabled, side-effectful operations fail-closed on router unavailability.
 */
function isRouterRequiredMode(): boolean {
  return process.env.CLARITYBURST_ROUTER_REQUIRED === "1";
}

/**
 * Classify whether an operation is side-effectful based on stage and context.
 * Side-effectful operations include writes, deletions, network posts, and command executions.
 * Read-only operations include reads and queries.
 *
 * @param stageId - The ClarityBurst stage identifier
 * @param context - The context object containing operation type and method
 * @returns true if the operation is side-effectful, false if read-only
 */
function isSideEffectfulOperation(stageId: string, context: Record<string, unknown>): boolean {
  // Read-only stages
  if (stageId === "TOOL_DISPATCH_GATE") {
    // Tool dispatch is routing only, no side effects
    return false;
  }

  // File system: classify by operation type
  if (stageId === "FILE_SYSTEM_OPS") {
    const operation = String(context.operation ?? "").toLowerCase();
    // Read operations are safe
    if (operation === "read" || operation === "stat" || operation === "ls" || operation === "readdir") {
      return false;
    }
    // All other operations (write, delete, mkdir, rmdir, etc.) are side-effectful
    return true;
  }

  // Network: classify by method/operation
  if (stageId === "NETWORK_IO") {
    const operation = String(context.operation ?? "").toLowerCase();
    // Safe read methods
    if (operation === "get" || operation === "head" || operation === "options") {
      return false;
    }
    // All other operations (post, put, delete, patch, etc.) are side-effectful
    return true;
  }

  // All other stages are inherently side-effectful
  // SHELL_EXEC, MESSAGE_EMIT, MEMORY_MODIFY, CRON_SCHEDULE, BROWSER_AUTOMATE,
  // NODE_INVOKE, CANVAS_UI, SUBAGENT_SPAWN, MEDIA_GENERATE
  return true;
}

/**
 * Handle router outage for side-effectful operations when CLARITYBURST_ROUTER_REQUIRED=1.
 * Returns an ABSTAIN_CLARIFY outcome if fail-closed is required, otherwise returns null.
 *
 * @param stageId - The ClarityBurst stage identifier
 * @param context - The context object for the operation
 * @returns An ABSTAIN_CLARIFY outcome if fail-closed applies, null otherwise
 */
function handleRouterOutageFailClosed(stageId: string, context: Record<string, unknown>): AbstainClarifyOutcome | null {
  if (!isRouterRequiredMode()) {
    // Flag not set; use existing behavior (fail-open for most)
    // DIAGNOSTIC: Log that fail-closed mode is NOT enabled
    const diagnosticPayload = {
      stageId,
      failClosedEnabled: false,
      diagnostic: "ROUTER_OUTAGE_FAIL_OPEN_MODE",
      description: "Router fail-closed mode is DISABLED (CLARITYBURST_ROUTER_REQUIRED not set) - router errors will be treated as fail-open (PROCEED)",
    };
    console.warn("[CLARITYBURST_DIAGNOSTIC] Router outage would use fail-open mode:", JSON.stringify(diagnosticPayload, null, 2));
    return null;
  }

  if (!isSideEffectfulOperation(stageId, context)) {
    // Read-only operations proceed even on router outage
    return null;
  }

  // Side-effectful operation with router unavailable and flag set: fail-closed
  return {
    outcome: "ABSTAIN_CLARIFY",
    reason: "ROUTER_UNAVAILABLE",
    contractId: null,
    stageId,
    instructions: `Router unavailable. System operating in read-only mode. Retry when service is restored.`,
  };
}

export type { OntologyPack, PackContract };

/** Router result structure */
export interface RouteResult {
  ok: boolean;
  data?: {
    top1?: {
      contract_id: string;
      score?: number;
      [key: string]: unknown;
    };
    top2?: {
      contract_id: string;
      score?: number;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Extract the router-originated requestId from a RouteResult.
 * Returns undefined when the router did not supply one (Phase-A local scoring,
 * disabled bypass, or router outage).
 */
function extractRequestId(routeResult: RouteResult): string | undefined {
  const rid = routeResult.data?.requestId;
  return typeof rid === "string" ? rid : undefined;
}

/**
 * Stamp `requestId` onto an OverrideOutcome when present.
 * Returns the same object reference (mutates in place for zero-alloc).
 */
function stampRequestId(outcome: OverrideOutcome, requestId: string | undefined): OverrideOutcome {
  if (requestId) {
    outcome.requestId = requestId;
  }
  return outcome;
}

/**
 * Validate that the router-returned contract ID is in the allowed list.
 * Returns an ABSTAIN_CLARIFY outcome with ROUTER_MISMATCH reason if not allowed,
 * otherwise returns null.
 */
function validateContractInAllowedList(
  routeResult: RouteResult,
  allowedContractIds: string[],
  stageId: string,
  requestId: string | undefined
): OverrideOutcome | null {
  const returnedId = routeResult.data?.top1?.contract_id;
  if (!returnedId) {
    // No contract ID returned - this should be handled by caller
    return null;
  }
  if (!allowedContractIds.includes(returnedId)) {
    return stampRequestId({
      outcome: "ABSTAIN_CLARIFY",
      reason: "ROUTER_MISMATCH",
      stageId,
      contractId: null,
      instructions: `Router returned contract ${returnedId} not in allowed list [${allowedContractIds.join(', ')}]`,
      nonRetryable: true,
    } as OverrideOutcome, requestId);
  }
  return null;
}

/** Context for the dispatch decision */
export interface DispatchContext {
  stageId?: string;
  userConfirmed?: boolean;
  runMetrics?: RunMetrics;
  [key: string]: unknown;
}

/** Outcome when confirmation is required */
export interface AbstainConfirmOutcome {
  outcome: "ABSTAIN_CONFIRM";
  reason: "CONFIRM_REQUIRED";
  contractId: string;
  /** Deterministic instructions for obtaining confirmation (includes placeholder token format) */
  instructions?: string;
  /** UUID v4 requestId from the router — propagated for cross-layer correlation */
  requestId?: string;
}

/** Outcome when clarification is needed due to router uncertainty or incomplete pack policy */
export interface AbstainClarifyOutcome {
  outcome: "ABSTAIN_CLARIFY";
  reason: "LOW_DOMINANCE_OR_CONFIDENCE" | "PACK_POLICY_INCOMPLETE" | "router_outage" | "capability_denied" | "ROUTER_UNAVAILABLE" | "EXCEEDS_FILE_SIZE_LIMIT" | "ROUTER_MISMATCH";
  contractId: string | null;
  /** Stage identifier for routing failures */
  stageId?: string;
  /** Deterministic instructions when pack policy is incomplete or router unavailable */
  instructions?: string;
  /** UUID v4 requestId from the router — propagated for cross-layer correlation */
  requestId?: string;
}

/** Outcome when proceeding normally */
export interface ProceedOutcome {
  outcome: "PROCEED";
  contractId: string | null;
  /** UUID v4 requestId from the router — propagated for cross-layer correlation */
  requestId?: string;
}

/** Union of all possible override outcomes */
export type OverrideOutcome = AbstainConfirmOutcome | AbstainClarifyOutcome | ProceedOutcome;

/** Reason type for ABSTAIN_CONFIRM outcomes */
export type AbstainConfirmReason = AbstainConfirmOutcome["reason"];

/** Reason type for ABSTAIN_CLARIFY outcomes */
export type AbstainClarifyReason = AbstainClarifyOutcome["reason"];

/** Combined reason type for any abstain outcome (CONFIRM or CLARIFY) */
export type AbstainReason = AbstainConfirmReason | AbstainClarifyReason;

/** Stage ID for tool dispatch gating */
const TOOL_DISPATCH_STAGE_ID = "TOOL_DISPATCH_GATE";

/** Stage ID for shell execution gating */
const SHELL_EXEC_STAGE_ID = "SHELL_EXEC";

/** Stage ID for file system operations gating */
const FILE_SYSTEM_OPS_STAGE_ID = "FILE_SYSTEM_OPS";

/** Stage ID for network I/O gating */
const NETWORK_IO_STAGE_ID = "NETWORK_IO";

/** Stage ID for memory modify gating */
const MEMORY_MODIFY_STAGE_ID = "MEMORY_MODIFY";

/** Stage ID for subagent spawn gating */
const SUBAGENT_SPAWN_STAGE_ID = "SUBAGENT_SPAWN";

/** Stage ID for node invoke gating */
const NODE_INVOKE_STAGE_ID = "NODE_INVOKE";

/** Stage ID for browser automate gating */
const BROWSER_AUTOMATE_STAGE_ID = "BROWSER_AUTOMATE";

/** Stage ID for cron schedule gating */
const CRON_SCHEDULE_STAGE_ID = "CRON_SCHEDULE";

/** Stage ID for message emit gating */
const MESSAGE_EMIT_STAGE_ID = "MESSAGE_EMIT";

/** Stage ID for media generate gating */
const MEDIA_GENERATE_STAGE_ID = "MEDIA_GENERATE";

/** Stage ID for canvas UI gating */
const CANVAS_UI_STAGE_ID = "CANVAS_UI";

/** Risk classes that require confirmation */
const HIGH_RISK_CLASSES: ReadonlySet<string> = new Set(["HIGH", "CRITICAL"]);

/**
 * Determines if a contract requires user confirmation before dispatch.
 *
 * @param contract - The contract to evaluate
 * @returns true if confirmation is required
 */
function contractRequiresConfirmation(contract: PackContract): boolean {
  if (contract.needs_confirmation === true) {
    return true;
  }
  
  if (contract.risk_class && HIGH_RISK_CLASSES.has(contract.risk_class)) {
    return true;
  }
  
  return false;
}

/**
 * Finds a contract by ID within the ontology pack.
 *
 * @param pack - The ontology pack to search
 * @param contractId - The contract ID to find
 * @returns The matching contract or undefined
 */
function findContractById(pack: OntologyPack, contractId: string): PackContract | undefined {
  return pack.contracts.find((c) => c.contract_id === contractId);
}

/**
 * Infer capability requirement from contract ID pattern.
 * Best-effort mapping to extract semantic capability from contract naming.
 *
 * @param contractId - The contract ID to analyze
 * @returns Inferred capability string (lowercased)
 */
function inferCapabilityFromContractId(contractId: string): string {
  // Lowercase for comparison
  const id = contractId.toLowerCase();
  
  // Map common patterns to capabilities
  if (id.includes("shell") || id.includes("exec") || id.includes("command")) {
    return "shell";
  }
  if (id.includes("file") || id.includes("fs") || id.includes("directory") || id.includes("path")) {
    return "file_system";
  }
  if (id.includes("network") || id.includes("http") || id.includes("request") || id.includes("api")) {
    return "network";
  }
  if (id.includes("memory") || id.includes("cache")) {
    return "sensitive_access";
  }
  if (id.includes("sensitive") || id.includes("credential") || id.includes("token")) {
    return "sensitive_access";
  }
  if (id.includes("browser")) {
    return "browser";
  }
  
  // Default to generic capability name based on contract ID
  return contractId.toLowerCase();
}

/**
 * Applies tool dispatch overrides for the TOOL_DISPATCH_GATE stage.
 *
 * This function evaluates whether a tool dispatch should proceed or require
 * user confirmation based on the contract's risk classification and
 * confirmation requirements. When in cron mode, also enforces capability-based
 * access control via CronPreflightGate checks.
 *
 * Behavior:
 * - If in cron mode: run preflight check (task locking + capability validation)
 *   - If check fails: ABSTAIN_CLARIFY with capability_denied reason (fail-closed)
 * - If routeResult is not ok: fail-open with PROCEED and null contractId
 * - If routeResult is ok:
 *   - Extracts contract_id from routeResult.data.top1.contract_id
 *   - Looks up contract in pack.contracts
 *   - If contract has needs_confirmation: true OR risk_class is HIGH/CRITICAL
 *     AND context.userConfirmed !== true: returns ABSTAIN_CONFIRM
 *   - Otherwise: returns PROCEED
 *
 * @param pack - The ontology pack containing contract definitions
 * @param routeResult - The result from the router
 * @param context - The dispatch context including userConfirmed flag and optional cronDecision
 * @returns The override outcome indicating whether to proceed or abstain
 *
 * @example
 * ```typescript
 * const pack = {
 *   contracts: [
 *     { contract_id: "shell_exec", risk_class: "HIGH" },
 *     { contract_id: "read_file", risk_class: "LOW" }
 *   ]
 * };
 *
 * const routeResult = { ok: true, data: { top1: { contract_id: "shell_exec" } } };
 * const context = { stageId: "TOOL_DISPATCH_GATE", userConfirmed: false };
 *
 * const result = applyToolDispatchOverrides(pack, routeResult, context);
 * // Returns: { outcome: "ABSTAIN_CONFIRM", reason: "CONFIRM_REQUIRED", contractId: "shell_exec" }
 * ```
 */
export function applyToolDispatchOverrides(
  pack: OntologyPack,
  routeResult: RouteResult,
  context: DispatchContext
): OverrideOutcome {
  const requestId = extractRequestId(routeResult);

  decisionOverrideLog.info("CB_RT_SENTINEL_TOOL_DISPATCH_ENTER", {
    stageId: context.stageId ?? null,
    packId: pack?.pack_id ?? null,
    routeOk: routeResult?.ok ?? null,
  });

  decisionOverrideLog.info("CB_RT_SENTINEL_ENV", { CB_TRACE_ONCE: process.env.CB_TRACE_ONCE ?? null });

  if (process.env.CB_TRACE_ONCE === "1") {
    decisionOverrideLog.info("CB_RT_SENTINEL_TDG_STACK", { stack: new Error("CB_TRACE").stack });
  }

  // Fail-closed: if router result is not ok, abstain with router_outage reason
  if (!routeResult.ok) {
    decisionOverrideLog.info('CB_RT_SENTINEL_TDG_RETURN_1', { reason: "router_outage", outcome: "ABSTAIN_CLARIFY" });
    return stampRequestId({
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      contractId: null,
    }, requestId);
  }

  // Extract contract ID and scores from router result
  const top1 = routeResult.data?.top1;
  const top2 = routeResult.data?.top2;
  const contractId = top1?.contract_id;
  
  // If no contract ID found, fail-open
  if (!contractId) {
    decisionOverrideLog.info('CB_RT_SENTINEL_TDG_RETURN_2', { outcome: "PROCEED", reason: null });
    return stampRequestId({
      outcome: "PROCEED",
      contractId: null,
    }, requestId);
  }

  // Validate router-returned contract ID is in allowed list
  const caps: RuntimeCapabilities = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts(TOOL_DISPATCH_STAGE_ID, pack, caps);
  const mismatch = validateContractInAllowedList(routeResult, allowedContractIds, TOOL_DISPATCH_STAGE_ID, requestId);
  if (mismatch) {return mismatch;}

  // ===== CRON PREFLIGHT GATE CHECK =====
  // Before any tool dispatch, check if in cron mode.
  // If cron mode: require locked task + capability check (fail-closed)
  if (isCronMode(context)) {
    // Infer capability requirement from contract ID pattern
    // This is a best-effort mapping; specific capabilities depend on contract semantics
    const inferredCapability = inferCapabilityFromContractId(contractId);
    const cronCheck = checkCronDispatchCapability(context, inferredCapability);
    
    if (!cronCheck.allowed) {
      // Fail-closed: block dispatch with ABSTAIN_CLARIFY
      return stampRequestId({
        outcome: "ABSTAIN_CLARIFY",
        reason: "capability_denied",
        contractId,
        stageId: TOOL_DISPATCH_STAGE_ID,
        instructions: cronCheck.reason || "Cron task capability check failed",
      }, requestId);
    }
  }

  // Check for router uncertainty before confirmation gating
  const thresholds = pack.thresholds;
  if (thresholds && top1?.score !== undefined) {
    const top1Score = top1.score;
    const minConfidenceT = thresholds.min_confidence_T;
    const dominanceMarginDelta = thresholds.dominance_margin_Delta;

    // Check if confidence is below threshold
    const lowConfidence = minConfidenceT !== undefined && top1Score < minConfidenceT;

    // Check if dominance margin is insufficient (when top2 exists)
    const lowDominance = top2?.score !== undefined &&
      dominanceMarginDelta !== undefined &&
      (top1Score - top2.score) < dominanceMarginDelta;

    if (lowConfidence || lowDominance) {
      return stampRequestId({
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
        contractId,
      }, requestId);
    }
  }

  // Look up the contract in the pack
  const contract = findContractById(pack, contractId);
  
  // If contract not found in pack, proceed (fail-open)
  if (!contract) {
    return stampRequestId({
      outcome: "PROCEED",
      contractId,
    }, requestId);
  }

  // Check if confirmation is required and not yet provided
  if (contractRequiresConfirmation(contract) && context.userConfirmed !== true) {
    return stampRequestId({
      outcome: "ABSTAIN_CONFIRM",
      reason: "CONFIRM_REQUIRED",
      contractId,
    }, requestId);
  }

  // Default: proceed with the dispatch
  return stampRequestId({
    outcome: "PROCEED",
    contractId,
  }, requestId);
}

/** Context for shell execution decision */
export interface ShellExecContext {
  stageId?: string;
  userConfirmed?: boolean;
  command?: string;
  runMetrics?: RunMetrics;
  [key: string]: unknown;
}

/**
 * Applies shell execution overrides for the SHELL_EXEC stage.
 *
 * This function evaluates whether a shell command execution should proceed or require
 * user confirmation based on the contract's risk classification and
 * confidence/dominance thresholds.
 *
 * Behavior:
 * - If routeResult is not ok: fail-open with PROCEED and null contractId
 * - If routeResult is ok:
 *   - Extracts contract_id from routeResult.data.top1.contract_id
 *   - Checks thresholds for low confidence/dominance → ABSTAIN_CLARIFY
 *   - Looks up contract in pack.contracts
 *   - If contract has needs_confirmation: true OR risk_class is HIGH/CRITICAL
 *     AND context.userConfirmed !== true: returns ABSTAIN_CONFIRM
 *   - Otherwise: returns PROCEED
 *
 * @param pack - The ontology pack containing contract definitions
 * @param routeResult - The result from the router
 * @param context - The shell exec context including userConfirmed flag
 * @returns The override outcome indicating whether to proceed or abstain
 *
 * @example
 * ```typescript
 * const pack = getPackForStage("SHELL_EXEC");
 * const routeResult = { ok: true, data: { top1: { contract_id: "SHELL_PIPE_COMMANDS", score: 0.95 } } };
 * const context = { stageId: "SHELL_EXEC", userConfirmed: false, command: "cat file | grep pattern" };
 *
 * const result = applyShellExecOverrides(pack, routeResult, context);
 * // Returns: { outcome: "ABSTAIN_CONFIRM", reason: "CONFIRM_REQUIRED", contractId: "SHELL_PIPE_COMMANDS" }
 * ```
 */
export function applyShellExecOverrides(
    pack: OntologyPack,
    routeResult: RouteResult,
    context: ShellExecContext
  ): OverrideOutcome {
    const requestId = extractRequestId(routeResult);

    // Check if fail-closed mode applies for side-effectful operations on router outage
    const failClosedOutcome = handleRouterOutageFailClosed(SHELL_EXEC_STAGE_ID, context);
    if (failClosedOutcome && !routeResult.ok) {
      // DIAGNOSTIC: Log when fail-closed would block
      const diagnosticPayload = {
        stageId: SHELL_EXEC_STAGE_ID,
        routerOk: routeResult.ok,
        failClosedTriggered: true,
        outcome: failClosedOutcome.outcome,
        diagnostic: "SHELL_EXEC_ROUTER_FAIL_CLOSED_BLOCKED",
      };
      console.warn("[CLARITYBURST_DIAGNOSTIC] Shell exec blocked by fail-closed mode:", JSON.stringify(diagnosticPayload, null, 2));
      return stampRequestId(failClosedOutcome, requestId);
    }

    // Fail-closed: if router result is not ok, abstain with router_outage
    if (!routeResult.ok) {
      // DIAGNOSTIC: Log when fail-closed blocks execution after router error
      const diagnosticPayload = {
        stageId: SHELL_EXEC_STAGE_ID,
        routerOk: routeResult.ok,
        failClosedTriggered: true,
        diagnostic: "SHELL_EXEC_ROUTER_FAIL_CLOSED_BLOCKED",
      };
      console.warn("[CLARITYBURST_DIAGNOSTIC] Shell exec blocked via fail-closed after router error:", JSON.stringify(diagnosticPayload, null, 2));
      return stampRequestId({
        outcome: "ABSTAIN_CLARIFY",
        reason: "router_outage",
        contractId: null,
        stageId: "SHELL_EXEC",
        nonRetryable: true,
      } as OverrideOutcome, requestId);
    }

  // Extract contract ID and scores from router result
  const top1 = routeResult.data?.top1;
  const top2 = routeResult.data?.top2;
  const contractId = top1?.contract_id;
  
  // If no contract ID found, fail-open
  if (!contractId) {
    return stampRequestId({
      outcome: "PROCEED",
      contractId: null,
    }, requestId);
  }

  // Validate router-returned contract ID is in allowed list
  const caps: RuntimeCapabilities = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts(SHELL_EXEC_STAGE_ID, pack, caps);
  const mismatch = validateContractInAllowedList(routeResult, allowedContractIds, SHELL_EXEC_STAGE_ID, requestId);
  if (mismatch) {return mismatch;}

  // Check for router uncertainty before confirmation gating
  // Enforce ABSTAIN_CLARIFY on low confidence/dominance
  const thresholds = pack.thresholds;
  if (thresholds && top1?.score !== undefined) {
    const top1Score = top1.score;
    const minConfidenceT = thresholds.min_confidence_T;
    const dominanceMarginDelta = thresholds.dominance_margin_Delta;

    // Check if confidence is below threshold
    const lowConfidence = minConfidenceT !== undefined && top1Score < minConfidenceT;

    // Check if dominance margin is insufficient (when top2 exists)
    const lowDominance = top2?.score !== undefined &&
      dominanceMarginDelta !== undefined &&
      (top1Score - top2.score) < dominanceMarginDelta;

    if (lowConfidence || lowDominance) {
      return stampRequestId({
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
        contractId,
      }, requestId);
    }
  }

  // Look up the contract in the pack
  const contract = findContractById(pack, contractId);
  
  // If contract not found in pack, proceed (fail-open)
  if (!contract) {
    return stampRequestId({
      outcome: "PROCEED",
      contractId,
    }, requestId);
  }

  // Check if confirmation is required and not yet provided
  // Enforce ABSTAIN_CONFIRM for HIGH/CRITICAL risk classes without confirmation token
  if (contractRequiresConfirmation(contract) && context.userConfirmed !== true) {
    return stampRequestId({
      outcome: "ABSTAIN_CONFIRM",
      reason: "CONFIRM_REQUIRED",
      contractId,
    }, requestId);
  }

  // Default: proceed with the execution
  return stampRequestId({
    outcome: "PROCEED",
    contractId,
  }, requestId);
}

/** Context for file system operation decision */
export interface FileSystemContext {
  stageId?: string;
  userConfirmed?: boolean;
  /** File operation type (e.g., "read", "write", "delete", "mkdir") */
  operation?: string;
  /** Target file or directory path */
  path?: string;
  /** File size in bytes (for write/append operations) */
  fileSize?: number;
  runMetrics?: RunMetrics;
  [key: string]: unknown;
}

/**
 * Internal implementation for file system operation overrides.
 *
 * This function evaluates whether a file system operation should proceed or require
 * user confirmation based on the contract's risk classification and
 * confidence/dominance thresholds.
 *
 * Behavior:
 * - If routeResult is not ok: fail-open with PROCEED and null contractId
 * - If routeResult is ok:
 *   - Extracts contract_id from routeResult.data.top1.contract_id
 *   - Checks thresholds for low confidence/dominance → ABSTAIN_CLARIFY
 *   - Looks up contract in pack.contracts
 *   - If contract has needs_confirmation: true OR risk_class is HIGH/CRITICAL
 *     AND context.userConfirmed !== true: returns ABSTAIN_CONFIRM
 *   - Otherwise: returns PROCEED
 *
 * @param pack - The ontology pack containing contract definitions
 * @param routeResult - The result from the router
 * @param context - The file system context including userConfirmed flag
 * @returns The override outcome indicating whether to proceed or abstain
 *
 * @example
 * ```typescript
 * const pack = getPackForStage("FILE_SYSTEM_OPS");
 * const routeResult = { ok: true, data: { top1: { contract_id: "FS_DELETE_FILE", score: 0.95 } } };
 * const context = { stageId: "FILE_SYSTEM_OPS", userConfirmed: false, operation: "delete", path: "/tmp/file.txt" };
 *
 * const result = applyFileSystemOverridesImpl(pack, routeResult, context);
 * // Returns: { outcome: "ABSTAIN_CONFIRM", reason: "CONFIRM_REQUIRED", contractId: "FS_DELETE_FILE" }
 * ```
 */
function applyFileSystemOverridesImpl(
  pack: OntologyPack,
  routeResult: RouteResult,
  context: FileSystemContext
): OverrideOutcome {
  const requestId = extractRequestId(routeResult);

  // Check if fail-closed mode applies for side-effectful operations on router outage
  const failClosedOutcome = handleRouterOutageFailClosed(FILE_SYSTEM_OPS_STAGE_ID, context);
  if (failClosedOutcome && !routeResult.ok) {
    // DIAGNOSTIC: Log when fail-closed would block
    const diagnosticPayload = {
      stageId: FILE_SYSTEM_OPS_STAGE_ID,
      routerOk: routeResult.ok,
      failClosedTriggered: true,
      outcome: failClosedOutcome.outcome,
      diagnostic: "FILE_SYSTEM_OPS_ROUTER_FAIL_CLOSED_BLOCKED",
    };
    console.warn("[CLARITYBURST_DIAGNOSTIC] File system ops blocked by fail-closed mode:", JSON.stringify(diagnosticPayload, null, 2));
    return stampRequestId(failClosedOutcome, requestId);
  }

  // Fail-closed: if router result is not ok, abstain with router_outage
  if (!routeResult.ok) {
    // DIAGNOSTIC: Log when fail-closed blocks execution after router error
    const diagnosticPayload = {
      stageId: FILE_SYSTEM_OPS_STAGE_ID,
      routerOk: routeResult.ok,
      failClosedTriggered: true,
      diagnostic: "FILE_SYSTEM_OPS_ROUTER_FAIL_CLOSED_BLOCKED",
    };
    console.warn("[CLARITYBURST_DIAGNOSTIC] File system ops blocked via fail-closed after router error:", JSON.stringify(diagnosticPayload, null, 2));
    return stampRequestId({
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      contractId: null,
      stageId: "FILE_SYSTEM_OPS",
      nonRetryable: true,
    } as OverrideOutcome, requestId);
  }

  // Extract contract ID and scores from router result
  const top1 = routeResult.data?.top1;
  const top2 = routeResult.data?.top2;
  const contractId = top1?.contract_id;
  
  // If no contract ID found, fail-open
  if (!contractId) {
    return {
      outcome: "PROCEED",
      contractId: null,
    };
  }

  // Validate contract ID is in allowed list (router mismatch check)
  const caps: RuntimeCapabilities = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts(FILE_SYSTEM_OPS_STAGE_ID, pack, caps);
  const mismatchValidation = validateContractInAllowedList(routeResult, allowedContractIds, FILE_SYSTEM_OPS_STAGE_ID, requestId);
  if (mismatchValidation) {
    return mismatchValidation;
  }

  // Strictly pack-driven uncertainty gating for FILE_SYSTEM_OPS
  // Thresholds MUST come from pack config - no hardcoded defaults
  const thresholds = pack.thresholds;
  const minConfidenceT = thresholds?.min_confidence_T;
  const dominanceMarginDelta = thresholds?.dominance_margin_Delta;

  // Hard-block if either threshold is missing/undefined - pack policy is incomplete
  if (minConfidenceT === undefined || dominanceMarginDelta === undefined) {
    const missingFields: string[] = [];
    if (minConfidenceT === undefined) {missingFields.push("min_confidence_T");}
    if (dominanceMarginDelta === undefined) {missingFields.push("dominance_margin_Delta");}
    
    return {
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `FILE_SYSTEM_OPS pack policy is incomplete. Missing required threshold(s): ${missingFields.join(", ")}. Update the pack configuration to include these values before proceeding.`,
    };
  }

  // Apply uncertainty gating with pack-driven thresholds
  if (top1?.score !== undefined) {
    const top1Score = top1.score;

    // Check if confidence is below threshold (top1 < T)
    const lowConfidence = top1Score < minConfidenceT;

    // Check if dominance margin is insufficient (top1 - top2 < Δ)
    const lowDominance = top2?.score !== undefined &&
      (top1Score - top2.score) < dominanceMarginDelta;

    if (lowConfidence || lowDominance) {
      return {
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
        contractId,
      };
    }
  }

  // Look up the contract in the pack
  const contract = findContractById(pack, contractId);
  
  // If contract not found in pack, proceed (fail-open)
  if (!contract) {
    return {
      outcome: "PROCEED",
      contractId,
    };
  }

  // Validate contract limits (e.g., max_file_size_mb for write operations)
  if (contract.limits && context.fileSize !== undefined) {
    const maxFileSizeMb = contract.limits.max_file_size_mb;
    if (typeof maxFileSizeMb === 'number' && maxFileSizeMb > 0) {
      const maxSizeBytes = maxFileSizeMb * 1024 * 1024;
      if (context.fileSize > maxSizeBytes) {
        return {
          outcome: "ABSTAIN_CLARIFY",
          reason: "EXCEEDS_FILE_SIZE_LIMIT",
          contractId,
          instructions: `File size (${(context.fileSize / 1024 / 1024).toFixed(1)}MB) exceeds contract limit of ${maxFileSizeMb}MB for contract ${contractId}`,
        };
      }
    }
  }

  // Check if confirmation is required and not yet provided
  // Enforce ABSTAIN_CONFIRM for HIGH/CRITICAL risk classes or needs_confirmation without confirmation token
  if (contractRequiresConfirmation(contract) && context.userConfirmed !== true) {
    return {
      outcome: "ABSTAIN_CONFIRM",
      reason: "CONFIRM_REQUIRED",
      contractId,
    };
  }

  // Default: proceed with the operation
  return {
    outcome: "PROCEED",
    contractId,
  };
}

/**
 * Applies file system operation overrides for the FILE_SYSTEM_OPS stage.
 *
 * Canonical exported entrypoint that takes only a context object and performs
 * the full commit-point flow internally: load pack → derive allowed contracts →
 * assert non-empty → route through ClarityBurst → apply local overrides.
 *
 * Behavior:
 * - Loads the FILE_SYSTEM_OPS pack
 * - Derives allowed contract IDs based on runtime capabilities
 * - Routes through ClarityBurst with assembled context fields
 * - On router outage: returns ABSTAIN_CLARIFY with router_outage reason
 * - On pack policy incomplete: returns ABSTAIN_CLARIFY with appropriate reason
 * - On low dominance/confidence: returns ABSTAIN_CLARIFY
 * - On confirmation required: returns ABSTAIN_CONFIRM
 * - Otherwise: returns PROCEED
 *
 * @param context - The file system context (operation, path, userConfirmed, etc.)
 * @returns A Promise of the override outcome indicating whether to proceed or abstain
 *
 * @example
 * ```typescript
 * const context: FileSystemContext = {
 *   stageId: "FILE_SYSTEM_OPS",
 *   userConfirmed: false,
 *   operation: "delete",
 *   path: "/tmp/file.txt"
 * };
 *
 * const result = await applyFileSystemOverrides(context);
 * // Returns: { outcome: "PROCEED", contractId: "FS_DELETE_FILE" }
 * ```
 */
export async function applyFileSystemOverrides(
  context: FileSystemContext
): Promise<OverrideOutcome> {
  // Stage integrity guard: reject if invoked with wrong stageId
  if (context.stageId !== undefined && context.stageId !== FILE_SYSTEM_OPS_STAGE_ID) {
    return {
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `applyFileSystemOverrides was invoked with stageId "${context.stageId}" but expects "${FILE_SYSTEM_OPS_STAGE_ID}". Fix the wiring to use the correct stage override function.`,
    };
  }

  // Early exit if ClarityBurst is disabled
  if (!configManager.isEnabled()) {
    return {
      outcome: "PROCEED",
      contractId: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SINGLE SOURCE OF TRUTH: Load pack and derive allowed contracts
  // ─────────────────────────────────────────────────────────────────────────────
  const pack = loadPackOrAbstain(FILE_SYSTEM_OPS_STAGE_ID);
  const caps: RuntimeCapabilities = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts(FILE_SYSTEM_OPS_STAGE_ID, pack, caps);
  assertNonEmptyAllowedContracts(FILE_SYSTEM_OPS_STAGE_ID, allowedContractIds);

  // Route through ClarityBurst to get router result for FILE_SYSTEM_OPS stage
  let routeResult: RouteResult;
  try {
    context.runMetrics && incRouter(context.runMetrics);
    const routerRes = await routeClarityBurst({
      stageId: FILE_SYSTEM_OPS_STAGE_ID,
      packId: pack.pack_id,
      packVersion: pack.pack_version,
      allowedContractIds,
      userText: getUserText(),
      context: { operation: context.operation ?? "", path: context.path ?? "" },
      pack,
    });
    routeResult = routerRes as unknown as RouteResult;
  } catch {
    // Router error: check if fail-closed mode applies
    const failClosedOutcome = handleRouterOutageFailClosed(FILE_SYSTEM_OPS_STAGE_ID, context);
    if (failClosedOutcome) {
      context.runMetrics && incOutcome(context.runMetrics, failClosedOutcome.outcome);
      return failClosedOutcome;
    }
    // Existing behavior: return router_outage outcome
    const outcome: OverrideOutcome = {
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      contractId: null,
      instructions: "ClarityBurst router unavailable; file system operations are blocked for safety.",
    };
    context.runMetrics && incOutcome(context.runMetrics, outcome.outcome);
    return outcome;
  }

  // Apply local overrides using the impl function
  const result = applyFileSystemOverridesImpl(pack, routeResult, context);
  context.runMetrics && incOutcome(context.runMetrics, result.outcome);
  return stampRequestId(result, extractRequestId(routeResult));
}

/** Context for network I/O operation decision */
export interface NetworkIOContext {
  stageId?: string;
  userConfirmed?: boolean;
  /** Original user text for routing (optional, falls back to ambient getUserText()) */
  userText?: string;
  /** Network operation type (e.g., "fetch", "connect", "listen") */
  operation?: string;
  /** Target URL or host */
  url?: string;
  runMetrics?: RunMetrics;
  [key: string]: unknown;
}

/** Type alias for NetworkIOContext used as the canonical context for NETWORK_IO stage routing */
export type NetworkContext = NetworkIOContext;

/**
 * Internal implementation for network I/O overrides.
 *
 * This function evaluates whether a network I/O operation should proceed or require
 * user confirmation based on the contract's risk classification and
 * confidence/dominance thresholds.
 *
 * Behavior:
 * - If routeResult is not ok: fail-open with PROCEED and null contractId
 * - If routeResult is ok:
 *   - Extracts contract_id from routeResult.data.top1.contract_id
 *   - Validates that pack thresholds are defined → ABSTAIN_CLARIFY if missing
 *   - Checks thresholds for low confidence/dominance → ABSTAIN_CLARIFY
 *   - Looks up contract in pack.contracts
 *   - If contract has needs_confirmation: true OR risk_class is HIGH/CRITICAL
 *     AND context.userConfirmed !== true: returns ABSTAIN_CONFIRM
 *   - Otherwise: returns PROCEED
 *
 * @param pack - The ontology pack containing contract definitions
 * @param routeResult - The result from the router
 * @param context - The network I/O context including userConfirmed flag
 * @returns The override outcome indicating whether to proceed or abstain
 *
 * @example
 * ```typescript
 * const pack = getPackForStage("NETWORK_IO");
 * const routeResult = { ok: true, data: { top1: { contract_id: "NETWORK_POST_DATA", score: 0.95 } } };
 * const context = { stageId: "NETWORK_IO", userConfirmed: false, operation: "fetch", url: "https://api.example.com" };
 *
 * const result = applyNetworkOverridesImpl(pack, routeResult, context);
 * // Returns: { outcome: "PROCEED", contractId: "NETWORK_POST_DATA" }
 * ```
 */
function applyNetworkOverridesImpl(
  pack: OntologyPack,
  routeResult: RouteResult,
  context: NetworkIOContext
): OverrideOutcome {
  const requestId = extractRequestId(routeResult);
  
  // Stage integrity guard: reject if invoked with wrong stageId
  if (context.stageId !== undefined && context.stageId !== NETWORK_IO_STAGE_ID) {
    return {
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `applyNetworkOverrides was invoked with stageId "${context.stageId}" but expects "${NETWORK_IO_STAGE_ID}". Fix the wiring to use the correct stage override function.`,
    };
  }

  // Defensive hard-block: if router result is not ok, abstain with router_outage
  if (!routeResult.ok) {
    return {
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      stageId: "NETWORK_IO",
      contractId: null,
      instructions: "The router is unavailable and network operations cannot proceed. Retry when the router service is restored.",
    };
  }

  // Extract contract ID and scores from router result
  const top1 = routeResult.data?.top1;
  const top2 = routeResult.data?.top2;
  const contractId = top1?.contract_id ?? null;

  // Validate contract ID is in allowed list (router mismatch check)
  const caps: RuntimeCapabilities = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts(NETWORK_IO_STAGE_ID, pack, caps);
  const mismatchValidation = validateContractInAllowedList(routeResult, allowedContractIds, NETWORK_IO_STAGE_ID, requestId);
  if (mismatchValidation) {
    return mismatchValidation;
  }

  // Build a Set of contract IDs from pack
  const packContractIds = new Set(pack.contracts.map(c => c.contract_id));

  // Define router mismatch condition
  const routerMismatch = contractId !== null && !packContractIds.has(contractId);

  if (routerMismatch) {
    // fail-open on router mismatch
    return {
      outcome: "PROCEED",
      contractId: null,
    };
  }

  // If no contract ID found, fail-open
  if (!contractId) {
    return {
      outcome: "PROCEED",
      contractId: null,
    };
  }

  // Strictly pack-driven uncertainty gating for NETWORK_IO
  // Thresholds MUST come from pack config - no hardcoded defaults
  const thresholds = pack.thresholds;
  const minConfidenceT = thresholds?.min_confidence_T;
  const dominanceMarginDelta = thresholds?.dominance_margin_Delta;

  // Hard-block if either threshold is missing/undefined - pack policy is incomplete
  if (minConfidenceT === undefined || dominanceMarginDelta === undefined) {
    const missingFields: string[] = [];
    if (minConfidenceT === undefined) {missingFields.push("min_confidence_T");}
    if (dominanceMarginDelta === undefined) {missingFields.push("dominance_margin_Delta");}
    
    return {
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `NETWORK_IO pack policy is incomplete. Missing required threshold(s): ${missingFields.join(", ")}. Update the pack configuration to include these values before proceeding.`,
    };
  }

  // Apply uncertainty gating with pack-driven thresholds
  if (top1?.score !== undefined) {
    const top1Score = top1.score;

    // Check if confidence is below threshold (top1.score < min_confidence_T)
    const lowConfidence = top1Score < minConfidenceT;

    // Check if dominance margin is insufficient (top1.score - top2.score < dominance_margin_Delta)
    const lowDominance = top2?.score !== undefined &&
      (top1Score - top2.score) < dominanceMarginDelta;

    if (lowConfidence || lowDominance) {
      return {
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
        contractId,
      };
    }
  }

  // Look up the contract in the pack
  const contract = findContractById(pack, contractId);
  
  // If contract not found in pack, proceed (fail-open)
  if (!contract) {
    return {
      outcome: "PROCEED",
      contractId,
    };
  }

  // Explicit guard: if confirmation is required but not confirmed, abstain
  // This handles both false and undefined cases with a clear, deterministic outcome
  if (contractRequiresConfirmation(contract) && context.userConfirmed !== true) {
    return {
      outcome: "ABSTAIN_CONFIRM",
      reason: "CONFIRM_REQUIRED",
      contractId,
      instructions: `This operation requires user confirmation. Contract "${contractId}" has risk_class="${contract.risk_class}" or needs_confirmation=true. To proceed, the caller must set userConfirmed=true after obtaining explicit user consent. The wrapper will provide the exact token; for NETWORK_IO it follows: CONFIRM NETWORK_IO <CONTRACT_ID> <opHash8>.`,
    };
  }

  // Default: proceed with the operation
  return {
    outcome: "PROCEED",
    contractId,
  };
}

/**
 * Synchronous wrapper for applying network I/O overrides.
 *
 * This function takes a pack, routeResult, and context, and applies the override logic directly.
 * It does NOT perform the full commit-point flow (pack loading, routing, etc.) - that is only
 * done by the async context-only version.
 *
 * This wrapper is primarily used for testing and backward compatibility.
 *
 * @param pack - The ontology pack containing contract definitions
 * @param routeResult - The result from the router
 * @param context - The network I/O context including userConfirmed flag
 * @returns The override outcome indicating whether to proceed or abstain
 */
export function applyNetworkOverrides(
  pack: OntologyPack,
  routeResult: RouteResult,
  context: NetworkIOContext
): OverrideOutcome;

/**
 * Applies network I/O overrides for the NETWORK_IO stage.
 *
 * Canonical exported entrypoint that takes only a context object and performs
 * the full commit-point flow internally: load pack → derive allowed contracts →
 * assert non-empty → route through ClarityBurst → apply local overrides.
 *
 * Behavior:
 * - Loads the NETWORK_IO pack
 * - Derives allowed contract IDs based on runtime capabilities
 * - Routes through ClarityBurst with assembled context fields
 * - On router outage: returns ABSTAIN_CLARIFY with router_outage reason
 * - On router mismatch: fail-open with PROCEED and null contractId
 * - On pack policy incomplete: returns ABSTAIN_CLARIFY with appropriate reason
 * - On low dominance/confidence: returns ABSTAIN_CLARIFY
 * - On confirmation required: returns ABSTAIN_CONFIRM
 * - Otherwise: returns PROCEED
 *
 * @param context - The network I/O context (operation, url, userConfirmed, etc.)
 * @returns A Promise of the override outcome indicating whether to proceed or abstain
 *
 * @example
 * ```typescript
 * const context: NetworkContext = {
 *   stageId: "NETWORK_IO",
 *   userConfirmed: false,
 *   operation: "fetch",
 *   url: "https://api.example.com"
 * };
 *
 * const result = await applyNetworkOverrides(context);
 * // Returns: { outcome: "PROCEED", contractId: "NETWORK_POST_DATA" }
 * ```
 */
export function applyNetworkOverrides(
  context: NetworkContext
): Promise<OverrideOutcome>;

export function applyNetworkOverrides(
  packOrContext: OntologyPack | NetworkContext,
  routeResult?: RouteResult,
  context?: NetworkIOContext
): OverrideOutcome | Promise<OverrideOutcome> {
  // Overload: if routeResult is provided, call the sync impl
  if (routeResult !== undefined) {
    return applyNetworkOverridesImpl(
      packOrContext as OntologyPack,
      routeResult,
      context as NetworkIOContext
    );
  }

  // Otherwise, perform the async commit-point flow
  return applyNetworkOverridesAsync(packOrContext as NetworkContext);
}

async function applyNetworkOverridesAsync(
  context: NetworkContext
): Promise<OverrideOutcome> {
  // Stage integrity guard: reject if invoked with wrong stageId
  if (context.stageId !== undefined && context.stageId !== NETWORK_IO_STAGE_ID) {
    return {
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `applyNetworkOverrides was invoked with stageId "${context.stageId}" but expects "${NETWORK_IO_STAGE_ID}". Fix the wiring to use the correct stage override function.`,
    };
  }

  // Early exit if ClarityBurst is disabled
  if (!configManager.isEnabled()) {
    return {
      outcome: "PROCEED",
      contractId: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SINGLE SOURCE OF TRUTH: Load pack and derive allowed contracts
  // ─────────────────────────────────────────────────────────────────────────────
  const pack = loadPackOrAbstain(NETWORK_IO_STAGE_ID);
  const caps: RuntimeCapabilities = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts(NETWORK_IO_STAGE_ID, pack, caps);
  assertNonEmptyAllowedContracts(NETWORK_IO_STAGE_ID, allowedContractIds);

  // Route through ClarityBurst to get router result for NETWORK_IO stage
  let routeResult: RouteResult;
  try {
    context.runMetrics && incRouter(context.runMetrics);
    const routerRes = await routeClarityBurst({
      stageId: NETWORK_IO_STAGE_ID,
      packId: pack.pack_id,
      packVersion: pack.pack_version,
      allowedContractIds,
      userText: context.userText !== undefined ? context.userText : getUserText(),
      context: { operation: context.operation ?? "", url: context.url ?? "" },
      pack,
    });
    routeResult = routerRes as unknown as RouteResult;
  } catch {
    // Router error: check if fail-closed mode applies
    const failClosedOutcome = handleRouterOutageFailClosed(NETWORK_IO_STAGE_ID, context);
    if (failClosedOutcome) {
      context.runMetrics && incOutcome(context.runMetrics, failClosedOutcome.outcome);
      return failClosedOutcome;
    }
    // Existing behavior: return router_outage outcome
    const outcome: OverrideOutcome = {
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      stageId: NETWORK_IO_STAGE_ID,
      contractId: null,
      instructions: "The router is unavailable and network operations cannot proceed. Retry when the router service is restored.",
    };
    context.runMetrics && incOutcome(context.runMetrics, outcome.outcome);
    return outcome;
  }

  // Apply local overrides using the impl function
  const result = applyNetworkOverridesImpl(pack, routeResult, context);
  context.runMetrics && incOutcome(context.runMetrics, result.outcome);
  return stampRequestId(result, extractRequestId(routeResult));
}

/** Context for memory modification decision */
export interface MemoryModifyContext {
  stageId?: string;
  runMetrics?: RunMetrics;
  [key: string]: unknown;
}

/**
 * Internal implementation for memory modification overrides.
 *
 * This function evaluates whether a memory modification operation should proceed
 * based on router availability. The MEMORY_MODIFY stage fails closed on router outage.
 *
 * Behavior:
 * - If routeResult is not ok: throw ClarityBurstAbstainError with router_outage reason
 * - If routeResult is ok: returns PROCEED with null contractId
 *
 * @param pack - The ontology pack containing contract definitions
 * @param routeResult - The result from the router
 * @param context - The memory modify context
 * @returns The override outcome indicating PROCEED
 * @throws ClarityBurstAbstainError if router is unavailable
 *
 * @example
 * ```typescript
 * const pack = getPackForStage("MEMORY_MODIFY");
 * const routeResult = { ok: true, data: { top1: { contract_id: "MEMORY_SET_VAR" } } };
 * const context = { stageId: "MEMORY_MODIFY" };
 *
 * const result = applyMemoryModifyOverridesImpl(pack, routeResult, context);
 * // Returns: { outcome: "PROCEED", contractId: null }
 * ```
 */
function applyMemoryModifyOverridesImpl(
  pack: OntologyPack,
  routeResult: RouteResult,
  context: MemoryModifyContext
): OverrideOutcome {
  const requestId = extractRequestId(routeResult);
  
  // Fail-closed: if router result is not ok, throw error
  if (!routeResult.ok) {
    throw new ClarityBurstAbstainError({
      stageId: "MEMORY_MODIFY",
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      contractId: null,
      instructions: "The clarity router is currently unavailable. Please try again shortly.",
      nonRetryable: true
    });
  }

  // Validate contract ID is in allowed list (router mismatch check)
  const caps: RuntimeCapabilities = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts(MEMORY_MODIFY_STAGE_ID, pack, caps);
  const mismatchValidation = validateContractInAllowedList(routeResult, allowedContractIds, MEMORY_MODIFY_STAGE_ID, requestId);
  if (mismatchValidation) {
    // For throwing functions, throw ClarityBurstAbstainError instead of returning
    if (mismatchValidation.outcome === "ABSTAIN_CLARIFY") {
      const clarifyOutcome = mismatchValidation;
      throw new ClarityBurstAbstainError({
        stageId: MEMORY_MODIFY_STAGE_ID,
        outcome: clarifyOutcome.outcome,
        reason: clarifyOutcome.reason,
        contractId: clarifyOutcome.contractId,
        instructions: clarifyOutcome.instructions,
        nonRetryable: true
      });
    }
    // Should not happen for router mismatch, but handle gracefully
    throw new ClarityBurstAbstainError({
      stageId: MEMORY_MODIFY_STAGE_ID,
      outcome: mismatchValidation.outcome,
      reason: "ROUTER_MISMATCH",
      contractId: mismatchValidation.contractId,
      instructions: "Router contract ID mismatch",
      nonRetryable: true
    });
  }

  // Default: proceed
  return {
    outcome: "PROCEED",
    contractId: null
  };
}

/**
 * Applies memory modification overrides for the MEMORY_MODIFY stage.
 *
 * Canonical exported entrypoint that takes only a context object and performs
 * the full commit-point flow internally: load pack → derive allowed contracts →
 * assert non-empty → route through ClarityBurst → apply local overrides.
 *
 * Behavior:
 * - Loads the MEMORY_MODIFY pack
 * - Derives allowed contract IDs based on runtime capabilities
 * - Routes through ClarityBurst with assembled context fields
 * - On router outage: returns ABSTAIN_CLARIFY with router_outage reason
 * - On pack policy incomplete: returns ABSTAIN_CLARIFY with appropriate reason
 * - On successful routing: applies impl logic and returns PROCEED or throws error
 *
 * @param context - The memory modify context (stageId, etc.)
 * @returns A Promise of the override outcome indicating whether to proceed or abstain
 *
 * @example
 * ```typescript
 * const context: MemoryModifyContext = {
 *   stageId: "MEMORY_MODIFY"
 * };
 *
 * const result = await applyMemoryModifyOverrides(context);
 * // Returns: { outcome: "PROCEED", contractId: null }
 * ```
 */
export async function applyMemoryModifyOverrides(
  context: MemoryModifyContext
): Promise<OverrideOutcome> {
  // Stage integrity guard: reject if invoked with wrong stageId
  if (context.stageId !== undefined && context.stageId !== MEMORY_MODIFY_STAGE_ID) {
    return {
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      stageId: "MEMORY_MODIFY",
      contractId: null,
      instructions: `applyMemoryModifyOverrides was invoked with stageId "${context.stageId}" but expects "${MEMORY_MODIFY_STAGE_ID}". Fix the wiring to use the correct stage override function.`,
    };
  }

  // Early exit if ClarityBurst is disabled
  if (!configManager.isEnabled()) {
    return {
      outcome: "PROCEED",
      contractId: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SINGLE SOURCE OF TRUTH: Load pack and derive allowed contracts
  // ─────────────────────────────────────────────────────────────────────────────
  const pack = loadPackOrAbstain(MEMORY_MODIFY_STAGE_ID);
  const caps: RuntimeCapabilities = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts(MEMORY_MODIFY_STAGE_ID, pack, caps);
  assertNonEmptyAllowedContracts(MEMORY_MODIFY_STAGE_ID, allowedContractIds);

  // Route through ClarityBurst to get router result for MEMORY_MODIFY stage
  let routeResult: RouteResult;
  try {
    context.runMetrics && incRouter(context.runMetrics);
    const routerRes = await routeClarityBurst({
      stageId: MEMORY_MODIFY_STAGE_ID,
      packId: pack.pack_id,
      packVersion: pack.pack_version,
      allowedContractIds,
      userText: getUserText(),
      context,
      pack,
    });
    routeResult = routerRes as unknown as RouteResult;
  } catch {
    // Router error: return router_outage outcome
    const outcome: OverrideOutcome = {
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      stageId: "MEMORY_MODIFY",
      contractId: null,
      instructions: "ClarityBurst router unavailable; memory modification is blocked for safety.",
    };
    context.runMetrics && incOutcome(context.runMetrics, outcome.outcome);
    return outcome;
  }

  // Apply local overrides using the impl function
  const result = applyMemoryModifyOverridesImpl(pack, routeResult, context);
  context.runMetrics && incOutcome(context.runMetrics, result.outcome);
  return stampRequestId(result, extractRequestId(routeResult));
}

/** Context for subagent spawn decision */
export interface SubagentSpawnContext {
 stageId?: string;
 runMetrics?: RunMetrics;
 [key: string]: unknown;
}

/**
 * Internal implementation for subagent spawn overrides.
 *
 * Follows canonical commit-point flow: load pack → derive allowed → assert non-empty → routeClarityBurst.
 * The SUBAGENT_SPAWN stage fails closed on router outage.
 *
 * @param context - The subagent spawn context
 * @returns The override outcome indicating PROCEED
 * @throws ClarityBurstAbstainError if router is unavailable
 */
async function applySubagentSpawnOverridesImpl(
  context: SubagentSpawnContext
): Promise<OverrideOutcome> {
  // Stage integrity guard: reject if invoked with wrong stageId
  if (context.stageId !== undefined && context.stageId !== SUBAGENT_SPAWN_STAGE_ID) {
    throw new ClarityBurstAbstainError({
      stageId: "SUBAGENT_SPAWN",
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      contractId: null,
      instructions: `applySubagentSpawnOverrides was invoked with stageId "${context.stageId}" but expects "${SUBAGENT_SPAWN_STAGE_ID}". Fix the wiring to use the correct stage override function.`,
    });
  }

  // Early exit if ClarityBurst is disabled
  if (!configManager.isEnabled()) {
    return {
      outcome: "PROCEED",
      contractId: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SINGLE SOURCE OF TRUTH: Load pack and derive allowed contracts
  // ─────────────────────────────────────────────────────────────────────────────
  const pack = loadPackOrAbstain("SUBAGENT_SPAWN");
  const caps: RuntimeCapabilities = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts("SUBAGENT_SPAWN", pack, caps);
  assertNonEmptyAllowedContracts("SUBAGENT_SPAWN", allowedContractIds);

  // Route through ClarityBurst to get router result for SUBAGENT_SPAWN stage
  let routeResult: RouteResult;
  try {
    context.runMetrics && incRouter(context.runMetrics);
    const routerRes = await routeClarityBurst({
      stageId: "SUBAGENT_SPAWN",
      packId: pack.pack_id,
      packVersion: pack.pack_version,
      allowedContractIds,
      userText: getUserText(),
      context: { stageId: "SUBAGENT_SPAWN" },
      pack,
    });
    routeResult = routerRes as unknown as RouteResult;
  } catch {
    // Router error: fail-closed for SUBAGENT_SPAWN
    routeResult = { ok: false, error: "router_error" };
  }
  const routerRequestId = extractRequestId(routeResult);

  // Fail-closed: if router result is not ok, throw error
  if (!routeResult.ok) {
    context.runMetrics && incOutcome(context.runMetrics, "ABSTAIN_CLARIFY");
    throw new ClarityBurstAbstainError({
      stageId: "SUBAGENT_SPAWN",
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      contractId: null,
      instructions: "The clarity router is currently unavailable. Please try again shortly.",
      nonRetryable: true
    });
  }

  // Validate contract ID is in allowed list (router mismatch check)
  const mismatchValidation = validateContractInAllowedList(routeResult, allowedContractIds, SUBAGENT_SPAWN_STAGE_ID, routerRequestId);
  if (mismatchValidation) {
    // For throwing functions, throw ClarityBurstAbstainError instead of returning
    if (mismatchValidation.outcome === "ABSTAIN_CLARIFY") {
      const clarifyOutcome = mismatchValidation;
      context.runMetrics && incOutcome(context.runMetrics, clarifyOutcome.outcome);
      throw new ClarityBurstAbstainError({
        stageId: SUBAGENT_SPAWN_STAGE_ID,
        outcome: clarifyOutcome.outcome,
        reason: clarifyOutcome.reason,
        contractId: clarifyOutcome.contractId,
        instructions: clarifyOutcome.instructions,
        nonRetryable: true
      });
    }
    // Should not happen for router mismatch, but handle gracefully
    context.runMetrics && incOutcome(context.runMetrics, mismatchValidation.outcome);
    throw new ClarityBurstAbstainError({
      stageId: SUBAGENT_SPAWN_STAGE_ID,
      outcome: mismatchValidation.outcome,
      reason: "ROUTER_MISMATCH",
      contractId: mismatchValidation.contractId,
      instructions: "Router contract ID mismatch",
      nonRetryable: true
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SUBAGENT_SPAWN: Router mismatch detection with fail-open
  // ─────────────────────────────────────────────────────────────────────────────
  // If router returns a contract NOT in the pack, fail-open and proceed
  // without override enforcement (router may be stale/misconfigured).
  const top1Id = routeResult.ok ? (routeResult.data?.top1?.contract_id ?? null) : null;
  const routerMismatch = top1Id !== null && !allowedContractIds.includes(top1Id);

  if (routerMismatch) {
    // Router-mismatch fail-open: skip ClarityBurst override enforcement
    // and proceed with normal spawn execution path.
    return stampRequestId({
      outcome: "PROCEED",
      contractId: null
    }, routerRequestId);
  }

  // Default: proceed
  return stampRequestId({
    outcome: "PROCEED",
    contractId: null
  }, routerRequestId);
}

/**
 * Applies subagent spawn overrides for the SUBAGENT_SPAWN stage.
 *
 * This function evaluates whether a subagent spawn operation should proceed
 * based on router availability. The SUBAGENT_SPAWN stage fails closed on router outage.
 *
 * Behavior:
 * - Loads pack and routes through ClarityBurst internally
 * - If router is not ok: throws ClarityBurstAbstainError with router_outage reason
 * - If router is ok: returns PROCEED with null contractId
 *
 * @param context - The subagent spawn context
 * @returns A Promise of the override outcome indicating PROCEED
 * @throws ClarityBurstAbstainError if router is unavailable
 *
 * @example
 * ```typescript
 * const context = { stageId: "SUBAGENT_SPAWN" };
 *
 * const result = await applySubagentSpawnOverrides(context);
 * // Returns: { outcome: "PROCEED", contractId: null }
 * ```
 */
export async function applySubagentSpawnOverrides(
  context: SubagentSpawnContext
): Promise<OverrideOutcome> {
  return applySubagentSpawnOverridesImpl(context);
}

/**
 * Backward-compatible wrapper for the old applySubagentSpawnOverrides API.
 *
 * This function maintains the old signature (pack, routeResult, context)
 * for compatibility with existing call sites, but ignores pack and routeResult
 * since the logic is now encapsulated in the impl (single source of truth).
 *
 * @param pack - Ignored; kept for backward compatibility
 * @param routeResult - Ignored; kept for backward compatibility
 * @param context - The subagent spawn context
 * @returns A Promise of the override outcome (delegates to impl)
 *
 * @deprecated Use applySubagentSpawnOverrides(context) instead. This wrapper is
 * provided for backward compatibility only.
 */
export function applySubagentSpawnOverridesLegacy(
  pack: OntologyPack,
  routeResult: RouteResult,
  context: SubagentSpawnContext
): Promise<OverrideOutcome> {
  // Ignore pack/routeResult; logic is now single-source-of-truth in impl.
  // Still return a Promise so callers can await without behavior change.
  return applySubagentSpawnOverridesImpl(context);
}

/** Context for node invoke decision */
export interface NodeInvokeContext {
   stageId?: string;
   userConfirmed?: boolean;
   /** Node function or method name being invoked */
   functionName?: string;
   /** Parameters or arguments passed to the invocation */
   args?: unknown[];
   runMetrics?: RunMetrics;
   [key: string]: unknown;
}

/** Context for browser automate decision */
export interface BrowserAutomateContext {
   stageId?: string;
   userConfirmed?: boolean;
   /** Browser URL or target */
   url?: string;
   /** Action being performed (e.g., "navigate", "click", "type", "download") */
   action?: string;
   /** CSS selector or element identifier */
   selector?: string;
   runMetrics?: RunMetrics;
   [key: string]: unknown;
}

/** Context for message emit decision */
export interface MessageEmitContext {
  stageId?: string;
  userConfirmed?: boolean;
  channel?: string;   // e.g., "slack", "discord", "email", "webhook"
  target?: string;    // destination identifier (room/user/url) if available
  kind?: string;      // e.g., "notify", "post", "reply"
  runMetrics?: RunMetrics;
  [key: string]: unknown;
}

/** Context for media generate decision */
export interface MediaGenerateContext {
  stageId?: string;
  userConfirmed?: boolean;
  mediaType?: string;   // "image" | "video" | "audio" etc.
  model?: string;       // model identifier if available
  size?: string;        // e.g., "1024x1024" if relevant
  runMetrics?: RunMetrics;
  [key: string]: unknown;
}

/** Context for canvas UI decision */
export interface CanvasUiContext {
  stageId?: string;
  userConfirmed?: boolean;
  /** UI component type (e.g., "button", "form", "modal") */
  componentType?: string;
  /** Optional canvas identifier or context */
  canvasId?: string;
  runMetrics?: RunMetrics;
  [key: string]: unknown;
}

/** Context for cron schedule decision */
export interface CronScheduleContext {
   stageId?: string;
   userConfirmed?: boolean;
   /** cron/rrule string if available */
   schedule?: string;
   /** e.g. "reminder", "search", etc. */
   taskType?: string;
   /** optional identifier (tool/job name) */
   target?: string;
   runMetrics?: RunMetrics;
   [key: string]: unknown;
}

/**
 * Applies node invoke overrides for the NODE_INVOKE stage.
 *
 * This function evaluates whether a node invocation should proceed or require
 * user confirmation based on the contract's risk classification and
 * confidence/dominance thresholds.
 *
 * Behavior:
 * - If routeResult is not ok: abstain with router_outage reason
 * - If routeResult is ok:
 *   - Extracts contract_id from routeResult.data.top1.contract_id
 *   - Validates that pack thresholds are defined → ABSTAIN_CLARIFY if missing
 *   - Checks thresholds for low confidence/dominance → ABSTAIN_CLARIFY
 *   - Validates router result matches pack contracts → fail-open on mismatch
 *   - Looks up contract in pack.contracts
 *   - If contract has needs_confirmation: true OR risk_class is HIGH/CRITICAL
 *     AND context.userConfirmed !== true: returns ABSTAIN_CONFIRM
 *   - Otherwise: returns PROCEED
 *
 * @param pack - The ontology pack containing contract definitions
 * @param routeResult - The result from the router
 * @param context - The node invoke context including userConfirmed flag
 * @returns The override outcome indicating whether to proceed or abstain
 *
 * @example
 * ```typescript
 * const pack = getPackForStage("NODE_INVOKE");
 * const routeResult = { ok: true, data: { top1: { contract_id: "NODE_EXECUTE_SCRIPT", score: 0.95 } } };
 * const context = { stageId: "NODE_INVOKE", userConfirmed: false, functionName: "eval" };
 *
 * const result = applyNodeInvokeOverrides(pack, routeResult, context);
 * // Returns: { outcome: "ABSTAIN_CONFIRM", reason: "CONFIRM_REQUIRED", contractId: "NODE_EXECUTE_SCRIPT" }
 * ```
 */
async function applyNodeInvokeOverridesImpl(
  context: NodeInvokeContext
): Promise<OverrideOutcome> {
  // Stage integrity guard: reject if invoked with wrong stageId
  if (context.stageId !== undefined && context.stageId !== NODE_INVOKE_STAGE_ID) {
    return {
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `applyNodeInvokeOverrides was invoked with stageId "${context.stageId}" but expects "${NODE_INVOKE_STAGE_ID}". Fix the wiring to use the correct stage override function.`,
    };
  }

  // Early exit if ClarityBurst is disabled
  if (!configManager.isEnabled()) {
    return {
      outcome: "PROCEED",
      contractId: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SINGLE SOURCE OF TRUTH: Load pack and derive allowed contracts
  // ─────────────────────────────────────────────────────────────────────────────
  const pack = loadPackOrAbstain("NODE_INVOKE");
  const caps: RuntimeCapabilities = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts("NODE_INVOKE", pack, caps);
  assertNonEmptyAllowedContracts("NODE_INVOKE", allowedContractIds);

  // Route through ClarityBurst to get router result for NODE_INVOKE stage
  let routeResult: RouteResult;
  try {
    context.runMetrics && incRouter(context.runMetrics);
    const routerRes = await routeClarityBurst({
      stageId: "NODE_INVOKE",
      packId: pack.pack_id,
      packVersion: pack.pack_version,
      allowedContractIds,
      userText: getUserText(),
      context: { functionName: context.functionName ?? "" },
      pack,
    });
    routeResult = routerRes as unknown as RouteResult;
  } catch {
    // Router error: fail-closed for NODE_INVOKE
    routeResult = { ok: false, error: "router_error" };
  }
  const routerRequestId = extractRequestId(routeResult);

  // Defensive hard-block: if router result is not ok, abstain with router_outage
  if (!routeResult.ok) {
    const outcome: OverrideOutcome = {
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      stageId: "NODE_INVOKE",
      contractId: null,
      instructions: "The router is unavailable and node invocations cannot proceed. Retry when the router service is restored.",
    };
    context.runMetrics && incOutcome(context.runMetrics, outcome.outcome);
    return stampRequestId(outcome, routerRequestId);
  }

  // Validate contract ID is in allowed list (router mismatch check)
  const mismatchValidation = validateContractInAllowedList(routeResult, allowedContractIds, NODE_INVOKE_STAGE_ID, routerRequestId);
  if (mismatchValidation) {
    context.runMetrics && incOutcome(context.runMetrics, mismatchValidation.outcome);
    return stampRequestId(mismatchValidation, routerRequestId);
  }

  // Extract contract ID and scores from router result
  const top1 = routeResult.data?.top1;
  const top2 = routeResult.data?.top2;
  const contractId = top1?.contract_id ?? null;

  // Build a Set of contract IDs from pack
  const packContractIds = new Set(pack.contracts.map(c => c.contract_id));

  // Define router mismatch condition
  const routerMismatch = contractId !== null && !packContractIds.has(contractId);

  if (routerMismatch) {
    // fail-open on router mismatch
    return stampRequestId({
      outcome: "PROCEED",
      contractId: null,
    }, routerRequestId);
  }

  // If no contract ID found, fail-open
  if (!contractId) {
    return stampRequestId({
      outcome: "PROCEED",
      contractId: null,
    }, routerRequestId);
  }

  // Strictly pack-driven uncertainty gating for NODE_INVOKE
  // Thresholds MUST come from pack config - no hardcoded defaults
  const thresholds = pack.thresholds;
  const minConfidenceT = thresholds?.min_confidence_T;
  const dominanceMarginDelta = thresholds?.dominance_margin_Delta;

  // Hard-block if either threshold is missing/undefined - pack policy is incomplete
  if (minConfidenceT === undefined || dominanceMarginDelta === undefined) {
    const missingFields: string[] = [];
    if (minConfidenceT === undefined) {missingFields.push("min_confidence_T");}
    if (dominanceMarginDelta === undefined) {missingFields.push("dominance_margin_Delta");}
    
    return stampRequestId({
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `NODE_INVOKE pack policy is incomplete. Missing required threshold(s): ${missingFields.join(", ")}. Update the pack configuration to include these values before proceeding.`,
    }, routerRequestId);
  }

  // Apply uncertainty gating with pack-driven thresholds
  if (top1?.score !== undefined) {
    const top1Score = top1.score;

    // Check if confidence is below threshold (top1.score < min_confidence_T)
    const lowConfidence = top1Score < minConfidenceT;

    // Check if dominance margin is insufficient (top1.score - top2.score < dominance_margin_Delta)
    const lowDominance = top2?.score !== undefined &&
      (top1Score - top2.score) < dominanceMarginDelta;

    if (lowConfidence || lowDominance) {
      return stampRequestId({
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
        contractId,
      }, routerRequestId);
    }
  }

  // Look up the contract in the pack
  const contract = findContractById(pack, contractId);
  
  // If contract not found in pack, proceed (fail-open)
  if (!contract) {
    return stampRequestId({
      outcome: "PROCEED",
      contractId,
    }, routerRequestId);
  }

  // Check if confirmation is required and not yet provided
  // Enforce ABSTAIN_CONFIRM for HIGH/CRITICAL risk classes or needs_confirmation
  if (contractRequiresConfirmation(contract) && context.userConfirmed !== true) {
    return stampRequestId({
      outcome: "ABSTAIN_CONFIRM",
      reason: "CONFIRM_REQUIRED",
      contractId,
      instructions: `This operation requires user confirmation. Contract "${contractId}" has risk_class="${contract.risk_class}" or needs_confirmation=true. To proceed, the caller must set userConfirmed=true after obtaining explicit user consent.`,
    }, routerRequestId);
  }

  // Default: proceed with the invocation
  const result: OverrideOutcome = stampRequestId({
    outcome: "PROCEED",
    contractId,
  }, routerRequestId);
  context.runMetrics && incOutcome(context.runMetrics, result.outcome);
  return result;
}

/**
 * New async API for NODE_INVOKE overrides (context-only).
 *
 * This is the modern entry point that delegates to the internal implementation.
 *
 * @param context - The node invoke context including userConfirmed flag
 * @returns The override outcome indicating whether to proceed or abstain
 */
export async function applyNodeInvokeOverrides(
  context: NodeInvokeContext
): Promise<OverrideOutcome> {
  return applyNodeInvokeOverridesImpl(context);
}

/**
 * Backward-compatible wrapper for the old applyNodeInvokeOverrides API.
 *
 * This function maintains the old signature (pack, routeResult, context)
 * for compatibility with existing call sites, but ignores pack and routeResult
 * since the logic is now encapsulated in the impl (single source of truth).
 *
 * @param pack - Ignored; kept for backward compatibility
 * @param routeResult - Ignored; kept for backward compatibility
 * @param context - The node invoke context including userConfirmed flag
 * @returns A Promise of the override outcome (delegates to impl)
 *
 * @deprecated Use applyNodeInvokeOverrides(context) instead. This wrapper is
 * provided for backward compatibility only.
 */
export function applyNodeInvokeOverridesLegacy(
  pack: OntologyPack,
  routeResult: RouteResult,
  context: NodeInvokeContext
): Promise<OverrideOutcome> {
  // Ignore pack/routeResult; logic is now single-source-of-truth in impl.
  // Still return a Promise so callers can await without behavior change.
  return applyNodeInvokeOverridesImpl(context);
}

/**
 * Internal implementation for browser automate overrides.
 *
 * Follows canonical commit-point flow: load pack → derive allowed → assert non-empty → routeClarityBurst.
 * Applies local override rules for BROWSER_AUTOMATE stage.
 *
 * @param context - The browser automate context
 * @returns The override outcome
 */
async function applyBrowserAutomateOverridesImpl(
  context: BrowserAutomateContext
): Promise<OverrideOutcome> {
  // Stage integrity guard: reject if invoked with wrong stageId
  if (context.stageId !== undefined && context.stageId !== BROWSER_AUTOMATE_STAGE_ID) {
    return {
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `applyBrowserAutomateOverrides was invoked with stageId "${context.stageId}" but expects "${BROWSER_AUTOMATE_STAGE_ID}". Fix the wiring to use the correct stage override function.`,
    };
  }

  // Early exit if ClarityBurst is disabled
  if (!configManager.isEnabled()) {
    return {
      outcome: "PROCEED",
      contractId: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SINGLE SOURCE OF TRUTH: Load pack and derive allowed contracts
  // ─────────────────────────────────────────────────────────────────────────────
  const pack = loadPackOrAbstain("BROWSER_AUTOMATE");
  const caps: RuntimeCapabilities = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts("BROWSER_AUTOMATE", pack, caps);
  assertNonEmptyAllowedContracts("BROWSER_AUTOMATE", allowedContractIds);

  // Route through ClarityBurst to get router result for BROWSER_AUTOMATE stage
  let routeResult: RouteResult;
  try {
    context.runMetrics && incRouter(context.runMetrics);
    const routerRes = await routeClarityBurst({
      stageId: "BROWSER_AUTOMATE",
      packId: pack.pack_id,
      packVersion: pack.pack_version,
      allowedContractIds,
      userText: getUserText(),
      context: { url: context.url ?? "", action: context.action ?? "" },
      pack,
    });
    routeResult = routerRes as unknown as RouteResult;
  } catch {
    // Router error: fail-closed for BROWSER_AUTOMATE
    routeResult = { ok: false, error: "router_error" };
  }
  const routerRequestId = extractRequestId(routeResult);

  // Defensive hard-block: if router result is not ok, abstain with router_outage
  if (!routeResult.ok) {
    const outcome: OverrideOutcome = {
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      stageId: "BROWSER_AUTOMATE",
      contractId: null,
      instructions: "The router is unavailable and browser automation cannot proceed. Retry when the router service is restored.",
    };
    context.runMetrics && incOutcome(context.runMetrics, outcome.outcome);
    return stampRequestId(outcome, routerRequestId);
  }

  // Validate contract ID is in allowed list (router mismatch check)
  const mismatchValidation = validateContractInAllowedList(routeResult, allowedContractIds, BROWSER_AUTOMATE_STAGE_ID, routerRequestId);
  if (mismatchValidation) {
    context.runMetrics && incOutcome(context.runMetrics, mismatchValidation.outcome);
    return stampRequestId(mismatchValidation, routerRequestId);
  }

  // Extract contract ID and scores from router result
  const top1 = routeResult.data?.top1;
  const top2 = routeResult.data?.top2;
  const contractId = top1?.contract_id ?? null;

  // Build a Set of contract IDs from pack
  const packContractIds = new Set(pack.contracts.map(c => c.contract_id));

  // Define router mismatch condition
  const routerMismatch = contractId !== null && !packContractIds.has(contractId);

  if (routerMismatch) {
    // fail-open on router mismatch
    return stampRequestId({
      outcome: "PROCEED",
      contractId: null,
    }, routerRequestId);
  }

  // If no contract ID found, fail-open
  if (!contractId) {
    return stampRequestId({
      outcome: "PROCEED",
      contractId: null,
    }, routerRequestId);
  }

  // Strictly pack-driven uncertainty gating for BROWSER_AUTOMATE
  // Thresholds MUST come from pack config - no hardcoded defaults
  const thresholds = pack.thresholds;
  const minConfidenceT = thresholds?.min_confidence_T;
  const dominanceMarginDelta = thresholds?.dominance_margin_Delta;

  // Hard-block if either threshold is missing/undefined - pack policy is incomplete
  if (minConfidenceT === undefined || dominanceMarginDelta === undefined) {
    const missingFields: string[] = [];
    if (minConfidenceT === undefined) {missingFields.push("min_confidence_T");}
    if (dominanceMarginDelta === undefined) {missingFields.push("dominance_margin_Delta");}
    
    return stampRequestId({
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `BROWSER_AUTOMATE pack policy is incomplete. Missing required threshold(s): ${missingFields.join(", ")}. Update the pack configuration to include these values before proceeding.`,
    }, routerRequestId);
  }

  // Apply uncertainty gating with pack-driven thresholds
  if (top1?.score !== undefined) {
    const top1Score = top1.score;

    // Check if confidence is below threshold (top1.score < min_confidence_T)
    const lowConfidence = top1Score < minConfidenceT;

    // Check if dominance margin is insufficient (top1.score - top2.score < dominance_margin_Delta)
    const lowDominance = top2?.score !== undefined &&
      (top1Score - top2.score) < dominanceMarginDelta;

    if (lowConfidence || lowDominance) {
      return stampRequestId({
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
        contractId,
      }, routerRequestId);
    }
  }

  // Look up the contract in the pack
  const contract = findContractById(pack, contractId);
  
  // If contract not found in pack, proceed (fail-open)
  if (!contract) {
    return stampRequestId({
      outcome: "PROCEED",
      contractId,
    }, routerRequestId);
  }

  // Check if confirmation is required and not yet provided
  // Enforce ABSTAIN_CONFIRM for HIGH/CRITICAL risk classes or needs_confirmation
  if (contractRequiresConfirmation(contract) && context.userConfirmed !== true) {
    return stampRequestId({
      outcome: "ABSTAIN_CONFIRM",
      reason: "CONFIRM_REQUIRED",
      contractId,
      instructions: `This operation requires user confirmation. Contract "${contractId}" has risk_class="${contract.risk_class}" or needs_confirmation=true. To proceed, the caller must set userConfirmed=true after obtaining explicit user consent.`,
    }, routerRequestId);
  }

  // Default: proceed with the browser automation
  const result: OverrideOutcome = stampRequestId({
    outcome: "PROCEED",
    contractId,
  }, routerRequestId);
  context.runMetrics && incOutcome(context.runMetrics, result.outcome);
  return result;
}

/**
 * Applies browser automate overrides for the BROWSER_AUTOMATE stage.
 *
 * This function evaluates whether a browser automation operation should proceed or require
 * user confirmation based on the contract's risk classification and
 * confidence/dominance thresholds.
 *
 * Behavior:
 * - If routeResult is not ok: abstain with router_outage reason
 * - If routeResult is ok:
 *   - Extracts contract_id from routeResult.data.top1.contract_id
 *   - Validates that pack thresholds are defined → ABSTAIN_CLARIFY if missing
 *   - Checks thresholds for low confidence/dominance → ABSTAIN_CLARIFY
 *   - Validates router result matches pack contracts → fail-open on mismatch
 *   - Looks up contract in pack.contracts
 *   - If contract has needs_confirmation: true OR risk_class is HIGH/CRITICAL
 *     AND context.userConfirmed !== true: returns ABSTAIN_CONFIRM
 *   - Otherwise: returns PROCEED
 *
 * @param context - The browser automate context including userConfirmed flag
 * @returns The override outcome indicating whether to proceed or abstain
 *
 * @example
 * ```typescript
 * const context = { stageId: "BROWSER_AUTOMATE", userConfirmed: false, url: "https://example.com", action: "navigate" };
 *
 * const result = await applyBrowserAutomateOverrides(context);
 * // Returns: { outcome: "PROCEED", contractId: "BROWSER_NAVIGATE" }
 * ```
 */
export async function applyBrowserAutomateOverrides(
   context: BrowserAutomateContext
): Promise<OverrideOutcome> {
   return applyBrowserAutomateOverridesImpl(context);
}

/**
 * Internal implementation for cron schedule overrides.
 *
 * Follows canonical commit-point flow: load pack → derive allowed → assert non-empty → routeClarityBurst.
 * Applies local override rules for CRON_SCHEDULE stage.
 *
 * @param context - The cron schedule context
 * @returns The override outcome
 */
async function applyCronScheduleOverridesImpl(
   context: CronScheduleContext
): Promise<OverrideOutcome> {
   // Stage integrity guard: reject if invoked with wrong stageId
   if (context.stageId !== undefined && context.stageId !== CRON_SCHEDULE_STAGE_ID) {
     return {
       outcome: "ABSTAIN_CLARIFY",
       reason: "PACK_POLICY_INCOMPLETE",
       contractId: null,
       instructions: `applyCronScheduleOverrides was invoked with stageId "${context.stageId}" but expects "${CRON_SCHEDULE_STAGE_ID}". Fix the wiring to use the correct stage override function.`,
     };
   }

   // Early exit if ClarityBurst is disabled
   if (!configManager.isEnabled()) {
     return {
       outcome: "PROCEED",
       contractId: null,
     };
   }

   // ─────────────────────────────────────────────────────────────────────────────
   // SINGLE SOURCE OF TRUTH: Load pack and derive allowed contracts
   // ─────────────────────────────────────────────────────────────────────────────
   const pack = loadPackOrAbstain("CRON_SCHEDULE");
   const caps: RuntimeCapabilities = createFullCapabilities();
   const allowedContractIds = deriveAllowedContracts("CRON_SCHEDULE", pack, caps);
   assertNonEmptyAllowedContracts("CRON_SCHEDULE", allowedContractIds);

   // Route through ClarityBurst to get router result for CRON_SCHEDULE stage
   let routeResult: RouteResult;
   try {
     context.runMetrics && incRouter(context.runMetrics);
     const routerRes = await routeClarityBurst({
       stageId: "CRON_SCHEDULE",
       packId: pack.pack_id,
       packVersion: pack.pack_version,
       allowedContractIds,
       userText: getUserText(),
       context: { schedule: context.schedule ?? "", taskType: context.taskType ?? "" },
       pack,
     });
     routeResult = routerRes as unknown as RouteResult;
   } catch {
     // Router error: fail-closed for CRON_SCHEDULE
     routeResult = { ok: false, error: "router_error" };
   }
   const routerRequestId = extractRequestId(routeResult);

   // Defensive hard-block: if router result is not ok, abstain with router_outage
   if (!routeResult.ok) {
     const outcome: OverrideOutcome = {
       outcome: "ABSTAIN_CLARIFY",
       reason: "router_outage",
       stageId: "CRON_SCHEDULE",
       contractId: null,
       instructions: "The router is unavailable and cron schedule operations cannot proceed. Retry when the router service is restored.",
     };
     context.runMetrics && incOutcome(context.runMetrics, outcome.outcome);
     return stampRequestId(outcome, routerRequestId);
   }

   // Validate contract ID is in allowed list (router mismatch check)
   const mismatchValidation = validateContractInAllowedList(routeResult, allowedContractIds, CRON_SCHEDULE_STAGE_ID, routerRequestId);
   if (mismatchValidation) {
     context.runMetrics && incOutcome(context.runMetrics, mismatchValidation.outcome);
     return stampRequestId(mismatchValidation, routerRequestId);
   }

   // Extract contract ID and scores from router result
   const top1 = routeResult.data?.top1;
   const top2 = routeResult.data?.top2;
   const contractId = top1?.contract_id ?? null;

   // Build a Set of contract IDs from pack
   const packContractIds = new Set(pack.contracts.map(c => c.contract_id));

   // Define router mismatch condition
   const routerMismatch = contractId !== null && !packContractIds.has(contractId);

   if (routerMismatch) {
     // fail-open on router mismatch
     return stampRequestId({
       outcome: "PROCEED",
       contractId: null,
     }, routerRequestId);
   }

   // If no contract ID found, fail-open
   if (!contractId) {
     return stampRequestId({
       outcome: "PROCEED",
       contractId: null,
     }, routerRequestId);
   }

   // Strictly pack-driven uncertainty gating for CRON_SCHEDULE
   // Thresholds MUST come from pack config - no hardcoded defaults
   const thresholds = pack.thresholds;
   const minConfidenceT = thresholds?.min_confidence_T;
   const dominanceMarginDelta = thresholds?.dominance_margin_Delta;

   // Hard-block if either threshold is missing/undefined - pack policy is incomplete
   if (minConfidenceT === undefined || dominanceMarginDelta === undefined) {
     const missingFields: string[] = [];
     if (minConfidenceT === undefined) {missingFields.push("min_confidence_T");}
     if (dominanceMarginDelta === undefined) {missingFields.push("dominance_margin_Delta");}
     
     return stampRequestId({
       outcome: "ABSTAIN_CLARIFY",
       reason: "PACK_POLICY_INCOMPLETE",
       contractId: null,
       instructions: `CRON_SCHEDULE pack policy is incomplete. Missing required threshold(s): ${missingFields.join(", ")}. Update the pack configuration to include these values before proceeding.`,
     }, routerRequestId);
   }

   // Apply uncertainty gating with pack-driven thresholds
   if (top1?.score !== undefined) {
     const top1Score = top1.score;

     // Check if confidence is below threshold (top1.score < min_confidence_T)
     const lowConfidence = top1Score < minConfidenceT;

     // Check if dominance margin is insufficient (top1.score - top2.score < dominance_margin_Delta)
     const lowDominance = top2?.score !== undefined &&
       (top1Score - top2.score) < dominanceMarginDelta;

     if (lowConfidence || lowDominance) {
       return stampRequestId({
         outcome: "ABSTAIN_CLARIFY",
         reason: "LOW_DOMINANCE_OR_CONFIDENCE",
         contractId,
       }, routerRequestId);
     }
   }

   // Look up the contract in the pack
   const contract = findContractById(pack, contractId);
   
   // If contract not found in pack, proceed (fail-open)
   if (!contract) {
     return stampRequestId({
       outcome: "PROCEED",
       contractId,
     }, routerRequestId);
   }

   // Check if confirmation is required and not yet provided
   // Enforce ABSTAIN_CONFIRM for HIGH/CRITICAL risk classes or needs_confirmation
   if (contractRequiresConfirmation(contract) && context.userConfirmed !== true) {
     return stampRequestId({
       outcome: "ABSTAIN_CONFIRM",
       reason: "CONFIRM_REQUIRED",
       contractId,
       instructions: `This operation requires user confirmation. Contract "${contractId}" has risk_class="${contract.risk_class}" or needs_confirmation=true. To proceed, the caller must set userConfirmed=true after obtaining explicit user consent.`,
     }, routerRequestId);
   }

   // Default: proceed with the cron schedule operation
   const result: OverrideOutcome = stampRequestId({
     outcome: "PROCEED",
     contractId,
   }, routerRequestId);
   context.runMetrics && incOutcome(context.runMetrics, result.outcome);
   return result;
}

/**
 * Applies cron schedule overrides for the CRON_SCHEDULE stage.
 *
 * This function evaluates whether a cron schedule operation should proceed or require
 * user confirmation based on the contract's risk classification and
 * confidence/dominance thresholds.
 *
 * Behavior:
 * - If routeResult is not ok: abstain with router_outage reason
 * - If routeResult is ok:
 *   - Extracts contract_id from routeResult.data.top1.contract_id
 *   - Validates that pack thresholds are defined → ABSTAIN_CLARIFY if missing
 *   - Checks thresholds for low confidence/dominance → ABSTAIN_CLARIFY
 *   - Validates router result matches pack contracts → fail-open on mismatch
 *   - Looks up contract in pack.contracts
 *   - If contract has needs_confirmation: true OR risk_class is HIGH/CRITICAL
 *     AND context.userConfirmed !== true: returns ABSTAIN_CONFIRM
 *   - Otherwise: returns PROCEED
 *
 * @param context - The cron schedule context including userConfirmed flag
 * @returns The override outcome indicating whether to proceed or abstain
 *
 * @example
 * ```typescript
 * const context = { stageId: "CRON_SCHEDULE", userConfirmed: false, schedule: "0 9 * * MON-FRI", taskType: "reminder" };
 *
 * const result = await applyCronScheduleOverrides(context);
 * // Returns: { outcome: "PROCEED", contractId: "CRON_SCHEDULE_SET" }
 * ```
 */
export async function applyCronScheduleOverrides(
    context: CronScheduleContext
): Promise<OverrideOutcome> {
    return applyCronScheduleOverridesImpl(context);
}

/**
 * Internal implementation for message emit overrides.
 *
 * Follows canonical commit-point flow: load pack → derive allowed → assert non-empty → routeClarityBurst.
 * Applies local override rules for MESSAGE_EMIT stage.
 *
 * @param context - The message emit context
 * @returns The override outcome
 */
async function applyMessageEmitOverridesImpl(
  context: MessageEmitContext
): Promise<OverrideOutcome> {
  // Stage integrity guard: reject if invoked with wrong stageId
  if (context.stageId !== undefined && context.stageId !== MESSAGE_EMIT_STAGE_ID) {
    return {
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `applyMessageEmitOverrides was invoked with stageId "${context.stageId}" but expects "${MESSAGE_EMIT_STAGE_ID}". Fix the wiring to use the correct stage override function.`,
    };
  }

  // Early exit if ClarityBurst is disabled
  if (!configManager.isEnabled()) {
    return {
      outcome: "PROCEED",
      contractId: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SINGLE SOURCE OF TRUTH: Load pack and derive allowed contracts
  // ─────────────────────────────────────────────────────────────────────────────
  const pack = loadPackOrAbstain("MESSAGE_EMIT");
  const caps: RuntimeCapabilities = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts("MESSAGE_EMIT", pack, caps);
  assertNonEmptyAllowedContracts("MESSAGE_EMIT", allowedContractIds);

  // Route through ClarityBurst to get router result for MESSAGE_EMIT stage
  let routeResult: RouteResult;
  try {
    context.runMetrics && incRouter(context.runMetrics);
    const routerRes = await routeClarityBurst({
      stageId: "MESSAGE_EMIT",
      packId: pack.pack_id,
      packVersion: pack.pack_version,
      allowedContractIds,
      userText: getUserText(),
      context: { channel: context.channel ?? "", kind: context.kind ?? "" },
      pack,
    });
    routeResult = routerRes as unknown as RouteResult;
  } catch {
    // Router error: fail-closed for MESSAGE_EMIT
    routeResult = { ok: false, error: "router_error" };
  }
  const routerRequestId = extractRequestId(routeResult);

  // Defensive hard-block: if router result is not ok, abstain with router_outage
  if (!routeResult.ok) {
    const outcome: OverrideOutcome = {
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      stageId: "MESSAGE_EMIT",
      contractId: null,
      instructions: "The router is unavailable and message emit operations cannot proceed. Retry when the router service is restored.",
    };
    context.runMetrics && incOutcome(context.runMetrics, outcome.outcome);
    return stampRequestId(outcome, routerRequestId);
  }

  // Validate contract ID is in allowed list (router mismatch check)
  const mismatchValidation = validateContractInAllowedList(routeResult, allowedContractIds, MESSAGE_EMIT_STAGE_ID, routerRequestId);
  if (mismatchValidation) {
    context.runMetrics && incOutcome(context.runMetrics, mismatchValidation.outcome);
    return stampRequestId(mismatchValidation, routerRequestId);
  }

  // Extract contract ID and scores from router result
  const top1 = routeResult.data?.top1;
  const top2 = routeResult.data?.top2;
  const contractId = top1?.contract_id ?? null;

  // Build a Set of contract IDs from pack
  const packContractIds = new Set(pack.contracts.map(c => c.contract_id));

  // Define router mismatch condition
  const routerMismatch = contractId !== null && !packContractIds.has(contractId);

  if (routerMismatch) {
    // fail-open on router mismatch
    return stampRequestId({
      outcome: "PROCEED",
      contractId: null,
    }, routerRequestId);
  }

  // If no contract ID found, fail-open
  if (!contractId) {
    return stampRequestId({
      outcome: "PROCEED",
      contractId: null,
    }, routerRequestId);
  }

  // Strictly pack-driven uncertainty gating for MESSAGE_EMIT
  // Thresholds MUST come from pack config - no hardcoded defaults
  const thresholds = pack.thresholds;
  const minConfidenceT = thresholds?.min_confidence_T;
  const dominanceMarginDelta = thresholds?.dominance_margin_Delta;

  // Hard-block if either threshold is missing/undefined - pack policy is incomplete
  if (minConfidenceT === undefined || dominanceMarginDelta === undefined) {
    const missingFields: string[] = [];
    if (minConfidenceT === undefined) {missingFields.push("min_confidence_T");}
    if (dominanceMarginDelta === undefined) {missingFields.push("dominance_margin_Delta");}
    
    return stampRequestId({
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `MESSAGE_EMIT pack policy is incomplete. Missing required threshold(s): ${missingFields.join(", ")}. Update the pack configuration to include these values before proceeding.`,
    }, routerRequestId);
  }

  // Apply uncertainty gating with pack-driven thresholds
  if (top1?.score !== undefined) {
    const top1Score = top1.score;

    // Check if confidence is below threshold (top1.score < min_confidence_T)
    const lowConfidence = top1Score < minConfidenceT;

    // Check if dominance margin is insufficient (top1.score - top2.score < dominance_margin_Delta)
    const lowDominance = top2?.score !== undefined &&
      (top1Score - top2.score) < dominanceMarginDelta;

    if (lowConfidence || lowDominance) {
      return stampRequestId({
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
        contractId,
      }, routerRequestId);
    }
  }

  // Look up the contract in the pack
  const contract = findContractById(pack, contractId);
  
  // If contract not found in pack, proceed (fail-open)
  if (!contract) {
    return stampRequestId({
      outcome: "PROCEED",
      contractId,
    }, routerRequestId);
  }

  // Check if confirmation is required and not yet provided
  // Enforce ABSTAIN_CONFIRM for HIGH/CRITICAL risk classes or needs_confirmation
  if (contractRequiresConfirmation(contract) && context.userConfirmed !== true) {
    return stampRequestId({
      outcome: "ABSTAIN_CONFIRM",
      reason: "CONFIRM_REQUIRED",
      contractId,
      instructions: `This operation requires user confirmation. Contract "${contractId}" has risk_class="${contract.risk_class}" or needs_confirmation=true. To proceed, the caller must set userConfirmed=true after obtaining explicit user consent.`,
    }, routerRequestId);
  }

  // Default: proceed with the message emit operation
  const result: OverrideOutcome = stampRequestId({
    outcome: "PROCEED",
    contractId,
  }, routerRequestId);
  context.runMetrics && incOutcome(context.runMetrics, result.outcome);
  return result;
}

/**
 * Applies message emit overrides for the MESSAGE_EMIT stage.
 *
 * This function evaluates whether a message emit operation should proceed or require
 * user confirmation based on the contract's risk classification and
 * confidence/dominance thresholds.
 *
 * Behavior:
 * - If routeResult is not ok: abstain with router_outage reason
 * - If routeResult is ok:
 *   - Extracts contract_id from routeResult.data.top1.contract_id
 *   - Validates that pack thresholds are defined → ABSTAIN_CLARIFY if missing
 *   - Checks thresholds for low confidence/dominance → ABSTAIN_CLARIFY
 *   - Validates router result matches pack contracts → fail-open on mismatch
 *   - Looks up contract in pack.contracts
 *   - If contract has needs_confirmation: true OR risk_class is HIGH/CRITICAL
 *     AND context.userConfirmed !== true: returns ABSTAIN_CONFIRM
 *   - Otherwise: returns PROCEED
 *
 * @param context - The message emit context including userConfirmed flag
 * @returns The override outcome indicating whether to proceed or abstain
 *
 * @example
 * ```typescript
 * const context = { stageId: "MESSAGE_EMIT", userConfirmed: false, channel: "slack", kind: "notify" };
 *
 * const result = await applyMessageEmitOverrides(context);
 * // Returns: { outcome: "PROCEED", contractId: "MESSAGE_EMIT_SEND" }
 * ```
 */
export async function applyMessageEmitOverrides(
  context: MessageEmitContext
): Promise<OverrideOutcome> {
  return applyMessageEmitOverridesImpl(context);
}

/**
 * Internal implementation for media generate overrides.
 *
 * Follows canonical commit-point flow: load pack → derive allowed → assert non-empty → routeClarityBurst.
 * Applies local override rules for MEDIA_GENERATE stage.
 *
 * @param context - The media generate context
 * @returns The override outcome
 */
async function applyMediaGenerateOverridesImpl(
  context: MediaGenerateContext
): Promise<OverrideOutcome> {
  // Stage integrity guard: reject if invoked with wrong stageId
  if (context.stageId !== undefined && context.stageId !== MEDIA_GENERATE_STAGE_ID) {
    return {
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `applyMediaGenerateOverrides was invoked with stageId "${context.stageId}" but expects "${MEDIA_GENERATE_STAGE_ID}". Fix the wiring to use the correct stage override function.`,
    };
  }

  // Early exit if ClarityBurst is disabled
  if (!configManager.isEnabled()) {
    return {
      outcome: "PROCEED",
      contractId: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SINGLE SOURCE OF TRUTH: Load pack and derive allowed contracts
  // ─────────────────────────────────────────────────────────────────────────────
  const pack = loadPackOrAbstain("MEDIA_GENERATE");
  const caps: RuntimeCapabilities = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts("MEDIA_GENERATE", pack, caps);
  assertNonEmptyAllowedContracts("MEDIA_GENERATE", allowedContractIds);

  // Route through ClarityBurst to get router result for MEDIA_GENERATE stage
  let routeResult: RouteResult;
  try {
    const routerRes = await routeClarityBurst({
      stageId: "MEDIA_GENERATE",
      packId: pack.pack_id,
      packVersion: pack.pack_version,
      allowedContractIds,
      userText: getUserText(),
      context: { mediaType: context.mediaType ?? "", model: context.model ?? "" },
      pack,
    });
    routeResult = routerRes as unknown as RouteResult;
  } catch {
    // Router error: fail-closed for MEDIA_GENERATE
    routeResult = { ok: false, error: "router_error" };
  }
  const routerRequestId = extractRequestId(routeResult);

  // Defensive hard-block: if router result is not ok, abstain with router_outage
  if (!routeResult.ok) {
    return stampRequestId({
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      stageId: "MEDIA_GENERATE",
      contractId: null,
      instructions: "The router is unavailable and media generation cannot proceed. Retry when the router service is restored.",
    }, routerRequestId);
  }

  // Validate contract ID is in allowed list (router mismatch check)
  const mismatchValidation = validateContractInAllowedList(routeResult, allowedContractIds, MEDIA_GENERATE_STAGE_ID, routerRequestId);
  if (mismatchValidation) {
    return stampRequestId(mismatchValidation, routerRequestId);
  }

  // Extract contract ID and scores from router result
  const top1 = routeResult.data?.top1;
  const top2 = routeResult.data?.top2;
  const contractId = top1?.contract_id ?? null;

  // Build a Set of contract IDs from pack
  const packContractIds = new Set(pack.contracts.map(c => c.contract_id));

  // Define router mismatch condition
  const routerMismatch = contractId !== null && !packContractIds.has(contractId);

  if (routerMismatch) {
    // fail-open on router mismatch
    return stampRequestId({
      outcome: "PROCEED",
      contractId: null,
    }, routerRequestId);
  }

  // If no contract ID found, fail-open
  if (!contractId) {
    return stampRequestId({
      outcome: "PROCEED",
      contractId: null,
    }, routerRequestId);
  }

  // Strictly pack-driven uncertainty gating for MEDIA_GENERATE
  // Thresholds MUST come from pack config - no hardcoded defaults
  const thresholds = pack.thresholds;
  const minConfidenceT = thresholds?.min_confidence_T;
  const dominanceMarginDelta = thresholds?.dominance_margin_Delta;

  // Hard-block if either threshold is missing/undefined - pack policy is incomplete
  if (minConfidenceT === undefined || dominanceMarginDelta === undefined) {
    const missingFields: string[] = [];
    if (minConfidenceT === undefined) {missingFields.push("min_confidence_T");}
    if (dominanceMarginDelta === undefined) {missingFields.push("dominance_margin_Delta");}
    
    return stampRequestId({
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `MEDIA_GENERATE pack policy is incomplete. Missing required threshold(s): ${missingFields.join(", ")}. Update the pack configuration to include these values before proceeding.`,
    }, routerRequestId);
  }

  // Apply uncertainty gating with pack-driven thresholds
  if (top1?.score !== undefined) {
    const top1Score = top1.score;

    // Check if confidence is below threshold (top1.score < min_confidence_T)
    const lowConfidence = top1Score < minConfidenceT;

    // Check if dominance margin is insufficient (top1.score - top2.score < dominance_margin_Delta)
    const lowDominance = top2?.score !== undefined &&
      (top1Score - top2.score) < dominanceMarginDelta;

    if (lowConfidence || lowDominance) {
      return stampRequestId({
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
        contractId,
      }, routerRequestId);
    }
  }

  // Look up the contract in the pack
  const contract = findContractById(pack, contractId);
  
  // If contract not found in pack, proceed (fail-open)
  if (!contract) {
    return stampRequestId({
      outcome: "PROCEED",
      contractId,
    }, routerRequestId);
  }

  // Check if confirmation is required and not yet provided
  // Enforce ABSTAIN_CONFIRM for HIGH/CRITICAL risk classes or needs_confirmation
  if (contractRequiresConfirmation(contract) && context.userConfirmed !== true) {
    return stampRequestId({
      outcome: "ABSTAIN_CONFIRM",
      reason: "CONFIRM_REQUIRED",
      contractId,
      instructions: `This operation requires user confirmation. Contract "${contractId}" has risk_class="${contract.risk_class}" or needs_confirmation=true. To proceed, the caller must set userConfirmed=true after obtaining explicit user consent.`,
    }, routerRequestId);
  }

  // Default: proceed with the media generation
  return stampRequestId({
    outcome: "PROCEED",
    contractId,
  }, routerRequestId);
}

/**
 * Applies media generate overrides for the MEDIA_GENERATE stage.
 *
 * This function evaluates whether a media generation operation should proceed or require
 * user confirmation based on the contract's risk classification and
 * confidence/dominance thresholds.
 *
 * Behavior:
 * - If routeResult is not ok: abstain with router_outage reason
 * - If routeResult is ok:
 *   - Extracts contract_id from routeResult.data.top1.contract_id
 *   - Validates that pack thresholds are defined → ABSTAIN_CLARIFY if missing
 *   - Checks thresholds for low confidence/dominance → ABSTAIN_CLARIFY
 *   - Validates router result matches pack contracts → fail-open on mismatch
 *   - Looks up contract in pack.contracts
 *   - If contract has needs_confirmation: true OR risk_class is HIGH/CRITICAL
 *     AND context.userConfirmed !== true: returns ABSTAIN_CONFIRM
 *   - Otherwise: returns PROCEED
 *
 * @param context - The media generate context including userConfirmed flag
 * @returns The override outcome indicating whether to proceed or abstain
 *
 * @example
 * ```typescript
 * const context = { stageId: "MEDIA_GENERATE", userConfirmed: false, mediaType: "image", model: "dall-e-3" };
 *
 * const result = await applyMediaGenerateOverrides(context);
 * // Returns: { outcome: "PROCEED", contractId: "MEDIA_IMAGE_GENERATE" }
 * ```
 */
export async function applyMediaGenerateOverrides(
  context: MediaGenerateContext
): Promise<OverrideOutcome> {
  return applyMediaGenerateOverridesImpl(context);
}

/**
 * Internal implementation for canvas UI overrides.
 *
 * Follows canonical commit-point flow: load pack → derive allowed → assert non-empty → routeClarityBurst.
 * Applies local override rules for CANVAS_UI stage.
 *
 * @param context - The canvas UI context
 * @returns The override outcome
 */
async function applyCanvasUiOverridesImpl(
  context: CanvasUiContext
): Promise<OverrideOutcome> {
  // Stage integrity guard: reject if invoked with wrong stageId
  if (context.stageId !== undefined && context.stageId !== CANVAS_UI_STAGE_ID) {
    return {
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `applyCanvasUiOverrides was invoked with stageId "${context.stageId}" but expects "${CANVAS_UI_STAGE_ID}". Fix the wiring to use the correct stage override function.`,
    };
  }

  // Early exit if ClarityBurst is disabled
  if (!configManager.isEnabled()) {
    return {
      outcome: "PROCEED",
      contractId: null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // SINGLE SOURCE OF TRUTH: Load pack and derive allowed contracts
  // ─────────────────────────────────────────────────────────────────────────────
  const pack = loadPackOrAbstain("CANVAS_UI");
  const caps: RuntimeCapabilities = createFullCapabilities();
  const allowedContractIds = deriveAllowedContracts("CANVAS_UI", pack, caps);
  assertNonEmptyAllowedContracts("CANVAS_UI", allowedContractIds);

  // Route through ClarityBurst to get router result for CANVAS_UI stage
  let routeResult: RouteResult;
  try {
    const routerRes = await routeClarityBurst({
      stageId: "CANVAS_UI",
      packId: pack.pack_id,
      packVersion: pack.pack_version,
      allowedContractIds,
      userText: getUserText(),
      context: { componentType: context.componentType ?? "", canvasId: context.canvasId ?? "" },
      pack,
    });
    routeResult = routerRes as unknown as RouteResult;
  } catch {
    // Router error: fail-closed for CANVAS_UI
    routeResult = { ok: false, error: "router_error" };
  }
  const routerRequestId = extractRequestId(routeResult);

  // Defensive hard-block: if router result is not ok, abstain with router_outage
  if (!routeResult.ok) {
    return stampRequestId({
      outcome: "ABSTAIN_CLARIFY",
      reason: "router_outage",
      stageId: "CANVAS_UI",
      contractId: null,
      instructions: "The router is unavailable and canvas UI operations cannot proceed. Retry when the router service is restored.",
    }, routerRequestId);
  }

  // Validate contract ID is in allowed list (router mismatch check)
  const mismatchValidation = validateContractInAllowedList(routeResult, allowedContractIds, CANVAS_UI_STAGE_ID, routerRequestId);
  if (mismatchValidation) {
    return stampRequestId(mismatchValidation, routerRequestId);
  }

  // Extract contract ID and scores from router result
  const top1 = routeResult.data?.top1;
  const top2 = routeResult.data?.top2;
  const contractId = top1?.contract_id ?? null;

  // Build a Set of contract IDs from pack
  const packContractIds = new Set(pack.contracts.map(c => c.contract_id));

  // Define router mismatch condition
  const routerMismatch = contractId !== null && !packContractIds.has(contractId);

  if (routerMismatch) {
    // fail-open on router mismatch
    return stampRequestId({
      outcome: "PROCEED",
      contractId: null,
    }, routerRequestId);
  }

  // If no contract ID found, fail-open
  if (!contractId) {
    return stampRequestId({
      outcome: "PROCEED",
      contractId: null,
    }, routerRequestId);
  }

  // Strictly pack-driven uncertainty gating for CANVAS_UI
  // Thresholds MUST come from pack config - no hardcoded defaults
  const thresholds = pack.thresholds;
  const minConfidenceT = thresholds?.min_confidence_T;
  const dominanceMarginDelta = thresholds?.dominance_margin_Delta;

  // Hard-block if either threshold is missing/undefined - pack policy is incomplete
  if (minConfidenceT === undefined || dominanceMarginDelta === undefined) {
    const missingFields: string[] = [];
    if (minConfidenceT === undefined) {missingFields.push("min_confidence_T");}
    if (dominanceMarginDelta === undefined) {missingFields.push("dominance_margin_Delta");}
    
    return stampRequestId({
      outcome: "ABSTAIN_CLARIFY",
      reason: "PACK_POLICY_INCOMPLETE",
      contractId: null,
      instructions: `CANVAS_UI pack policy is incomplete. Missing required threshold(s): ${missingFields.join(", ")}. Update the pack configuration to include these values before proceeding.`,
    }, routerRequestId);
  }

  // Apply uncertainty gating with pack-driven thresholds
  if (top1?.score !== undefined) {
    const top1Score = top1.score;

    // Check if confidence is below threshold (top1.score < min_confidence_T)
    const lowConfidence = top1Score < minConfidenceT;

    // Check if dominance margin is insufficient (top1.score - top2.score < dominance_margin_Delta)
    const lowDominance = top2?.score !== undefined &&
      (top1Score - top2.score) < dominanceMarginDelta;

    if (lowConfidence || lowDominance) {
      return stampRequestId({
        outcome: "ABSTAIN_CLARIFY",
        reason: "LOW_DOMINANCE_OR_CONFIDENCE",
        contractId,
      }, routerRequestId);
    }
  }

  // Look up the contract in the pack
  const contract = findContractById(pack, contractId);
  
  // If contract not found in pack, proceed (fail-open)
  if (!contract) {
    return stampRequestId({
      outcome: "PROCEED",
      contractId,
    }, routerRequestId);
  }

  // Check if confirmation is required and not yet provided
  // Enforce ABSTAIN_CONFIRM for HIGH/CRITICAL risk classes or needs_confirmation
  if (contractRequiresConfirmation(contract) && context.userConfirmed !== true) {
    return stampRequestId({
      outcome: "ABSTAIN_CONFIRM",
      reason: "CONFIRM_REQUIRED",
      contractId,
      instructions: `This operation requires user confirmation. Contract "${contractId}" has risk_class="${contract.risk_class}" or needs_confirmation=true. To proceed, the caller must set userConfirmed=true after obtaining explicit user consent.`,
    }, routerRequestId);
  }

  // Default: proceed with the canvas UI operation
  return stampRequestId({
    outcome: "PROCEED",
    contractId,
  }, routerRequestId);
}

/**
 * Applies canvas UI overrides for the CANVAS_UI stage.
 *
 * This function evaluates whether a canvas UI operation should proceed or require
 * user confirmation based on the contract's risk classification and
 * confidence/dominance thresholds.
 *
 * Behavior:
 * - If routeResult is not ok: abstain with router_outage reason
 * - If routeResult is ok:
 *   - Extracts contract_id from routeResult.data.top1.contract_id
 *   - Validates that pack thresholds are defined → ABSTAIN_CLARIFY if missing
 *   - Checks thresholds for low confidence/dominance → ABSTAIN_CLARIFY
 *   - Validates router result matches pack contracts → fail-open on mismatch
 *   - Looks up contract in pack.contracts
 *   - If contract has needs_confirmation: true OR risk_class is HIGH/CRITICAL
 *     AND context.userConfirmed !== true: returns ABSTAIN_CONFIRM
 *   - Otherwise: returns PROCEED
 *
 * @param context - The canvas UI context including userConfirmed flag
 * @returns The override outcome indicating whether to proceed or abstain
 *
 * @example
 * ```typescript
 * const context = { stageId: "CANVAS_UI", userConfirmed: false, componentType: "form", canvasId: "main-canvas" };
 *
 * const result = await applyCanvasUiOverrides(context);
 * // Returns: { outcome: "PROCEED", contractId: "CANVAS_FORM_RENDER" }
 * ```
 */
export async function applyCanvasUiOverrides(
  context: CanvasUiContext
): Promise<OverrideOutcome> {
  return applyCanvasUiOverridesImpl(context);
}
