import { describe, expect, it, vi } from "vitest";
import type {
  WorkerExecApprovalResponseFrame,
  WorkerExecApprovalDecisionResponseFrame,
} from "../../packages/gateway-protocol/src/schema/worker-exec-approval.js";
import { createWorkerExecApprovalTransport } from "./worker-exec-approval.js";

function fixture(signal?: AbortSignal) {
  const assertCurrent = vi.fn();
  const client = {
    captureExecApprovalAuthority: () => assertCurrent,
    requestExecApproval: vi.fn(async (): Promise<WorkerExecApprovalResponseFrame> => ({
      type: "res",
      id: "rpc-register",
      ok: true,
      payload: { id: "approval", expiresAtMs: 123_456 },
    })),
    requestExecApprovalDecision: vi.fn(
      async (): Promise<WorkerExecApprovalDecisionResponseFrame> => ({
        type: "res",
        id: "rpc-wait",
        ok: true,
        payload: { decision: "allow-once" },
      }),
    ),
  };
  return { client, assertCurrent, transport: createWorkerExecApprovalTransport(client, signal) };
}
const request = {
  id: "approval",
  command: "hostname",
  cwd: "/workspace",
  host: "gateway" as const,
  security: "allowlist" as const,
  ask: "always" as const,
  timeoutMs: 30_000,
  twoPhase: true as const,
  toolCallId: "exec-1",
};

describe("worker exec approval transport", () => {
  it("sends command data without allowing the worker to choose its Gateway identity", async () => {
    const { client, transport } = fixture();
    await transport.request({
      ...request,
      agentId: "forged",
      sessionKey: "forged",
      runId: "forged",
      approvalReviewerDeviceIds: ["forged"],
    });
    expect(client.requestExecApproval).toHaveBeenCalledWith({
      id: "approval",
      command: "hostname",
      cwd: "/workspace",
      toolCallId: "exec-1",
    });
    await expect(transport.waitDecision({ id: "approval" })).resolves.toEqual({
      decision: "allow-once",
    });
  });

  it("rejects an allowed result when the worker was aborted during the human wait", async () => {
    const abort = new AbortController();
    const { client, transport } = fixture(abort.signal);
    client.requestExecApprovalDecision.mockImplementation(async () => {
      abort.abort(new Error("worker stopped"));
      return { type: "res", id: "rpc-wait", ok: true, payload: { decision: "allow-once" } };
    });
    await expect(transport.waitDecision({ id: "approval" })).rejects.toThrow("worker stopped");
  });

  it("cancels a pending human wait without waiting for a transport timeout", async () => {
    const abort = new AbortController();
    const { client, transport } = fixture(abort.signal);
    client.requestExecApprovalDecision.mockImplementation(() => new Promise(() => {}));
    const pending = transport.waitDecision({ id: "approval" });
    const rejected = expect(pending).rejects.toThrow("worker stopped");
    abort.abort(new Error("worker stopped"));
    await rejected;
  });

  it("rechecks connection admission after an allowed decision and before launch", async () => {
    const { client, assertCurrent, transport } = fixture();
    await transport.waitDecision({ id: "approval" });
    assertCurrent.mockImplementation(() => {
      throw new Error("Worker exec approval lost Gateway admission");
    });
    expect(() => transport.assertCurrent?.()).toThrow("lost Gateway admission");
    await expect(transport.request(request)).rejects.toThrow("lost Gateway admission");
    expect(client.requestExecApproval).not.toHaveBeenCalled();
  });

  it("propagates transport failures without authorizing execution", async () => {
    const { client, transport } = fixture();
    client.requestExecApprovalDecision.mockRejectedValue(new Error("connection lost"));
    await expect(transport.waitDecision({ id: "approval" })).rejects.toThrow("connection lost");
  });
});
