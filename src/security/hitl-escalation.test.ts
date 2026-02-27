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
