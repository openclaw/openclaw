/**
 * Runtime Security Module - Unified exports for runtime security features.
 *
 * This module provides comprehensive runtime security controls for OpenClaw,
 * inspired by Claude Code's security architecture.
 *
 * ## Security Layers
 *
 * 1. **Denial Tracking** - Prevents LLMs from repeatedly attempting blocked operations
 * 2. **Sensitive Path Protection** - Protects dangerous files/directories with bypass immunity
 * 3. **Dangerous Pattern Detection** - Identifies potentially dangerous command patterns
 * 4. **Classifier Interface** - Integration point for external AI security classifiers
 *
 * ## Usage
 *
 * ```typescript
 * import {
 *   // Denial tracking
 *   recordAgentDenial,
 *   shouldFallbackToPrompting,
 *
 *   // Path protection
 *   checkSensitivePath,
 *   validateWritePath,
 *
 *   // Pattern detection
 *   isDangerousAllowlistPattern,
 *   analyzeCommandSecurity,
 *
 *   // Classifier
 *   configureClassifier,
 *   classifyAction,
 * } from "./security/runtime-security.js";
 * ```
 *
 * ## Integration with Exec Approvals
 *
 * These modules are designed to integrate with the existing exec-approvals system:
 *
 * 1. Before checking allowlist, check if path/command is sensitive
 * 2. On denial, record it in denial tracking
 * 3. If denial limits exceeded, force manual approval or abort
 * 4. Optionally, run classifier for additional security layer
 *
 * @see https://github.com/anthropics/claude-code - Reference implementation
 */

// Denial Tracking
export {
  // Types
  type DenialTrackingState,
  type DenialLimits,

  // Constants
  DEFAULT_DENIAL_LIMITS,

  // State management
  createDenialTrackingState,
  recordDenial,
  recordSuccess,
  resetDenialTrackingState,
  resetConsecutiveDenials,

  // Checks
  isDenialLimitExceeded,
  shouldFallbackToPrompting,
  isCooldownActive,
  getDenialStatusMessage,

  // Per-agent state
  getAgentDenialState,
  setAgentDenialState,
  recordAgentDenial,
  recordAgentSuccess,
  clearAgentDenialState,
  clearAllDenialStates,
} from "./denial-tracking.js";

// Sensitive Path Protection
export {
  // Constants
  DANGEROUS_FILES,
  DANGEROUS_DIRECTORIES,
  GIT_BARE_REPO_FILES,

  // Types
  type SensitivePathCheckResult,

  // Functions
  checkSensitivePath,
  isSettingsPath,
  isHomeSensitivePath,
  getProtectedPathsInDirectory,
  validateWritePath,
  normalizeCaseForComparison,
} from "./sensitive-paths.js";

// Dangerous Execution Patterns
export {
  // Pattern lists
  INTERPRETER_PATTERNS,
  PACKAGE_RUNNER_PATTERNS,
  SHELL_EXEC_PATTERNS,
  REMOTE_EXEC_PATTERNS,
  NETWORK_TOOL_PATTERNS,
  ALL_DANGEROUS_PATTERNS,

  // Types
  type DangerousPatternCategory,
  type DangerousPatternMatch,

  // Functions
  matchesDangerousPattern,
  isDangerousAllowlistPattern,
  stripDangerousAllowlistPatterns,
  hasShellInjectionPattern,
  analyzeCommandSecurity,
} from "./dangerous-exec-patterns.js";

// Classifier Interface
export {
  // Types
  type ClassifierContext,
  type ClassifierAction,
  type TranscriptEntry,
  type TranscriptContent,
  type AgentContext,
  type UserSecurityRules,
  type SessionContext,
  type ClassifierResult,
  type SecurityRiskCategory,
  type ClassifierUnavailableResult,
  type ClassifierResponse,
  type ClassifierCapabilities,
  type ClassifierConfig,
  type ISecurityClassifier,

  // Constants
  DEFAULT_CLASSIFIER_CONFIG,

  // Registry
  registerClassifier,
  getClassifier,
  listClassifiers,
  unregisterClassifier,

  // Configuration
  configureClassifier,
  getClassifierConfig,
  isClassifierEnabled,

  // Classification
  classifyAction,
  buildExecClassifierContext,
  interpretClassifierResult,

  // Built-in classifiers
  StubAllowClassifier,
  StubDenyClassifier,
  HttpClassifierClient,
} from "./classifier-interface.js";

// ============================================================================
// Integration Helpers
// ============================================================================

