import { describe, expect, it, vi } from "vitest";
import { createExecApprovalHandlers } from "./exec-approval.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";

/**
 * Creates a minimal ExecApprovalManager mock with a standalone resolve spy
 * to avoid the typescript-eslint/unbound-method lint error when asserting
 * on method calls.
 */
function mockManager(snapshotOverrides: Record<string, unknown> = {}) {
  const resolveSpy = vi.fn(() => true);
  const mgr = {
    lookupPendingId: vi.fn(() => ({ kind: "exact" as const, id: "appr-1" })),
    getSnapshot: vi.fn(() => ({
      requestedByConnId: null,
      request: { command: "echo test" },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      ...snapshotOverrides,
    })),
    resolve: resolveSpy,
    create: vi.fn(),
    register: vi.fn(),
    expire: vi.fn(),
    awaitDecision: vi.fn(),
  } as unknown as ExecApprovalManager;
  return { mgr, resolveSpy };
}

interface ResolveOpts {
  decision: string;
  requesterConnId: string | null;
  approverConnId: string | undefined;
  approverName?: string;
}

/**
 * Invokes exec.approval.resolve with controlled connId values for requester
 * (stored in the approval snapshot) and approver (on the calling client).
 */
async function invokeResolve(opts: ResolveOpts) {
  const { mgr, resolveSpy } = mockManager({
    requestedByConnId: opts.requesterConnId,
  });
  const handlers = createExecApprovalHandlers(mgr);
  const respond = vi.fn();

  await handlers["exec.approval.resolve"]({
    params: { id: "appr-1", decision: opts.decision },
    respond,
    client: {
      connId: opts.approverConnId,
      connect: {
        client: {
          displayName: opts.approverName ?? "Approver",
          id: "cli",
        },
      },
    },
    context: {
      broadcast: vi.fn(),
      logGateway: { info: vi.fn(), error: vi.fn() },
    },
    req: {
      type: "req" as const,
      id: "test-req",
      method: "exec.approval.resolve",
    },
    isWebchatConnect: () => false,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  return { respond, resolveSpy };
}

describe("exec.approval.resolve - self-approval prevention", () => {
  it("rejects allow-once from the same connection that requested the approval", async () => {
    const { respond, resolveSpy } = await invokeResolve({
      decision: "allow-once",
      requesterConnId: "conn-A",
      approverConnId: "conn-A",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "requester cannot approve their own exec request",
      }),
    );
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("rejects allow-always from the same connection that requested the approval", async () => {
    const { respond, resolveSpy } = await invokeResolve({
      decision: "allow-always",
      requesterConnId: "conn-A",
      approverConnId: "conn-A",
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "requester cannot approve their own exec request",
      }),
    );
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("allows self-deny so the requester can cancel their own request", async () => {
    const { respond, resolveSpy } = await invokeResolve({
      decision: "deny",
      requesterConnId: "conn-A",
      approverConnId: "conn-A",
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(resolveSpy).toHaveBeenCalledWith("appr-1", "deny", "Approver");
  });

  it("allows approval from a different connection", async () => {
    const { respond, resolveSpy } = await invokeResolve({
      decision: "allow-once",
      requesterConnId: "conn-A",
      approverConnId: "conn-B",
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(resolveSpy).toHaveBeenCalledWith(
      "appr-1",
      "allow-once",
      "Approver",
    );
  });

  it("does not block when the original request has no connId recorded", async () => {
    const { respond, resolveSpy } = await invokeResolve({
      decision: "allow-once",
      requesterConnId: null,
      approverConnId: "conn-X",
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(resolveSpy).toHaveBeenCalled();
  });

  it("does not block when the approver client has no connId", async () => {
    const { respond, resolveSpy } = await invokeResolve({
      decision: "allow-once",
      requesterConnId: "conn-A",
      approverConnId: undefined,
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(resolveSpy).toHaveBeenCalled();
  });

  it("does not block when the approver client is null", async () => {
    const { mgr, resolveSpy } = mockManager({
      requestedByConnId: "conn-A",
    });
    const handlers = createExecApprovalHandlers(mgr);
    const respond = vi.fn();

    await handlers["exec.approval.resolve"]({
      params: { id: "appr-1", decision: "allow-once" },
      respond,
      client: null,
      context: {
        broadcast: vi.fn(),
        logGateway: { info: vi.fn(), error: vi.fn() },
      },
      req: {
        type: "req" as const,
        id: "test-req-null-client",
        method: "exec.approval.resolve",
      },
      isWebchatConnect: () => false,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(resolveSpy).toHaveBeenCalled();
  });
});
