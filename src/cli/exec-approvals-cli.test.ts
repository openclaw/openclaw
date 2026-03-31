import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as execApprovals from "../infra/exec-approvals.js";
import { registerExecApprovalsCli } from "./exec-approvals-cli.js";

const mocks = vi.hoisted(() => {
  const runtimeErrors: string[] = [];
  const stringifyArgs = (args: unknown[]) => args.map((value) => String(value)).join(" ");
  const defaultRuntime = {
    log: vi.fn(),
    error: vi.fn((...args: unknown[]) => {
      runtimeErrors.push(stringifyArgs(args));
    }),
    writeStdout: vi.fn((value: string) => {
      defaultRuntime.log(value.endsWith("\n") ? value.slice(0, -1) : value);
    }),
    writeJson: vi.fn((value: unknown, space = 2) => {
      defaultRuntime.log(JSON.stringify(value, null, space > 0 ? space : undefined));
    }),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    callGatewayFromCli: vi.fn(async (method: string, _opts: unknown, params?: unknown) => {
      if (method.endsWith(".get")) {
        return {
          path: "/tmp/exec-approvals.json",
          exists: true,
          hash: "hash-1",
          file: { version: 1, agents: {} },
        };
      }
      return { method, params };
    }),
    defaultRuntime,
    runtimeErrors,
  };
});

const { callGatewayFromCli, defaultRuntime, runtimeErrors } = mocks;

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
    mocks.callGatewayFromCli(method, opts, params),
}));

vi.mock("./nodes-cli/rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./nodes-cli/rpc.js")>("./nodes-cli/rpc.js");
  return {
    ...actual,
    resolveNodeId: vi.fn(async () => "node-1"),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
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

describe("exec approvals CLI", () => {
  const createProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerExecApprovalsCli(program);
    return program;
  };

  const runApprovalsCommand = async (args: string[]) => {
    const program = createProgram();
    await program.parseAsync(args, { from: "user" });
  };

  beforeEach(() => {
    resetLocalSnapshot();
    runtimeErrors.length = 0;
    callGatewayFromCli.mockClear();
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
  });

  it("routes get command to local, gateway, and node modes", async () => {
    await runApprovalsCommand(["approvals", "get"]);

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();

    await runApprovalsCommand(["approvals", "get", "--gateway"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith("exec.approvals.get", expect.anything(), {});
    expect(runtimeErrors).toHaveLength(0);
    callGatewayFromCli.mockClear();

    await runApprovalsCommand(["approvals", "get", "--node", "macbook"]);

    expect(callGatewayFromCli).toHaveBeenCalledWith("exec.approvals.node.get", expect.anything(), {
      nodeId: "node-1",
    });
    expect(runtimeErrors).toHaveLength(0);
  });

  it("defaults allowlist add to wildcard agent", async () => {
    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    await runApprovalsCommand(["approvals", "allowlist", "add", "/usr/bin/uname"]);

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
    localSnapshot.file = {
      version: 1,
      agents: {
        "*": {
          allowlist: [{ pattern: "/usr/bin/uname", lastUsedAt: Date.now() }],
        },
      },
    };

    const saveExecApprovals = vi.mocked(execApprovals.saveExecApprovals);
    saveExecApprovals.mockClear();

    await runApprovalsCommand(["approvals", "allowlist", "remove", "/usr/bin/uname"]);

    expect(saveExecApprovals).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 1,
        agents: undefined,
      }),
    );
    expect(runtimeErrors).toHaveLength(0);
  });
});
