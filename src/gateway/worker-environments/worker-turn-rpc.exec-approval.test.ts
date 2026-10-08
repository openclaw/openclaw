import { beforeEach, describe, expect, it, vi } from "vitest";
import * as support from "./service.test-support.js";

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  identity: vi.fn((request: object, _identity: unknown) => request),
}));
// mock-isolation: Exercise live worker claims without starting another Gateway or approval store.
vi.mock("../../agents/tools/in-process-gateway.js", () => ({
  callAgentToolGatewayRequest: mocks.call,
  withAgentToolGatewayRuntimeIdentity: mocks.identity,
}));

const request = {
  id: "worker-approval-1",
  command: "hostname",
  cwd: "/workspace",
  toolCallId: "tool-1",
};
const registration = { id: request.id, expiresAtMs: Number.MAX_SAFE_INTEGER };

describe("worker exec approval RPC authority", () => {
  support.setupWorkerEnvironmentServiceSuite();
  beforeEach(() => {
    mocks.call.mockReset();
    mocks.identity.mockClear();
  });
  const fixture = async (name: string) => {
    const f = await support.placementHarness(
      name,
      `session-${name}`,
      {
        resolveGatewayContext: () => undefined,
      },
      undefined,
      `run-${name}`,
    );
    f.bindToolSurface(
      {
        applyPromptToolsAllow: vi.fn(),
        getSurface: vi.fn(),
        getPromptProjection: vi.fn(),
        invoke: vi.fn(),
        cancel: vi.fn(),
        abort: vi.fn(),
        close: vi.fn(),
      },
      true,
    );
    return f;
  };

  it("registers and waits using the admitted identity without portable host grants", async () => {
    const { identity, workerService } = await fixture("exec-approved");
    mocks.call
      .mockResolvedValueOnce({
        ...registration,
        status: "accepted",
        deliveryRoute: "operator",
        createdAtMs: 1,
      })
      .mockResolvedValueOnce({
        id: request.id,
        decision: "allow-once",
        createdAtMs: 1,
        expiresAtMs: registration.expiresAtMs,
        terminalReason: "user",
      });
    expect(await workerService.requestExecApproval(identity, request)).toEqual({
      ok: true,
      result: registration,
    });
    expect(mocks.call).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: "exec.approval.request",
        params: expect.objectContaining({
          command: "hostname",
          cwd: "/workspace",
          ask: "always",
          unavailableDecisions: ["allow-always"],
          warningText: expect.stringContaining(identity.environmentId),
        }),
      }),
    );
    expect(mocks.identity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        agentId: "main",
        sessionKey: `agent:main:${identity.sessionId}`,
        operationalRunInstance: expect.objectContaining({ runId: identity.runId }),
        delegatedAuthority: expect.objectContaining({
          kind: "worker",
          turnClaim: identity.turnClaim,
        }),
      }),
    );
    expect(await workerService.waitExecApprovalDecision(identity, { id: request.id })).toEqual({
      ok: true,
      result: { decision: "allow-once" },
    });
  });

  it("cannot wait for another worker's approval or an unregistered ID", async () => {
    const first = await fixture("exec-owner");
    const second = await fixture("exec-other");
    mocks.call.mockResolvedValue(registration);
    expect(await first.workerService.requestExecApproval(first.identity, request)).toEqual({
      ok: true,
      result: registration,
    });
    expect(
      await first.workerService.waitExecApprovalDecision(first.identity, { id: "foreign" }),
    ).toMatchObject({ ok: false });
    expect(
      await first.workerService.waitExecApprovalDecision(second.identity, { id: request.id }),
    ).toMatchObject({ ok: false });
    expect(mocks.call).toHaveBeenCalledTimes(1);
  });

  it.each(["placement", "grant"] as const)(
    "rejects approval after %s revocation while waiting",
    async (revoked) => {
      const { identity, placementStore, workerService } = await fixture(`exec-revoke-${revoked}`);
      mocks.call.mockResolvedValueOnce(registration);
      await workerService.requestExecApproval(identity, request);
      mocks.call.mockImplementationOnce(async () => {
        await Promise.resolve();
        if (revoked === "placement") {
          placementStore.validateWorkerTurn.mockReturnValue(false);
        } else {
          placementStore.isWorkerTurnToolAuthorized.mockReturnValue(false);
        }
        return { decision: "allow-once" };
      });
      expect(await workerService.waitExecApprovalDecision(identity, { id: request.id })).toEqual({
        ok: false,
        closeReason: revoked === "placement" ? "placement-mismatch" : "method-not-allowed",
      });
    },
  );

  it("consumes a decision wait before yielding so concurrent/replayed waits fail closed", async () => {
    const { identity, workerService } = await fixture("exec-once");
    mocks.call.mockResolvedValueOnce(registration);
    await workerService.requestExecApproval(identity, request);
    let resolve!: (value: { decision: "allow-once" }) => void;
    const waitObserved = Promise.withResolvers<void>();
    mocks.call.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
          waitObserved.resolve();
        }),
    );
    const pending = workerService.waitExecApprovalDecision(identity, { id: request.id });
    await waitObserved.promise;
    expect(
      await workerService.waitExecApprovalDecision(identity, { id: request.id }),
    ).toMatchObject({ ok: false });
    resolve({ decision: "allow-once" });
    expect(await pending).toMatchObject({ ok: true });
    expect(
      await workerService.waitExecApprovalDecision(identity, { id: request.id }),
    ).toMatchObject({ ok: false });
    expect(mocks.call).toHaveBeenCalledTimes(2);
  });

  it("rejects missing exec grants before registration", async () => {
    const { identity, placementStore, workerService } = await fixture("exec-not-granted");
    placementStore.isWorkerTurnToolAuthorized.mockReturnValue(false);
    expect(await workerService.requestExecApproval(identity, request)).toEqual({
      ok: false,
      closeReason: "method-not-allowed",
    });
    expect(mocks.call).not.toHaveBeenCalled();
  });

  it.each(["deny", null] as const)("preserves the terminal decision %s", async (decision) => {
    const { identity, workerService } = await fixture(`exec-decision-${decision}`);
    mocks.call.mockResolvedValueOnce(registration).mockResolvedValueOnce({ decision });
    await workerService.requestExecApproval(identity, request);
    expect(await workerService.waitExecApprovalDecision(identity, { id: request.id })).toEqual({
      ok: true,
      result: { decision },
    });
  });

  it("rejects a persistent grant even if the approval owner returns one", async () => {
    const { identity, workerService } = await fixture("exec-persistent");
    mocks.call
      .mockResolvedValueOnce(registration)
      .mockResolvedValueOnce({ decision: "allow-always" });
    await workerService.requestExecApproval(identity, request);
    expect(
      await workerService.waitExecApprovalDecision(identity, { id: request.id }),
    ).toMatchObject({ ok: false });
  });
});
