/**
 * TOOL_DISPATCH_GATE Cron Preflight Lock Required Tripwire Test
 *
 * Verifies that CronPreflightGate integration into TOOL_DISPATCH_GATE enforces
 * fail-closed cron task validation and capability-based access control.
 *
 * Tests verify:
 * 1. Cron run without locked task → tool dispatch blocked
 * 2. Cron run with locked task but capability not in metadata → tool dispatch blocked
 * 3. Cron run with locked task and capability in metadata → tool dispatch allowed
 * 4. Cron run with ESCALATE_CRON_STATE_INVALID outcome → all tool dispatch blocked
 * 5. Non-cron run → no preflight check, tool dispatch normal
 */

import { describe, it, expect } from "vitest";
import { applyToolDispatchOverrides } from "../decision-override";
import { createCronDecisionRecord, lockCronTask } from "../decision-cron.js";
import type { OntologyPack } from "../pack-registry";
import type { DispatchContext } from "../decision-override";

/**
 * Creates a minimal but valid LedgerVerificationResult for testing
 */
function createMockLedgerVerification() {
  return {
    valid: true,
    entries_checked: 10,
    window_size: 50,
    verified_at: new Date().toISOString(),
  };
}

/**
 * Creates a mock TOOL_DISPATCH_GATE ontology pack for testing
 */
function createToolDispatchGatePack(): OntologyPack {
  return {
    pack_id: "openclawd.TOOL_DISPATCH_GATE_CRON_TEST",
    pack_version: "2.0.0",
    stage_id: "TOOL_DISPATCH_GATE",
    description: "Test pack for TOOL_DISPATCH_GATE cron integration",
    thresholds: {
      min_confidence_T: 0.55,
      dominance_margin_Delta: 0.10,
    },
    contracts: [
      {
        contract_id: "DISPATCH_SHELL_EXEC",
        risk_class: "HIGH",
        required_fields: ["command"],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: [],
      },
      {
        contract_id: "DISPATCH_FILE_WRITE",
        risk_class: "MEDIUM",
        required_fields: ["path"],
        limits: {},
        needs_confirmation: false,
        deny_by_default: false,
        capability_requirements: [],
      },
    ],
    field_schema: {},
  };
}

