import { HitlApprovalManager } from "./approval-manager.js";

/**
 * Singleton HITL approval manager.
 *
 * The outbound send gate, plugin HTTP route gate, and gateway webhook handler
 * all run in the gateway process and coordinate through this in-memory map.
 */
export const hitlApprovalManager = new HitlApprovalManager();
