import { getGlobalUPCManager } from "../security/upc-manager.js";
import { DANGEROUS_ACP_TOOLS } from "../security/dangerous-tools.js";

/**
 * UPC Verification Handler
 * Provides task classification and UPC verification integration for tool execution
 */

export type UPCChallengePayload = {
  type: "upc_verification_required";
  taskName: string;
  taskDescription?: string;
  approvalId?: string;
};

/**
 * Check if a tool/task name is classified as high-risk
 */
export function isHighRiskTask(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return DANGEROUS_ACP_TOOLS.has(normalized);
}

/**
 * Check if UPC verification is required for the given task
 * Returns true if:
 * - UPC is enabled AND
 * - The task is high-risk AND
 * - The session is not already verified
 */
export function requiresUPCVerification(toolName: string, sessionId?: string): boolean {
  const upcManager = getGlobalUPCManager();

  // If UPC is not enabled, no verification needed
  if (!upcManager.isEnabled()) {
    return false;
  }

  // Check if task is high-risk
  if (!isHighRiskTask(toolName)) {
    return false;
  }

  // If no session ID, require verification
  if (!sessionId) {
    return true;
  }

  // Check if session is already verified
  return !upcManager.isSessionVerified(sessionId);
}

/**
 * Create a UPC verification challenge for a task
 */
export function createUPCChallenge(toolName: string, taskDescription?: string): UPCChallengePayload {
  return {
    type: "upc_verification_required",
    taskName: toolName,
    taskDescription,
  };
}

/**
 * Verify UPC input for a given task
 */
export function verifyUPCInput(
  input: string,
  sessionId: string,
  taskName: string,
): {
  verified: boolean;
  error?: string;
  remainingAttempts?: number;
} {
  const upcManager = getGlobalUPCManager();
  return upcManager.verifyUPC(input, sessionId);
}

/**
 * Mark a session as verified for UPC
 */
export function markSessionVerified(sessionId: string): void {
  const upcManager = getGlobalUPCManager();
  upcManager.markSessionVerified(sessionId);
}

/**
 * Get the UPC status
 */
export function getUPCStatus(): {
  enabled: boolean;
  hasUPC: boolean;
  isLocked: boolean;
} {
  const upcManager = getGlobalUPCManager();
  return upcManager.getStatus();
}

/**
 * Check if a session is currently verified for UPC
 */
export function isSessionVerified(sessionId?: string): boolean {
  if (!sessionId) {
    return false;
  }

  const upcManager = getGlobalUPCManager();
  return upcManager.isSessionVerified(sessionId);
}

/**
 * Get a human-readable description of a tool/task
 */
export function getTaskDescription(toolName: string): string {
  const normalized = normalizeToolName(toolName);

  const descriptions: Record<string, string> = {
    exec: "Execute system command",
    spawn: "Spawn new process",
    shell: "Execute shell command",
    fs_write: "Write to file system",
    fs_delete: "Delete file(s)",
    fs_move: "Move/rename file(s)",
    sessions_spawn: "Spawn new session",
    sessions_send: "Send command to session",
    gateway: "Reconfigure gateway",
    apply_patch: "Apply code patch",
  };

  return descriptions[normalized] || `Execute ${toolName}`;
}

/**
 * Normalize tool names to lowercase
 */
function normalizeToolName(name: string): string {
  return (name || "").toLowerCase().trim();
}

/**
 * Clear session verification (e.g., after session ends)
 */
export function clearSessionVerification(sessionId: string): void {
  const upcManager = getGlobalUPCManager();
  upcManager.clearSessionVerification(sessionId);
}
