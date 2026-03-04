import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type GatewayCall = {
  method?: string;
  params?: {
    id?: string;
    command?: string;
    commandArgv?: string[];
    systemRunPlanV2?: unknown;
    host?: string;
    agentId?: string;
    params?: Record<string, unknown>;
  };
};

const nodeListResponse = {
  nodes: [
    {
      nodeId: "mac-1",
      displayName: "Mac",
      platform: "macos",
      caps: [],
      commands: ["system.run"],
      connected: true,
      permissions: { screenRecording: true },
    },
  ],
};

let prepareErrorMessage =
  'node command not allowed: the node (platform: macos) does not support "system.run.prepare"';

const callGateway = vi.fn(async (opts: GatewayCall) => {
  if (opts.method === "node.list") {
    return nodeListResponse;
  }
  if (opts.method === "node.invoke") {
    if (opts.params?.command === "system.run.prepare") {
      throw new Error(prepareErrorMessage);
    }
    return {
      payload: {
        stdout: "",
        stderr: "",
        exitCode: 0,
        success: true,
        timedOut: false,
      },
    };
  }
  if (opts.method === "exec.approvals.node.get") {
    return {
      file: {
        version: 1,
        defaults: {
          security: "allowlist",
          ask: "off",
          askFallback: "deny",
        },
        agents: {},
      },
    };
  }
  if (opts.method === "exec.approval.request") {
    return { decision: "allow-once" };
  }
  return { ok: true };
});

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: GatewayCall) => callGateway(opts),
  randomIdempotencyKey: () => "mock-key",
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(() => ({})),
  };
});

describe("nodes run prepare fallback (#29171)", () => {
  let registerNodesCli: (program: Command) => void;

  beforeAll(async () => {
    ({ registerNodesCli } = await import("../nodes-cli.js"));
  });

  beforeEach(() => {
    callGateway.mockClear();
    prepareErrorMessage =
      'node command not allowed: the node (platform: macos) does not support "system.run.prepare"';
    nodeListResponse.nodes[0] = {
      nodeId: "mac-1",
      displayName: "Mac",
      platform: "macos",
      caps: [],
      commands: ["system.run"],
      connected: true,
      permissions: { screenRecording: true },
    };
  });

  it("falls back to system.run when the node does not advertise system.run.prepare", async () => {
    const program = new Command();
    program.exitOverride();
    registerNodesCli(program);

    await program.parseAsync(["nodes", "run", "--node", "mac-1", "echo", "hi"], {
      from: "user",
    });

    const invokeCommands = callGateway.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.method === "node.invoke")
      .map((entry) => entry.params?.command);

    expect(invokeCommands).toEqual(["system.run"]);
  });

  it("requests approval without systemRunPlanV2 when it falls back to system.run", async () => {
    const program = new Command();
    program.exitOverride();
    registerNodesCli(program);

    await program.parseAsync(
      ["nodes", "run", "--node", "mac-1", "--ask", "on-miss", "echo", "hi"],
      { from: "user" },
    );

    const approvalRequest = callGateway.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.method === "exec.approval.request");

    expect(approvalRequest?.params).toMatchObject({
      command: "echo hi",
      commandArgv: ["echo", "hi"],
      host: "node",
      agentId: "main",
    });
    expect(approvalRequest?.params?.systemRunPlanV2).toBeUndefined();

    const invokeRequest = callGateway.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.method === "node.invoke");

    expect(invokeRequest?.params?.params).toMatchObject({
      command: ["echo", "hi"],
      rawCommand: null,
      agentId: "main",
      approved: true,
      approvalDecision: "allow-once",
      runId: expect.any(String),
    });
  });

  it("falls back when the node omits commands and rejects system.run.prepare anyway", async () => {
    nodeListResponse.nodes[0] = {
      nodeId: "mac-1",
      displayName: "Mac",
      platform: "macos",
      caps: [],
      connected: true,
      permissions: { screenRecording: true },
    } as (typeof nodeListResponse.nodes)[number];

    const program = new Command();
    program.exitOverride();
    registerNodesCli(program);

    await program.parseAsync(["nodes", "run", "--node", "mac-1", "echo", "hi"], {
      from: "user",
    });

    const invokeCommands = callGateway.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.method === "node.invoke")
      .map((entry) => entry.params?.command);

    expect(invokeCommands).toEqual(["system.run.prepare", "system.run"]);
  });

  it("falls back when the node says it did not declare any supported commands", async () => {
    prepareErrorMessage =
      "node command not allowed: the node did not declare any supported commands";
    nodeListResponse.nodes[0] = {
      nodeId: "mac-1",
      displayName: "Mac",
      platform: "macos",
      caps: [],
      connected: true,
      permissions: { screenRecording: true },
    } as (typeof nodeListResponse.nodes)[number];

    const program = new Command();
    program.exitOverride();
    registerNodesCli(program);

    await program.parseAsync(["nodes", "run", "--node", "mac-1", "echo", "hi"], {
      from: "user",
    });

    const invokeCommands = callGateway.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.method === "node.invoke")
      .map((entry) => entry.params?.command);

    expect(invokeCommands).toEqual(["system.run.prepare", "system.run"]);
  });

  it("does not fallback when node advertises neither system.run.prepare nor system.run", async () => {
    nodeListResponse.nodes[0] = {
      nodeId: "mac-1",
      displayName: "Mac",
      platform: "macos",
      caps: [],
      commands: ["system.describe"],
      connected: true,
      permissions: { screenRecording: true },
    };

    const program = new Command();
    program.exitOverride();
    registerNodesCli(program);

    await program.parseAsync(["nodes", "run", "--node", "mac-1", "echo", "hi"], {
      from: "user",
    });

    const invokeCommands = callGateway.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.method === "node.invoke")
      .map((entry) => entry.params?.command);

    expect(invokeCommands).toEqual(["system.run.prepare"]);
  });

  it("falls back when unsupported-command errors mention system.run.prepare", async () => {
    prepareErrorMessage = 'command not supported: "system.run.prepare"';
    nodeListResponse.nodes[0] = {
      nodeId: "mac-1",
      displayName: "Mac",
      platform: "macos",
      caps: [],
      connected: true,
      permissions: { screenRecording: true },
    } as (typeof nodeListResponse.nodes)[number];

    const program = new Command();
    program.exitOverride();
    registerNodesCli(program);

    await program.parseAsync(["nodes", "run", "--node", "mac-1", "echo", "hi"], {
      from: "user",
    });

    const invokeCommands = callGateway.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.method === "node.invoke")
      .map((entry) => entry.params?.command);

    expect(invokeCommands).toEqual(["system.run.prepare", "system.run"]);
  });

  it("does not fallback when generic unsupported-command errors omit the command", async () => {
    prepareErrorMessage = "command not supported";
    nodeListResponse.nodes[0] = {
      nodeId: "mac-1",
      displayName: "Mac",
      platform: "macos",
      caps: [],
      connected: true,
      permissions: { screenRecording: true },
    } as (typeof nodeListResponse.nodes)[number];

    const program = new Command();
    program.exitOverride();
    registerNodesCli(program);

    await program.parseAsync(["nodes", "run", "--node", "mac-1", "echo", "hi"], {
      from: "user",
    });

    const invokeCommands = callGateway.mock.calls
      .map((call) => call[0])
      .filter((entry) => entry.method === "node.invoke")
      .map((entry) => entry.params?.command);

    expect(invokeCommands).toEqual(["system.run.prepare"]);
  });
});
