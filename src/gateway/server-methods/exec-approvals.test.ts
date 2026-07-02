import { describe, expect, it, vi } from "vitest";
import type { ExecApprovalsFile } from "../../infra/exec-approvals.js";
import type { NodeSession } from "../node-registry.js";

const ensureExecApprovalsMock = vi.hoisted(() => vi.fn());
const readExecApprovalsSnapshotMock = vi.hoisted(() => vi.fn());
const saveExecApprovalsMock = vi.hoisted(() => vi.fn());
const nodeRegistryInvokeMock = vi.hoisted(() => vi.fn());

function makeNodeSession(overrides: Partial<NodeSession> = {}): NodeSession {
  return {
    nodeId: "node-1",
    connId: "conn-1",
    client: {} as never,
    declaredCaps: [],
    caps: [],
    declaredCommands: [],
    commands: [],
    connectedAtMs: 1000,
    ...overrides,
  };
}

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

  it("rejects node exec approvals get when the node lacks the capability", async () => {
    const respond = vi.fn();
    const nodeRegistry = {
      get: vi.fn((_id: string) =>
        makeNodeSession({
          nodeId: "node-no-approvals",
          declaredCommands: ["system.run", "system.which"],
        }),
      ),
      invoke: nodeRegistryInvokeMock,
    };

    await execApprovalsHandlers["exec.approvals.node.get"]({
      req: { type: "req", id: "req-3", method: "exec.approvals.node.get", params: {} },
      params: { nodeId: "node-no-approvals" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { nodeRegistry } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("does not support exec approvals management"),
      }),
    );
    expect(nodeRegistryInvokeMock).not.toHaveBeenCalled();
  });

  it("accepts node exec approvals get when the node advertises the capability", async () => {
    nodeRegistryInvokeMock.mockResolvedValueOnce({
      ok: true,
      payload: { version: 1, agents: {} },
    });
    const respond = vi.fn();
    const nodeRegistry = {
      get: vi.fn((_id: string) =>
        makeNodeSession({
          nodeId: "node-capable",
          declaredCommands: ["system.run", "system.execApprovals.get", "system.execApprovals.set"],
        }),
      ),
      invoke: nodeRegistryInvokeMock,
    };

    await execApprovalsHandlers["exec.approvals.node.get"]({
      req: { type: "req", id: "req-4", method: "exec.approvals.node.get", params: {} },
      params: { nodeId: "node-capable" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { nodeRegistry } as never,
    });

    expect(nodeRegistryInvokeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-capable",
        command: "system.execApprovals.get",
      }),
    );
  });

  it("accepts node exec approvals set when the node advertises the capability", async () => {
    nodeRegistryInvokeMock.mockResolvedValueOnce({
      ok: true,
      payload: { version: 1, agents: {} },
    });
    const respond = vi.fn();
    const nodeRegistry = {
      get: vi.fn((_id: string) =>
        makeNodeSession({
          nodeId: "node-capable",
          declaredCommands: ["system.run", "system.execApprovals.get", "system.execApprovals.set"],
        }),
      ),
      invoke: nodeRegistryInvokeMock,
    };

    await execApprovalsHandlers["exec.approvals.node.set"]({
      req: { type: "req", id: "req-5", method: "exec.approvals.node.set", params: {} },
      params: { nodeId: "node-capable", baseHash: "base-hash", file: { version: 1, agents: {} } },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { nodeRegistry } as never,
    });

    expect(nodeRegistryInvokeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-capable",
        command: "system.execApprovals.set",
      }),
    );
  });

  it("rejects node exec approvals set when the node lacks the capability", async () => {
    const respond = vi.fn();
    const nodeRegistry = {
      get: vi.fn((_id: string) =>
        makeNodeSession({
          nodeId: "node-no-approvals",
          declaredCommands: ["system.run", "system.which"],
        }),
      ),
      invoke: nodeRegistryInvokeMock,
    };

    await execApprovalsHandlers["exec.approvals.node.set"]({
      req: { type: "req", id: "req-6", method: "exec.approvals.node.set", params: {} },
      params: {
        nodeId: "node-no-approvals",
        baseHash: "base-hash",
        file: { version: 1, agents: {} },
      },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { nodeRegistry } as never,
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("does not support exec approvals management"),
      }),
    );
    expect(nodeRegistryInvokeMock).not.toHaveBeenCalled();
  });
});
