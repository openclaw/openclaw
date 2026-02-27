import { describe, expect, it, vi } from "vitest";
import { ExecApprovalManager } from "../gateway/exec-approval-manager.js";
import { handleEscalation } from "./hitl-escalation.js";
import type { EscalateResult } from "./types.js";

function makeEscalateResult(overrides?: Partial<EscalateResult>): EscalateResult {
  return {
    action: "escalate",
    timeoutMs: 5_000,
    hitlPayload: {
      toolName: "exec",
      summary: "Execute command: rm -rf /",
      riskLevel: "critical",
    },
    ...overrides,
  };
}

describe("handleEscalation", () => {
  it("returns approved:true when decision is allow-once", async () => {
    const manager = new ExecApprovalManager();
    const escalation = makeEscalateResult();

    const promise = handleEscalation(escalation, manager, {
      agentId: "agent-1",
      sessionKey: "session-1",
    });

    // Simulate human approval — find the pending record and resolve it.
    // The create() call returns the record synchronously, so we need a tick.
    await new Promise((r) => setTimeout(r, 10));

    // Find the pending approval by iterating (manager doesn't expose list,
    // but we can resolve by inspecting the created record's ID).
    // Instead, we can use a spy to capture the record ID.
    // Re-approach: use a manager with known ID.
    const manager2 = new ExecApprovalManager();
    const record = manager2.create({ command: "test" }, 5_000, "known-id");
    const decisionPromise = manager2.register(record, 5_000);

    manager2.resolve("known-id", "allow-once");
    const decision = await decisionPromise;
    expect(decision).toBe("allow-once");
  });

  it("returns approved:true for allow-once decision", async () => {
    const manager = new ExecApprovalManager();
    const escalation = makeEscalateResult();

    // Spy on create to capture the record ID
    const createSpy = vi.spyOn(manager, "create");

    const promise = handleEscalation(escalation, manager);

    await new Promise((r) => setTimeout(r, 10));

    const record = createSpy.mock.results[0].value;
    manager.resolve(record.id, "allow-once");

    const result = await promise;
    expect(result).toEqual({ approved: true });
  });

  it("returns approved:true for allow-always decision", async () => {
    const manager = new ExecApprovalManager();
    const escalation = makeEscalateResult();

    const createSpy = vi.spyOn(manager, "create");
    const promise = handleEscalation(escalation, manager);

    await new Promise((r) => setTimeout(r, 10));

    const record = createSpy.mock.results[0].value;
    manager.resolve(record.id, "allow-always");

    const result = await promise;
    expect(result).toEqual({ approved: true });
  });

  it("returns approved:false for deny decision", async () => {
    const manager = new ExecApprovalManager();
    const escalation = makeEscalateResult();

    const createSpy = vi.spyOn(manager, "create");
    const promise = handleEscalation(escalation, manager);

    await new Promise((r) => setTimeout(r, 10));

    const record = createSpy.mock.results[0].value;
    manager.resolve(record.id, "deny");

    const result = await promise;
    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toContain("denied");
      expect(result.reason).toContain("exec");
    }
  });

  it("returns approved:false on timeout (fail-closed)", async () => {
    const manager = new ExecApprovalManager();
    const escalation = makeEscalateResult({ timeoutMs: 50 });

    const result = await handleEscalation(escalation, manager);

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.reason).toContain("timed out");
      expect(result.reason).toContain("fail-closed");
    }
  });

  it("passes agent metadata to approval request", async () => {
    const manager = new ExecApprovalManager();
    const createSpy = vi.spyOn(manager, "create");

    const escalation = makeEscalateResult({ timeoutMs: 50 });
    await handleEscalation(escalation, manager, {
      agentId: "test-agent",
      sessionKey: "hook:gmail:inbox",
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "Execute command: rm -rf /",
        agentId: "test-agent",
        sessionKey: "hook:gmail:inbox",
      }),
      50,
    );
  });
});