import type { ExecSecurity } from "../infra/exec-approvals.js";
import { recordAgentDenial, shouldFallbackToPrompting, getAgentDenialState, DEFAULT_DENIAL_LIMITS } from "./denial-tracking.js";
import { checkSensitivePath, validateWritePath } from "./sensitive-paths.js";
import { isDangerousAllowlistPattern, stripDangerousAllowlistPatterns, analyzeCommandSecurity } from "./dangerous-exec-patterns.js";
import { classifyAction, buildExecClassifierContext, interpretClassifierResult, isClassifierEnabled } from "./classifier-interface.js";
import type { ClassifierResponse } from "./classifier-interface.js";

/**
 * Comprehensive security check for a command execution request.
 * This is the main entry point for integrating runtime security into exec approvals.
 *
 * @returns Security check result with action recommendations
 */
export async function checkExecSecurity(params: {
  command: string;
  argv?: string[];
  cwd?: string;
  targetPath?: string;
  agentId: string;
  securityLevel: ExecSecurity;
  allowlistPatterns?: string[];
}): Promise<{
  /** Whether the action should be blocked */
  blocked: boolean;
  /** Whether user approval is required */
  requiresApproval: boolean;
  /** Reason for the decision */
  reason: string;
  /** Whether denial limits have been exceeded */
  denialLimitExceeded: boolean;
  /** Classifier result (if classifier is enabled) */
  classifierResult?: ClassifierResponse;
  /** Risk analysis */
  riskAnalysis: ReturnType<typeof analyzeCommandSecurity>;
  /** Dangerous patterns found in allowlist */
  dangerousAllowlistPatterns?: string[];
}> {
  const riskAnalysis = analyzeCommandSecurity(params.command);

  // Check for dangerous allowlist patterns
  let dangerousAllowlistPatterns: string[] | undefined;
  if (params.allowlistPatterns) {
    const { stripped } = stripDangerousAllowlistPatterns(params.allowlistPatterns, { criticalOnly: true });
    if (stripped.length > 0) {
      dangerousAllowlistPatterns = stripped;
    }
  }

  // Check sensitive path if target path is provided
  if (params.targetPath) {
    const pathCheck = validateWritePath(params.targetPath, params.securityLevel);
    if (!pathCheck.allowed && pathCheck.requiresApproval) {
      return {
        blocked: true,
        requiresApproval: true,
        reason: pathCheck.reason ?? "Sensitive path requires approval",
        denialLimitExceeded: false,
        riskAnalysis,
        dangerousAllowlistPatterns,
      };
    }
  }

  // Check denial limits
  const denialState = getAgentDenialState(params.agentId);
  const denialLimitExceeded = shouldFallbackToPrompting(denialState);

  // Run classifier if enabled
  let classifierResult: ClassifierResponse | undefined;
  if (isClassifierEnabled()) {
    const context = buildExecClassifierContext({
      command: params.command,
      argv: params.argv,
      cwd: params.cwd,
      agentId: params.agentId,
      securityLevel: params.securityLevel,
    });

    classifierResult = await classifyAction(context);
    const interpreted = interpretClassifierResult(classifierResult);

    if (interpreted.shouldBlock) {
      return {
        blocked: true,
        requiresApproval: interpreted.requiresUserApproval,
        reason: interpreted.reason,
        denialLimitExceeded,
        classifierResult,
        riskAnalysis,
        dangerousAllowlistPatterns,
      };
    }
  }

  // High-risk commands require approval even without classifier
  if (riskAnalysis.riskLevel === "critical") {
    return {
      blocked: true,
      requiresApproval: true,
      reason: riskAnalysis.summary,
      denialLimitExceeded,
      classifierResult,
      riskAnalysis,
      dangerousAllowlistPatterns,
    };
  }

  return {
    blocked: false,
    requiresApproval: false,
    reason: "Security checks passed",
    denialLimitExceeded,
    classifierResult,
    riskAnalysis,
    dangerousAllowlistPatterns,
  };
}

/**
 * Record an execution denial and check if limits are exceeded.
 * Call this after a user denies an execution request.
 */
export function recordExecDenial(agentId: string): {
  state: ReturnType<typeof getAgentDenialState>;
  limitExceeded: boolean;
  message: string | null;
} {
  const state = recordAgentDenial(agentId);
  const limitExceeded = shouldFallbackToPrompting(state);

  let message: string | null = null;
  if (limitExceeded) {
    if (state.totalDenials >= DEFAULT_DENIAL_LIMITS.maxTotal) {
      message = `${state.totalDenials} operations blocked this session. Consider reviewing agent behavior.`;
    } else {
      message = `${state.consecutiveDenials} consecutive operations blocked. Agent may be attempting to bypass restrictions.`;
    }
  }

  return { state, limitExceeded, message };
}
