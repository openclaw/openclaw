import { describe, expect, it, vi } from "vitest";
import { createExecApprovalHandlers } from "./exec-approval.js";
import type { ExecApprovalManager } from "../exec-approval-manager.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";

/**
 * Minimal mock for ExecApprovalManager covering the resolve path.
 * Only the methods exercised by exec.approval.resolve are stubbed.
 */
function mockManager(
  snapshotOverrides: Record<string, unknown> = {},
): ExecApprovalManager {
  return {
    lookupPendingId: vi.fn(() => ({ kind: "exact" as const, id: "appr-1" })),
    getSnapshot: vi.fn(() => ({
      requestedByConnId: null,
      request: { command: "echo test" },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60_000,
      ...snapshotOverrides,
    })),
    resolve: vi.fn(() => true),
    create: vi.fn(),
    register: vi.fn(),
    expire: vi.fn(),
    awaitDecision: vi.fn(),
  } as unknown as ExecApprovalManager;
}

function mockContext(): GatewayRequestContext {
  return {
    broadcast: vi.fn(),
    logGateway: { info: vi.fn(), error: vi.fn() },
  } as unknown as GatewayRequestContext;
}

function makeClient(
  connId: string | undefined,
  displayName = "Approver",
): GatewayClient {
  return {
    connId,
    connect: { client: { displayName, id: "cli" } },
  } as unknown as GatewayClient;
}

interface ResolveOpts {
  decision: string;
  requesterConnId: string | null;
  approverConnId: string | undefined;
  approverName?: string;
}

/**
 * Helper that invokes the exec.approval.resolve handler with controlled
 * connId values for requester (stored in snapshot) and approver (on the client).
 */
async function invokeResolve(opts: ResolveOpts) {
  const mgr = mockManager({ requestedByConnId: opts.requesterConnId });
  const handlers = createExecApprovalHandlers(mgr);
  const respond = vi.fn();

  await handlers["exec.approval.resolve"]({
    params: { id: "appr-1", decision: opts.decision },
    respond: respond as never,
    client: makeClient(opts.approverConnId, opts.approverName ?? "Approver"),
    context: mockContext(),
    req: {
      type: "req" as const,
      id: "test-req",
      method: "exec.approval.resolve",
    },
    isWebchatConnect: () => false,
  });

  return { respond, mgr };
}

describe("exec.approval.resolve – self-approval prevention", () => {
  it("rejects allow-once from the same connection that requested the approval", async () => {
    const { respond, mgr } = await invokeResolve({
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
    expect(mgr.resolve).not.toHaveBeenCalled();
  });

  it("rejects allow-always from the same connection that requested the approval", async () => {
    const { respond, mgr } = await invokeResolve({
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
    expect(mgr.resolve).not.toHaveBeenCalled();
  });

  it("allows self-deny so the requester can cancel their own request", async () => {
    const { respond, mgr } = await invokeResolve({
      decision: "deny",
      requesterConnId: "conn-A",
      approverConnId: "conn-A",
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(mgr.resolve).toHaveBeenCalledWith("appr-1", "deny", "Approver");
  });

  it("allows approval from a different connection", async () => {
    const { respond, mgr } = await invokeResolve({
      decision: "allow-once",
      requesterConnId: "conn-A",
      approverConnId: "conn-B",
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(mgr.resolve).toHaveBeenCalledWith(
      "appr-1",
      "allow-once",
      "Approver",
    );
  });

  it("does not block when the original request has no connId recorded", async () => {
    const { respond, mgr } = await invokeResolve({
      decision: "allow-once",
      requesterConnId: null,
      approverConnId: "conn-X",
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(mgr.resolve).toHaveBeenCalled();
  });

  it("does not block when the approver client has no connId", async () => {
    const { respond, mgr } = await invokeResolve({
      decision: "allow-once",
      requesterConnId: "conn-A",
      approverConnId: undefined,
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(mgr.resolve).toHaveBeenCalled();
  });

  it("does not block when the approver client is null", async () => {
    const mgr = mockManager({ requestedByConnId: "conn-A" });
    const handlers = createExecApprovalHandlers(mgr);
    const respond = vi.fn();

    await handlers["exec.approval.resolve"]({
      params: { id: "appr-1", decision: "allow-once" },
      respond: respond as never,
      client: null,
      context: mockContext(),
      req: {
        type: "req" as const,
        id: "test-req-null-client",
        method: "exec.approval.resolve",
      },
      isWebchatConnect: () => false,
    });

    expect(respond).toHaveBeenCalledWith(true, { ok: true }, undefined);
    expect(mgr.resolve).toHaveBeenCalled();
  });
});
