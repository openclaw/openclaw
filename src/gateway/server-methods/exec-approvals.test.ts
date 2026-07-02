import { describe, expect, it, vi } from "vitest";
import type { ExecApprovalsFile } from "../../infra/exec-approvals.js";

const ensureExecApprovalsMock = vi.hoisted(() => vi.fn());
const readExecApprovalsSnapshotMock = vi.hoisted(() => vi.fn());
const saveExecApprovalsMock = vi.hoisted(() => vi.fn());
const resolveNodeCommandAllowlistMock = vi.hoisted(() => vi.fn());
const isNodeCommandAllowedMock = vi.hoisted(() => vi.fn());
const nodeRegistryGetMock = vi.hoisted(() => vi.fn());
vi.mock("../../infra/exec-approvals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/exec-approvals.js")>();
  return {
    ...actual,
    ensureExecApprovals: ensureExecApprovalsMock,
    readExecApprovalsSnapshot: readExecApprovalsSnapshotMock,
    saveExecApprovals: saveExecApprovalsMock,
  };
});

vi.mock("../node-command-policy.js", () => ({
  resolveNodeCommandAllowlist: resolveNodeCommandAllowlistMock,
  isNodeCommandAllowed: isNodeCommandAllowedMock,
}));

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

  it("returns an unavailable error with nodeError details when exec.approvals.node.get targets an unknown node", async () => {
    const nodeRegistryInvokeMock = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: "NOT_CONNECTED", message: "node not connected" },
    });
    nodeRegistryGetMock.mockReturnValue(undefined);
    const respond = vi.fn();

    await execApprovalsHandlers["exec.approvals.node.get"]({
      req: {
        type: "req",
        id: "req-3",
        method: "exec.approvals.node.get",
        params: { nodeId: "missing-node" },
      },
      params: { nodeId: "missing-node" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        nodeRegistry: { get: nodeRegistryGetMock, invoke: nodeRegistryInvokeMock },
      } as never,
    });

    expect(nodeRegistryGetMock).toHaveBeenCalledWith("missing-node");
    expect(nodeRegistryInvokeMock).toHaveBeenCalledWith(
      expect.objectContaining({ nodeId: "missing-node", command: "system.execApprovals.get" }),
    );
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        message: expect.stringContaining("NOT_CONNECTED"),
        details: expect.objectContaining({
          nodeError: expect.objectContaining({ code: "NOT_CONNECTED" }),
        }),
      }),
    );
  });

  it("returns an invalid-request error when the node has not declared system.execApprovals.get", async () => {
    nodeRegistryGetMock.mockReturnValue({
      nodeId: "windows-node",
      declaredCommands: ["system.run", "system.which"],
      commands: ["system.run", "system.which"],
    });
    resolveNodeCommandAllowlistMock.mockReturnValue(new Set(["system.run"]));
    isNodeCommandAllowedMock.mockReturnValue({ ok: false, reason: "command not declared by node" });
    const respond = vi.fn();

    await execApprovalsHandlers["exec.approvals.node.get"]({
      req: {
        type: "req",
        id: "req-4",
        method: "exec.approvals.node.get",
        params: { nodeId: "windows-node" },
      },
      params: { nodeId: "windows-node" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        nodeRegistry: { get: nodeRegistryGetMock },
        getRuntimeConfig: () => ({}),
      } as never,
    });

    expect(nodeRegistryGetMock).toHaveBeenCalledWith("windows-node");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("does not support system.execApprovals.get"),
        details: expect.objectContaining({ reason: "command not declared by node" }),
      }),
    );
  });

  it("returns an invalid-request error when the node has not declared system.execApprovals.set", async () => {
    nodeRegistryGetMock.mockReturnValue({
      nodeId: "windows-node",
      declaredCommands: ["system.run"],
      commands: ["system.run"],
    });
    resolveNodeCommandAllowlistMock.mockReturnValue(new Set(["system.run"]));
    isNodeCommandAllowedMock.mockReturnValue({ ok: false, reason: "command not declared by node" });
    const respond = vi.fn();

    await execApprovalsHandlers["exec.approvals.node.set"]({
      req: {
        type: "req",
        id: "req-5",
        method: "exec.approvals.node.set",
        params: { nodeId: "windows-node", file: { version: 1 }, baseHash: "h" },
      },
      params: { nodeId: "windows-node", file: { version: 1 }, baseHash: "h" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        nodeRegistry: { get: nodeRegistryGetMock },
        getRuntimeConfig: () => ({}),
      } as never,
    });

    expect(nodeRegistryGetMock).toHaveBeenCalledWith("windows-node");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("does not support system.execApprovals.set"),
        details: expect.objectContaining({ reason: "command not declared by node" }),
      }),
    );
  });

  it("blocks exec.approvals.node.get when gateway.nodes.denyCommands includes system.execApprovals.get", async () => {
    nodeRegistryGetMock.mockReturnValue({
      nodeId: "windows-node",
      declaredCommands: ["system.run", "system.execApprovals.get"],
      commands: ["system.run", "system.execApprovals.get"],
    });
    // Simulate denyCommands stripping exec-approvals from the allowlist
    resolveNodeCommandAllowlistMock.mockReturnValue(new Set(["system.run"]));
    isNodeCommandAllowedMock.mockReturnValue({
      ok: false,
      reason: "command not allowlisted",
    });
    const respond = vi.fn();

    await execApprovalsHandlers["exec.approvals.node.get"]({
      req: {
        type: "req",
        id: "req-6",
        method: "exec.approvals.node.get",
        params: { nodeId: "windows-node" },
      },
      params: { nodeId: "windows-node" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        nodeRegistry: { get: nodeRegistryGetMock },
        getRuntimeConfig: () => ({
          gateway: {
            nodes: { denyCommands: ["system.execApprovals.get"] },
          },
        }),
      } as never,
    });

    expect(nodeRegistryGetMock).toHaveBeenCalledWith("windows-node");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("does not allow system.execApprovals.get"),
        details: expect.objectContaining({ reason: "command not allowlisted" }),
      }),
    );
  });

  it("blocks exec.approvals.node.set when gateway.nodes.denyCommands includes system.execApprovals.set", async () => {
    nodeRegistryGetMock.mockReturnValue({
      nodeId: "windows-node",
      declaredCommands: ["system.run", "system.execApprovals.set"],
      commands: ["system.run", "system.execApprovals.set"],
    });
    // Simulate denyCommands stripping exec-approvals from the allowlist
    resolveNodeCommandAllowlistMock.mockReturnValue(new Set(["system.run"]));
    isNodeCommandAllowedMock.mockReturnValue({
      ok: false,
      reason: "command not allowlisted",
    });
    const respond = vi.fn();

    await execApprovalsHandlers["exec.approvals.node.set"]({
      req: {
        type: "req",
        id: "req-7",
        method: "exec.approvals.node.set",
        params: { nodeId: "windows-node", file: { version: 1 }, baseHash: "h" },
      },
      params: { nodeId: "windows-node", file: { version: 1 }, baseHash: "h" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: {
        nodeRegistry: { get: nodeRegistryGetMock },
        getRuntimeConfig: () => ({
          gateway: {
            nodes: { denyCommands: ["system.execApprovals.set"] },
          },
        }),
      } as never,
    });

    expect(nodeRegistryGetMock).toHaveBeenCalledWith("windows-node");
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: expect.stringContaining("does not allow system.execApprovals.set"),
        details: expect.objectContaining({ reason: "command not allowlisted" }),
      }),
    );
  });
});
