import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

type NodeInvokeCall = {
  method?: string;
  params?: {
    idempotencyKey?: string;
    command?: string;
    params?: unknown;
    timeoutMs?: number;
  };
};

const callGateway = vi.fn(async (opts: NodeInvokeCall) => {
  if (opts.method === "node.list") {
    return {
      nodes: [
        {
          nodeId: "mac-1",
          displayName: "Mac",
          platform: "macos",
          caps: ["canvas"],
          connected: true,
          permissions: { screenRecording: true },
        },
      ],
    };
  }
  if (opts.method === "node.invoke") {
    const command = opts.params?.command;
    if (command === "system.run.prepare") {
      const params = (opts.params?.params ?? {}) as {
        command?: unknown[];
        rawCommand?: unknown;
        cwd?: unknown;
        agentId?: unknown;
      };
      const argv = Array.isArray(params.command)
        ? params.command.map((entry) => String(entry))
        : [];
      const rawCommand =
        typeof params.rawCommand === "string" && params.rawCommand.trim().length > 0
          ? params.rawCommand
          : null;
      return {
        payload: {
          cmdText: rawCommand ?? argv.join(" "),
          plan: {
            version: 2,
            argv,
            cwd: typeof params.cwd === "string" ? params.cwd : null,
            rawCommand,
            agentId: typeof params.agentId === "string" ? params.agentId : null,
            sessionKey: null,
          },
        },
      };
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
      path: "/tmp/exec-approvals.json",
      exists: true,
      hash: "hash",
      file: {
        version: 1,
        defaults: {
          security: "allowlist",
          ask: "on-miss",
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

const randomIdempotencyKey = vi.fn(() => "rk_test");

const { defaultRuntime, resetRuntimeCapture } = createCliRuntimeCapture();

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGateway(opts as NodeInvokeCall),
  randomIdempotencyKey: () => randomIdempotencyKey(),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({}),
}));

describe("nodes-cli coverage", () => {
  let registerNodesCli: (program: Command) => void;

  const getNodeInvokeCall = () => {
    const nodeInvokeCalls = callGateway.mock.calls
      .map((call) => call[0])
      .filter((entry): entry is NodeInvokeCall => entry?.method === "node.invoke");
    const last = nodeInvokeCalls.at(-1);
    if (!last) {
      throw new Error("expected node.invoke call");
    }
    return last;
  };

  const getApprovalRequestCall = () =>
    callGateway.mock.calls.find((call) => call[0]?.method === "exec.approval.request")?.[0] as {
      params?: Record<string, unknown>;
    };

  const createNodesProgram = () => {
    const program = new Command();
    program.exitOverride();
    registerNodesCli(program);
    return program;
  };

  const runNodesCommand = async (args: string[]) => {
    const program = createNodesProgram();
    await program.parseAsync(args, { from: "user" });
    return getNodeInvokeCall();
  };

  beforeAll(async () => {
    ({ registerNodesCli } = await import("./nodes-cli.js"));
  });

  beforeEach(() => {
    resetRuntimeCapture();
    callGateway.mockClear();
    randomIdempotencyKey.mockClear();
  });

  it("invokes system.run with parsed params", async () => {
    const invoke = await runNodesCommand([
      "nodes",
      "run",
      "--node",
      "mac-1",
      "--cwd",
      "/tmp",
      "--env",
      "FOO=bar",
      "--command-timeout",
      "1200",
      "--needs-screen-recording",
      "--invoke-timeout",
      "5000",
      "echo",
      "hi",
    ]);

    expect(invoke).toBeTruthy();
    expect(invoke?.params?.idempotencyKey).toBe("rk_test");
    expect(invoke?.params?.command).toBe("system.run");
    expect(invoke?.params?.params).toEqual({
      command: ["echo", "hi"],
      rawCommand: null,
      cwd: "/tmp",
      env: { FOO: "bar" },
      timeoutMs: 1200,
      needsScreenRecording: true,
      agentId: "main",
      approved: true,
      approvalDecision: "allow-once",
      runId: expect.any(String),
    });
    expect(invoke?.params?.timeoutMs).toBe(5000);
    const approval = getApprovalRequestCall();
    expect(approval?.params?.["commandArgv"]).toEqual(["echo", "hi"]);
    expect(approval?.params?.["systemRunPlanV2"]).toEqual({
      version: 2,
      argv: ["echo", "hi"],
      cwd: "/tmp",
      rawCommand: null,
      agentId: "main",
      sessionKey: null,
    });
  });

  it("invokes system.run with raw command", async () => {
    const invoke = await runNodesCommand([
      "nodes",
      "run",
      "--agent",
      "main",
      "--node",
      "mac-1",
      "--raw",
      "echo hi",
    ]);

    expect(invoke).toBeTruthy();
    expect(invoke?.params?.idempotencyKey).toBe("rk_test");
    expect(invoke?.params?.command).toBe("system.run");
    expect(invoke?.params?.params).toMatchObject({
      command: ["/bin/sh", "-lc", "echo hi"],
      rawCommand: "echo hi",
      agentId: "main",
      approved: true,
      approvalDecision: "allow-once",
      runId: expect.any(String),
    });
    const approval = getApprovalRequestCall();
    expect(approval?.params?.["commandArgv"]).toEqual(["/bin/sh", "-lc", "echo hi"]);
    expect(approval?.params?.["systemRunPlanV2"]).toEqual({
      version: 2,
      argv: ["/bin/sh", "-lc", "echo hi"],
      cwd: null,
      rawCommand: "echo hi",
      agentId: "main",
      sessionKey: null,
    });
  });

  it("invokes system.notify with provided fields", async () => {
    const invoke = await runNodesCommand([
      "nodes",
      "notify",
      "--node",
      "mac-1",
      "--title",
      "Ping",
      "--body",
      "Gateway ready",
      "--delivery",
      "overlay",
    ]);

    expect(invoke).toBeTruthy();
    expect(invoke?.params?.command).toBe("system.notify");
    expect(invoke?.params?.params).toEqual({
      title: "Ping",
      body: "Gateway ready",
      sound: undefined,
      priority: undefined,
      delivery: "overlay",
    });
  });

  it("invokes location.get with params", async () => {
    const invoke = await runNodesCommand([
      "nodes",
      "location",
      "get",
      "--node",
      "mac-1",
      "--accuracy",
      "precise",
      "--max-age",
      "1000",
      "--location-timeout",
      "5000",
      "--invoke-timeout",
      "6000",
    ]);

    expect(invoke).toBeTruthy();
    expect(invoke?.params?.command).toBe("location.get");
    expect(invoke?.params?.params).toEqual({
      maxAgeMs: 1000,
      desiredAccuracy: "precise",
      timeoutMs: 5000,
    });
    expect(invoke?.params?.timeoutMs).toBe(6000);
  });
});