describe("TOOL_DISPATCH_GATE cron_preflight → lock_required tripwire", () => {
  /**
   * Test 1: Cron run without locked task → tool dispatch blocked
   *
   * When cronMode=true but CronDecisionRecord is missing,
   * checkCronDispatchCapability() should return allowed=false.
   * applyToolDispatchOverrides() should return ABSTAIN_CLARIFY.
   */
  it("Test 1: Cron run without locked task → tool dispatch blocked", () => {
    const pack = createToolDispatchGatePack();
    const routeResult = {
      ok: true,
      data: {
        top1: { contract_id: "DISPATCH_SHELL_EXEC", score: 0.95 },
      },
    };

    // Context: cron mode but NO CronDecisionRecord
    const context: DispatchContext = {
      stageId: "TOOL_DISPATCH_GATE",
      cronMode: true,
      userConfirmed: false,
    };

    const result = applyToolDispatchOverrides(pack, routeResult, context);

    expect(result.outcome).toBe("ABSTAIN_CLARIFY");
    expect((result as any).reason).toBe("capability_denied");
    expect(result.contractId).toBe("DISPATCH_SHELL_EXEC");
    expect((result as any).instructions).toContain("Cron mode requires locked task");
  });

  /**
   * Test 2: Cron run with locked task but capability not in metadata → tool dispatch blocked
   *
   * Cron task HEARTBEAT_CHECK only allows ["network"] capability.
   * Attempting to dispatch SHELL_EXEC (inferred to need "shell" capability)
   * should be denied.
   */
  it("Test 2: Cron run with locked task but capability not in metadata → tool dispatch blocked", () => {
    const pack = createToolDispatchGatePack();
    const routeResult = {
      ok: true,
      data: {
        top1: { contract_id: "DISPATCH_SHELL_EXEC", score: 0.95 },
      },
    };

    // Create locked CronDecisionRecord with HEARTBEAT_CHECK (only allows "network")
    const cronDecision = createCronDecisionRecord(
      "run-123",
      createMockLedgerVerification()
    );
    lockCronTask(cronDecision, "HEARTBEAT_CHECK");

    const context: DispatchContext = {
      stageId: "TOOL_DISPATCH_GATE",
      cronMode: true,
      cronDecision,
      userConfirmed: false,
    };

    const result = applyToolDispatchOverrides(pack, routeResult, context);

    expect(result.outcome).toBe("ABSTAIN_CLARIFY");
    expect((result as any).reason).toBe("capability_denied");
    expect(result.contractId).toBe("DISPATCH_SHELL_EXEC");
    // Should mention capability mismatch in instructions
    expect((result as any).instructions).toContain("does not permit capability");
  });

  /**
   * Test 3: Cron run with locked task and capability in metadata → tool dispatch allowed
   *
   * Cron task MEMORY_MAINTENANCE allows ["sensitive_access"] capability.
   * Dispatching DISPATCH_FILE_WRITE (inferred to need "file_system" or related)
   * should check against the actual contract requirements (which are empty in our pack).
   * Since the pack doesn't define capability_requirements strictly, the inferred
   * capability check passes if it's reasonable.
   *
   * For this test, we use a task that allows a broad set of capabilities.
   */
  it("Test 3: Cron run with locked task and capability in metadata → tool dispatch allowed", () => {
    const pack = createToolDispatchGatePack();
    const routeResult = {
      ok: true,
      data: {
        top1: { contract_id: "DISPATCH_FILE_WRITE", score: 0.95 },
      },
    };

    // Create locked CronDecisionRecord with BACKUP_EXECUTION
    // which allows ["file_system", "sensitive_access"]
    const cronDecision = createCronDecisionRecord(
      "run-456",
      createMockLedgerVerification()
    );
    lockCronTask(cronDecision, "BACKUP_EXECUTION");

    const context: DispatchContext = {
      stageId: "TOOL_DISPATCH_GATE",
      cronMode: true,
      cronDecision,
      userConfirmed: false,
    };

    const result = applyToolDispatchOverrides(pack, routeResult, context);

    // Should proceed because:
    // 1. Task is locked (BACKUP_EXECUTION)
    // 2. Capability check passes (file_system is in requiredCapabilities for BACKUP_EXECUTION)
    // 3. Contract risk_class is MEDIUM, not HIGH, and needs_confirmation is false
    expect(result.outcome).toBe("PROCEED");
    expect(result.contractId).toBe("DISPATCH_FILE_WRITE");
  });

  /**
   * Test 4: Cron run with ESCALATE_CRON_STATE_INVALID outcome → all tool dispatch blocked
   *
   * When CronDecisionRecord has escalation flag set, checkCronDispatchCapability()
   * should return allowed=false and applyToolDispatchOverrides() should
   * return ABSTAIN_CLARIFY regardless of capability match.
   */
  it("Test 4: Cron run with ESCALATE_CRON_STATE_INVALID outcome → all tool dispatch blocked", () => {
    const pack = createToolDispatchGatePack();
    const routeResult = {
      ok: true,
      data: {
        top1: { contract_id: "DISPATCH_SHELL_EXEC", score: 0.95 },
      },
    };

    // Create locked CronDecisionRecord with escalation marker
    const cronDecision = createCronDecisionRecord(
      "run-789",
      createMockLedgerVerification()
    );
    lockCronTask(cronDecision, "BACKUP_EXECUTION");
    // Mark as escalated
    (cronDecision as unknown as Record<string, unknown>).escalation = true;

    const context: DispatchContext = {
      stageId: "TOOL_DISPATCH_GATE",
      cronMode: true,
      cronDecision,
      userConfirmed: false,
    };

    const result = applyToolDispatchOverrides(pack, routeResult, context);

    expect(result.outcome).toBe("ABSTAIN_CLARIFY");
    expect((result as any).reason).toBe("capability_denied");
    expect(result.contractId).toBe("DISPATCH_SHELL_EXEC");
    expect((result as any).instructions).toContain("escalation");
  });

  /**
   * Test 5: Non-cron run → no preflight check, tool dispatch normal
   *
   * When cronMode is not set and no CronDecisionRecord in context,
   * cron preflight checks should be skipped entirely.
   * Dispatch should proceed based on normal confirmation logic.
   */
  it("Test 5: Non-cron run → no preflight check, tool dispatch normal", () => {
    const pack = createToolDispatchGatePack();
    const routeResult = {
      ok: true,
      data: {
        top1: { contract_id: "DISPATCH_SHELL_EXEC", score: 0.95 },
      },
    };

    // Context: NOT in cron mode
    const context: DispatchContext = {
      stageId: "TOOL_DISPATCH_GATE",
      userConfirmed: true, // User confirmed execution
    };

    const result = applyToolDispatchOverrides(pack, routeResult, context);

    // Should proceed because:
    // 1. Not in cron mode (no preflight checks)
    // 2. User confirmed, so confirmation requirement is satisfied
    expect(result.outcome).toBe("PROCEED");
    expect(result.contractId).toBe("DISPATCH_SHELL_EXEC");
  });

  /**
   * Bonus: Verify that HIGH-risk contracts still require confirmation
   * even in non-cron mode (backward compatibility)
   */
  it("Bonus: HIGH-risk contract requires confirmation in non-cron mode", () => {
    const pack = createToolDispatchGatePack();
    const routeResult = {
      ok: true,
      data: {
        top1: { contract_id: "DISPATCH_SHELL_EXEC", score: 0.95 },
      },
    };

    // Context: NOT in cron mode, user NOT confirmed
    const context: DispatchContext = {
      stageId: "TOOL_DISPATCH_GATE",
      userConfirmed: false,
    };

    const result = applyToolDispatchOverrides(pack, routeResult, context);

    // Should abstain because DISPATCH_SHELL_EXEC is HIGH risk
    expect(result.outcome).toBe("ABSTAIN_CONFIRM");
    expect((result as any).reason).toBe("CONFIRM_REQUIRED");
    expect(result.contractId).toBe("DISPATCH_SHELL_EXEC");
  });
});
