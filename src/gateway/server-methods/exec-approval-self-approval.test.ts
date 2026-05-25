import { beforeEach, describe, expect, it, vi } from "vitest";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createExecApprovalHandlers } from "./exec-approval.js";

describe("exec-approval self-approval prevention (CWE-284)", () => {
  let manager: ExecApprovalManager;
  let handlers: ReturnType<typeof createExecApprovalHandlers>;

  beforeEach(() => {
    manager = new ExecApprovalManager();
    handlers = createExecApprovalHandlers(manager);
  });

  /**
   * Create a pending approval record and register it.
   * Sets requestedByConnId to simulate the requesting connection.
   */
  function createPending(requestConnId: string | null): string {
    const record = manager.create(
      {
        command: "echo test",
        allowedDecisions: ["allow-once", "allow-always", "deny"],
        host: null,
        nodeId: null,
        cwd: null,
        security: null,
        ask: null,
        agentId: null,
        resolvedPath: null,
        sessionKey: null,
        systemRunBinding: null,
        systemRunPlan: undefined,
        turnSourceChannel: null,
        turnSourceTo: null,
        turnSourceAccountId: null,
        turnSourceThreadId: null,
      } as any,
      30_000,
    );
    record.requestedByConnId = requestConnId;
    manager.register(record, 30_000);
    return record.id;
  }

  async function resolve(
    id: string,
    decision: string,
    resolverConnId: string | null | undefined,
  ) {
    const respond = vi.fn();
    await handlers["exec.approval.resolve"]({
      params: { id, decision },
      respond,
      client: resolverConnId != null ? { connId: resolverConnId } : null,
      context: { broadcast: vi.fn() },
    } as any);
    return respond;
  }

  it("rejects allow-once from the same connection that requested", async () => {
    const id = createPending("conn-requester");
    const respond = await resolve(id, "allow-once", "conn-requester");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("requester cannot approve"),
      }),
    );
  });

  it("allows allow-once from a different connection", async () => {
    const id = createPending("conn-requester");
    const respond = await resolve(id, "allow-once", "conn-reviewer");
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
  });

  it("allows self-deny (requester can deny their own request)", async () => {
    const id = createPending("conn-requester");
    const respond = await resolve(id, "deny", "conn-requester");
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
  });

  it("allows resolve when client has no connId (e.g. system/internal)", async () => {
    const id = createPending("conn-requester");
    const respond = await resolve(id, "allow-once", undefined);
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
  });

  it("rejects allow-always from the same connection that requested", async () => {
    const id = createPending("conn-requester");
    const respond = await resolve(id, "allow-always", "conn-requester");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: expect.stringContaining("requester cannot approve"),
      }),
    );
  });
});
