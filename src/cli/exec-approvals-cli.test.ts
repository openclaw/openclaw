import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const callGatewayFromCli = vi.fn(async (method: string, _opts: unknown, params?: unknown) => {
  if (method.endsWith(".get")) {
    return {
      path: "/tmp/exec-approvals.json",
      exists: true,
      hash: "hash-1",
      file: { version: 1, agents: {} },
    };
  }
  return { method, params };
});

const { runtimeErrors, defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

const localSnapshot = {
  path: "/tmp/local-exec-approvals.json",
  exists: true,
  raw: "{}",
  hash: "hash-local",
  file: { version: 1, agents: {} },
};

function resetLocalSnapshot() {
  localSnapshot.file = { version: 1, agents: {} };
}

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown) =>
    callGatewayFromCli(method, opts, params),
}));

vi.mock("./nodes-cli/rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./nodes-cli/rpc.js")>("./nodes-cli/rpc.js");
  return {
    ...actual,
    resolveNodeId: vi.fn(async () => "node-1"),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../infra/exec-approvals.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  return {
    ...actual,
    readExecApprovalsSnapshot: () => localSnapshot,
    saveExecApprovals: vi.fn(),
  };
});

const { registerExecApprovalsCli } = await import("./exec-approvals-cli.js");
const execApprovals = await import("../infra/exec-approvals.js");

describe("exec approvals CLI", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);
    return program;
  };

  it("routes get command to local, gateway, and node modes", async () => {
    resetLocalSnapshot();
    resetRuntimeCapture();
    callGatewayFromCli.mockClear();

    const localProgram = createProgram();
    await localProgram.parseAsync(["approvals", "get"], { from: "user" });

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();

    const gatewayProgram = createProgram();
    await gatewayProgram.parseAsync(["approvals", "get", "--gateway"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith("exec.approvals.get", expect.anything(), {});
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();

    const nodeProgram = createProgram();
    await nodeProgram.parseAsync(["approvals", "get", "--node", "macbook"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith("exec.approvals.node.get", expect.anything(), {
      nodeId: "node-1",
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("defaults allowlist add to wildcard agent", async () => {
    resetLocalSnapshot();
    resetRuntimeCapture();
    callGatewayFromCli.mockClear();

    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);

    await program.parseAsync(["approvals", "allowlist", "add", "/usr/bin/uname"], { from: "user" });

    expect(callGatewayFromCli).not.toHaveBeenCalledWith(
      "exec.approvals.set",
      expect.anything(),
      {},
    );
    expect(saveExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          "*": expect.anything(),
        }),
      }),
    );
  });

  it("removes wildcard allowlist entry and prunes empty agent", async () => {
    resetLocalSnapshot();
    localSnapshot.file = {
      version: 1,
      agents: {
        "*": {
          allowlist: [{ pattern: "/usr/bin/uname", lastUsedAt: Date.now() }],
        },
      },
    };
    resetRuntimeCapture();
    callGatewayFromCli.mockClear();

    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    const program = createProgram();
    await program.parseAsync(["approvals", "allowlist", "remove", "/usr/bin/uname"], {
      from: "user",
    });

    expect(saveExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        agents: undefined,
      }),
    );
    expect(runtimeErrors).toHaveLength(0);
  });
});
