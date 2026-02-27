/**
 * Global ExecApprovalManager singleton for IBEL HITL escalations.
 *
 * Mirrors the hook-runner-global.ts pattern. The gateway initializes this
 * during startup so that the guard pipeline can resolve escalations against
 * the real approval manager instead of creating orphaned instances.
 */

import type { ExecApprovalManager } from "../gateway/exec-approval-manager.js";

let globalExecApprovalManager: ExecApprovalManager | null = null;

/**
 * Store the gateway's ExecApprovalManager as a global singleton.
 * Called once during gateway startup after the manager is created.
 */
export function initializeGlobalExecApprovalManager(manager: ExecApprovalManager): void {
  globalExecApprovalManager = manager;
}

/**
 * Get the global ExecApprovalManager.
 * Returns null if the gateway hasn't initialized yet (non-gateway context).
 */
export function getGlobalExecApprovalManager(): ExecApprovalManager | null {
  return globalExecApprovalManager;
}

/**
 * Reset the global singleton (for testing).
 */
export function resetGlobalExecApprovalManager(): void {
  globalExecApprovalManager = null;
}
