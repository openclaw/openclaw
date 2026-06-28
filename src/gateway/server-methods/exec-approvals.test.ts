import { describe, expect, it, vi } from "vitest";
import type { ExecApprovalsFile } from "../../infra/exec-approvals.js";

const ensureExecApprovalsMock = vi.hoisted(() => vi.fn());
const readExecApprovalsSnapshotMock = vi.hoisted(() => vi.fn());
const saveExecApprovalsMock = vi.hoisted(() => vi.fn());

vi.mock("../../infra/exec-approvals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/exec-approvals.js")>();
  return {
    ...actual,
    ensureExecApprovals: ensureExecApprovalsMock,
    readExecApprovalsSnapshot: readExecApprovalsSnapshotMock,
    saveExecApprovals: saveExecApprovalsMock,
  };
});

const { execApprovalsHandlers } = await import("./exec-approvals.js");

function makeSnapshot(file: ExecApprovalsFile = { version: 1, agents: {} }) {
  return {
    path: "/tmp/exec-approvals.json",
    exists: true,
    raw: JSON.stringify(file),
    file,
    hash: "base-hash",
  };
}

describe("exec approvals gateway methods", () => {
  it("returns a structured unavailable error when local approvals get cannot read state", async () => {
    ensureExecApprovalsMock.mockImplementationOnce(() => {
      throw new Error("permission denied while ensuring approvals");
    });
    const respond = vi.fn();

    await execApprovalsHandlers["exec.approvals.get"]({
      req: { type: "req", id: "req-1", method: "exec.approvals.get", params: {} },
      params: {},
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("permission denied while ensuring approvals"),
      }),
    );
  });

  it("returns a structured unavailable error when local approvals set cannot persist", async () => {
    ensureExecApprovalsMock.mockReturnValue({ version: 1, agents: {} });
    readExecApprovalsSnapshotMock.mockReturnValue(makeSnapshot());
    saveExecApprovalsMock.mockImplementationOnce(() => {
      throw new Error("disk full while saving approvals");
    });
    const respond = vi.fn();

    await execApprovalsHandlers["exec.approvals.set"]({
      req: { type: "req", id: "req-2", method: "exec.approvals.set", params: {} },
      params: { baseHash: "base-hash", file: { version: 1, agents: {} } },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {} as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("disk full while saving approvals"),
      }),
    );
  });

  describe("exec.approvals.node.* capability preflight (issue #97578)", () => {
    function makeNodeContext(params: {
      session?: { commands: string[]; platform?: string } | null;
      invokeResult?: {
        ok: boolean;
        payload?: unknown;
        payloadJSON?: string | null;
        error?: { code?: string; message?: string };
      };
    }) {
      const invoke = vi.fn(
        async () =>
          params.invokeResult ?? {
            ok: true,
            payload: { path: "/x", exists: true, hash: "h", file: { version: 1, agents: {} } },
          },
      );
      const get = vi.fn(() => params.session ?? undefined);
      return {
        ctx: { nodeRegistry: { get, invoke } } as never,
        invoke,
        get,
      };
    }

    it("short-circuits exec.approvals.node.get with INVALID_REQUEST when the node does not declare system.execApprovals.get", async () => {
      const { ctx, invoke, get } = makeNodeContext({
        session: {
          commands: ["system.run", "system.run.prepare", "system.which"],
          platform: "windows",
        },
      });
      const respond = vi.fn();

      await execApprovalsHandlers["exec.approvals.node.get"]({
        req: {
          type: "req",
          id: "req-node-get",
          method: "exec.approvals.node.get",
          params: { nodeId: "win-node-1" },
        },
        params: { nodeId: "win-node-1" },
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: ctx,
      });

      expect(get).toHaveBeenCalledWith("win-node-1");
      expect(invoke).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledTimes(1);
      const [okFlag, payload, error] = respond.mock.calls[0] as [
        boolean,
        unknown,
        { code?: string; message?: string; details?: { reason?: string; command?: string } },
      ];
      expect(okFlag).toBe(false);
      expect(payload).toBeUndefined();
      expect(error).toEqual(
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("system.execApprovals.get"),
          details: expect.objectContaining({
            reason: "command not declared by node",
            command: "system.execApprovals.get",
          }),
        }),
      );
      expect(error.message).toContain("win-node-1");
      expect(error.message).toContain("windows");
    });

    it("short-circuits exec.approvals.node.set with INVALID_REQUEST when the node does not declare system.execApprovals.set", async () => {
      const { ctx, invoke } = makeNodeContext({
        session: { commands: ["system.run", "system.execApprovals.get"], platform: "linux" },
      });
      const respond = vi.fn();

      await execApprovalsHandlers["exec.approvals.node.set"]({
        req: {
          type: "req",
          id: "req-node-set",
          method: "exec.approvals.node.set",
          params: {
            nodeId: "linux-node-1",
            baseHash: "h",
            file: { version: 1, agents: {} },
          },
        },
        params: {
          nodeId: "linux-node-1",
          baseHash: "h",
          file: { version: 1, agents: {} },
        },
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: ctx,
      });

      expect(invoke).not.toHaveBeenCalled();
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "INVALID_REQUEST",
          message: expect.stringContaining("system.execApprovals.set"),
          details: expect.objectContaining({
            reason: "command not declared by node",
            command: "system.execApprovals.set",
          }),
        }),
      );
    });

    it("forwards exec.approvals.node.get to the node when system.execApprovals.get is declared", async () => {
      const payload = {
        path: "/etc/approvals.json",
        exists: true,
        hash: "node-hash",
        file: { version: 1, agents: {} },
      };
      const { ctx, invoke } = makeNodeContext({
        session: {
          commands: ["system.run", "system.execApprovals.get", "system.execApprovals.set"],
          platform: "linux",
        },
        invokeResult: { ok: true, payload, payloadJSON: null },
      });
      const respond = vi.fn();

      await execApprovalsHandlers["exec.approvals.node.get"]({
        req: {
          type: "req",
          id: "req-node-get-ok",
          method: "exec.approvals.node.get",
          params: { nodeId: "linux-node-2" },
        },
        params: { nodeId: "linux-node-2" },
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: ctx,
      });

      expect(invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "linux-node-2",
          command: "system.execApprovals.get",
        }),
      );
      expect(respond).toHaveBeenCalledWith(true, payload, undefined);
    });

    it("falls through to invoke when the node session is not registered (preserves NOT_CONNECTED wake/error mapping)", async () => {
      const { ctx, invoke } = makeNodeContext({
        session: null,
        invokeResult: {
          ok: false,
          payload: undefined,
          payloadJSON: null,
          error: { code: "NOT_CONNECTED", message: "node not connected" },
        },
      });
      const respond = vi.fn();

      await execApprovalsHandlers["exec.approvals.node.get"]({
        req: {
          type: "req",
          id: "req-node-get-disconnected",
          method: "exec.approvals.node.get",
          params: { nodeId: "absent-node-1" },
        },
        params: { nodeId: "absent-node-1" },
        client: null,
        isWebchatConnect: () => false,
        respond,
        context: ctx,
      });

      expect(invoke).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          code: "UNAVAILABLE",
          message: expect.stringContaining("NOT_CONNECTED"),
        }),
      );
    });
  });
});
