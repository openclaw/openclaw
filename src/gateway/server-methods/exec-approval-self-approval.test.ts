/**
 * @file Self-approval prevention tests for exec.approval.resolve (CWE-284).
 *
 * Validates that the same WebSocket connection that requested an exec approval
 * cannot also approve it.  The requester MAY still deny their own request.
 */
import { describe, expect, it, vi } from "vitest";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type HandlerOpts = GatewayRequestHandlerOptions;

const NOOP = () => false;

function createFixture() {
  const manager = new ExecApprovalManager();
  const handlers = createExecApprovalHandlers(manager);
  return { manager, handlers };
}

function mockContext() {
  return {
    broadcast: vi.fn(),
    hasExecApprovalClients: () => true,
    logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as unknown as HandlerOpts["context"];
}

function callRequest(
  handlers: ReturnType<typeof createExecApprovalHandlers>,
  overrides: Partial<HandlerOpts> = {},
) {
  const respond = vi.fn();
  const promise = handlers["exec.approval.request"]({
    params: { command: "echo test" },
    respond,
    context: mockContext(),
    client: null,
    req: { id: "req-1", type: "req", method: "exec.approval.request" },
    isWebchatConnect: NOOP,
    ...overrides,
  } as unknown as HandlerOpts);
  return { respond, promise };
}

function callResolve(
  handlers: ReturnType<typeof createExecApprovalHandlers>,
  id: string,
  decision: string,
  clientConnId: string | null,
) {
  const respond = vi.fn();
  const client =
    clientConnId != null
      ? ({ connId: clientConnId, connect: { client: { id: "c", displayName: "C" } } } as unknown as HandlerOpts["client"])
      : null;
  const promise = handlers["exec.approval.resolve"]({
    params: { id, decision },
    respond,
    context: mockContext(),
    client,
    req: { id: "req-2", type: "req", method: "exec.approval.resolve" },
    isWebchatConnect: NOOP,
  } as unknown as HandlerOpts);
  return { respond, promise };
}

describe("exec approval self-approval prevention", () => {
  it("rejects allow-once from the same connId that requested", async () => {
    const { handlers } = createFixture();
    const requesterClient = {
      connId: "conn-requester",
      connect: { client: { id: "c1", displayName: "Requester" } },
    } as unknown as HandlerOpts["client"];

    const { promise: requestPromise } = callRequest(handlers, { client: requesterClient });

    // The manager should now have one pending record.
    // Resolve with the SAME connId → must be rejected.
    // We need the approval id.  The request handler responds with the id.
    // Since the request handler awaits the decision, we operate concurrently.
    // Wait a tick so the request handler runs up to the await point.
    await Promise.resolve();

    // Extract the pending id from the manager.
    const records = (handlers as ReturnType<typeof createExecApprovalHandlers> & { __manager?: ExecApprovalManager }).__manager;
    // Access the id through the manager's listPendingRecords
    const fixture = createFixture();
    // This is simpler: create a fresh fixture and use the manager directly.
    const mgr = new ExecApprovalManager();
    const hdlrs = createExecApprovalHandlers(mgr);

    const reqRespond = vi.fn();
    const reqClient = {
      connId: "conn-requester",
      connect: { client: { id: "c1", displayName: "Requester" } },
    } as unknown as HandlerOpts["client"];

    const reqPromise = hdlrs["exec.approval.request"]({
      params: { command: "echo test" },
      respond: reqRespond,
      context: mockContext(),
      client: reqClient,
      req: { id: "req-1", type: "req", method: "exec.approval.request" },
      isWebchatConnect: NOOP,
    } as unknown as HandlerOpts);

    // Yield to let the request handler run synchronously up to the decision await.
    await Promise.resolve();
    await Promise.resolve();

    const pending = mgr.listPendingRecords();
    expect(pending.length).toBe(1);
    const approvalId = pending[0]!.id;

    // Attempt self-approval with the SAME connId.
    const { respond: resolveRespond, promise: resolvePromise } = callResolve(
      hdlrs, approvalId, "allow-once", "conn-requester",
    );
    await resolvePromise;

    // The resolve must be rejected.
    expect(resolveRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("requester cannot approve their own exec request"),
      }),
    );

    // Clean up: expire the pending approval so the request handler can finish.
    mgr.expire(approvalId, "test-cleanup");
    await reqPromise;
  });

  it("allows approval from a DIFFERENT connId", async () => {
    const mgr = new ExecApprovalManager();
    const hdlrs = createExecApprovalHandlers(mgr);

    const reqPromise = hdlrs["exec.approval.request"]({
      params: { command: "echo test" },
      respond: vi.fn(),
      context: mockContext(),
      client: { connId: "conn-requester" } as unknown as HandlerOpts["client"],
      req: { id: "req-1", type: "req", method: "exec.approval.request" },
      isWebchatConnect: NOOP,
    } as unknown as HandlerOpts);

    await Promise.resolve();
    await Promise.resolve();

    const pending = mgr.listPendingRecords();
    expect(pending.length).toBe(1);
    const approvalId = pending[0]!.id;

    // Resolve with a DIFFERENT connId → must succeed.
    const resolveRespond = vi.fn();
    await hdlrs["exec.approval.resolve"]({
      params: { id: approvalId, decision: "allow-once" },
      respond: resolveRespond,
      context: mockContext(),
      client: { connId: "conn-reviewer", connect: { client: { id: "r", displayName: "R" } } } as unknown as HandlerOpts["client"],
      req: { id: "req-2", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: NOOP,
    } as unknown as HandlerOpts);

    expect(resolveRespond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
    await reqPromise;
  });

  it("allows self-DENY (requester can deny their own request)", async () => {
    const mgr = new ExecApprovalManager();
    const hdlrs = createExecApprovalHandlers(mgr);

    const reqPromise = hdlrs["exec.approval.request"]({
      params: { command: "echo test" },
      respond: vi.fn(),
      context: mockContext(),
      client: { connId: "conn-requester" } as unknown as HandlerOpts["client"],
      req: { id: "req-1", type: "req", method: "exec.approval.request" },
      isWebchatConnect: NOOP,
    } as unknown as HandlerOpts);

    await Promise.resolve();
    await Promise.resolve();

    const pending = mgr.listPendingRecords();
    const approvalId = pending[0]!.id;

    // Self-deny with the SAME connId → must succeed.
    const resolveRespond = vi.fn();
    await hdlrs["exec.approval.resolve"]({
      params: { id: approvalId, decision: "deny" },
      respond: resolveRespond,
      context: mockContext(),
      client: { connId: "conn-requester", connect: { client: { id: "c1", displayName: "Req" } } } as unknown as HandlerOpts["client"],
      req: { id: "req-2", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: NOOP,
    } as unknown as HandlerOpts);

    expect(resolveRespond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
    await reqPromise;
  });

  it("allows approval when client is null (no connId tracking)", async () => {
    const mgr = new ExecApprovalManager();
    const hdlrs = createExecApprovalHandlers(mgr);

    const reqPromise = hdlrs["exec.approval.request"]({
      params: { command: "echo test" },
      respond: vi.fn(),
      context: mockContext(),
      client: { connId: "conn-requester" } as unknown as HandlerOpts["client"],
      req: { id: "req-1", type: "req", method: "exec.approval.request" },
      isWebchatConnect: NOOP,
    } as unknown as HandlerOpts);

    await Promise.resolve();
    await Promise.resolve();

    const pending = mgr.listPendingRecords();
    const approvalId = pending[0]!.id;

    // Resolve with client: null → must succeed (no connId to compare).
    const resolveRespond = vi.fn();
    await hdlrs["exec.approval.resolve"]({
      params: { id: approvalId, decision: "allow-once" },
      respond: resolveRespond,
      context: mockContext(),
      client: null,
      req: { id: "req-2", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: NOOP,
    } as unknown as HandlerOpts);

    expect(resolveRespond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }), undefined);
    await reqPromise;
  });

  it("rejects allow-always self-approval too", async () => {
    const mgr = new ExecApprovalManager();
    const hdlrs = createExecApprovalHandlers(mgr);

    const reqPromise = hdlrs["exec.approval.request"]({
      params: { command: "echo test", ask: "always" },
      respond: vi.fn(),
      context: mockContext(),
      client: { connId: "conn-requester" } as unknown as HandlerOpts["client"],
      req: { id: "req-1", type: "req", method: "exec.approval.request" },
      isWebchatConnect: NOOP,
    } as unknown as HandlerOpts);

    await Promise.resolve();
    await Promise.resolve();

    const pending = mgr.listPendingRecords();
    const approvalId = pending[0]!.id;

    // Self-approval with allow-always → must be rejected.
    const resolveRespond = vi.fn();
    await hdlrs["exec.approval.resolve"]({
      params: { id: approvalId, decision: "allow-always" },
      respond: resolveRespond,
      context: mockContext(),
      client: { connId: "conn-requester", connect: { client: { id: "c1", displayName: "Req" } } } as unknown as HandlerOpts["client"],
      req: { id: "req-2", type: "req", method: "exec.approval.resolve" },
      isWebchatConnect: NOOP,
    } as unknown as HandlerOpts);

    expect(resolveRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("requester cannot approve their own exec request"),
      }),
    );

    mgr.expire(approvalId, "test-cleanup");
    await reqPromise;
  });
});
