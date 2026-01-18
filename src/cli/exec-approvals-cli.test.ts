import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const callGatewayFromCli = vi.fn(
  async (method: string, _opts: unknown, params?: unknown) => {
    if (method.endsWith(".get")) {
      return {
        path: "/tmp/exec-approvals.json",
        exists: true,
        hash: "hash-1",
        file: { version: 1, agents: {} },
      };
    }
    return { method, params };
  },
);

const runtimeLogs: string[] = [];
const runtimeErrors: string[] = [];
const defaultRuntime = {
  log: (msg: string) => runtimeLogs.push(msg),
  error: (msg: string) => runtimeErrors.push(msg),
  exit: (code: number) => {
    throw new Error(`__exit__:${code}`);
  },
};

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: (method: string, opts: unknown, params?: unknown) =>
    callGatewayFromCli(method, opts, params),
}));

vi.mock("./nodes-cli/rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./nodes-cli/rpc.js")>(
    "./nodes-cli/rpc.js",
  );
  return {
    ...actual,
    resolveNodeId: vi.fn(async () => "node-1"),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

describe("exec approvals CLI", () => {
  it("loads gateway approvals by default", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGatewayFromCli.mockClear();

    const { registerExecApprovalsCli } = await import("./exec-approvals-cli.js");
    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);

    await program.parseAsync(["approvals", "get"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "exec.approvals.get",
      expect.anything(),
      {},
    );
    expect(runtimeErrors).toHaveLength(0);
  });

  it("loads node approvals when --node is set", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    callGatewayFromCli.mockClear();

    const { registerExecApprovalsCli } = await import("./exec-approvals-cli.js");
    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);

    await program.parseAsync(["approvals", "get", "--node", "macbook"], { from: "user" });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "exec.approvals.node.get",
      expect.anything(),
      { nodeId: "node-1" },
    );
    expect(runtimeErrors).toHaveLength(0);
  });
});
