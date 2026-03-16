import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalsFile } from "../infra/exec-approvals.js";
import { buildSystemRunPreparePayload } from "../test-utils/system-run-prepare-payload.js";
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

let lastNodeInvokeCall: NodeInvokeCall | null = null;
let lastApprovalRequestCall: { params?: Record<string, unknown> } | null = null;
let localExecApprovalsFile: ExecApprovalsFile = { version: 1, agents: {} };
let nodeExecApprovalsFile: ExecApprovalsFile = {
  version: 1,
  defaults: {
    security: "allowlist",
    ask: "on-miss",
    askFallback: "deny",
  },
  agents: {},
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
    lastNodeInvokeCall = opts;
    const command = opts.params?.command;
    if (command === "system.run.prepare") {
      const params = (opts.params?.params ?? {}) as {
        command?: unknown[];
        rawCommand?: unknown;
        cwd?: unknown;
        agentId?: unknown;
      };
      return buildSystemRunPreparePayload(params);
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
      file: nodeExecApprovalsFile,
    };
  }
  if (opts.method === "exec.approval.request") {
    lastApprovalRequestCall = opts as { params?: Record<string, unknown> };
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

vi.mock("../infra/exec-approvals.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/exec-approvals.js")>(
    "../infra/exec-approvals.js",
  );
  return {
    ...actual,
    loadExecApprovals: () => localExecApprovalsFile,
  };
});

describe("nodes-cli coverage", () => {
  let registerNodesCli: (program: Command) => void;
  let sharedProgram: Command;

  const getNodeInvokeCall = () => {
    const last = lastNodeInvokeCall;
    if (!last) {
      throw new Error("expected node.invoke call");
    }
    return last;
  };

  const getApprovalRequestCall = () => lastApprovalRequestCall;

  const runNodesCommand = async (args: string[]) => {
    await sharedProgram.parseAsync(args, { from: "user" });
    return getNodeInvokeCall();
  };

  beforeAll(async () => {
    ({ registerNodesCli } = await import("./nodes-cli.js"));
    sharedProgram = new Command();
    sharedProgram.exitOverride();
    registerNodesCli(sharedProgram);
  });

  beforeEach(() => {
    resetRuntimeCapture();
    callGateway.mockClear();
    randomIdempotencyKey.mockClear();
    lastNodeInvokeCall = null;
    lastApprovalRequestCall = null;
    localExecApprovalsFile = { version: 1, agents: {} };
    nodeExecApprovalsFile = {
      version: 1,
      defaults: {
        security: "allowlist",
        ask: "on-miss",
        askFallback: "deny",
      },
      agents: {},
    };
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
      rawCommand: "echo hi",
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
    expect(approval?.params?.["systemRunPlan"]).toEqual({
      argv: ["echo", "hi"],
      cwd: "/tmp",
      commandText: "echo hi",
      commandPreview: null,
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
      rawCommand: '/bin/sh -lc "echo hi"',
      agentId: "main",
      approved: true,
      approvalDecision: "allow-once",
      runId: expect.any(String),
    });
    const approval = getApprovalRequestCall();
    expect(approval?.params?.["systemRunPlan"]).toEqual({
      argv: ["/bin/sh", "-lc", "echo hi"],
      cwd: null,
      commandText: '/bin/sh -lc "echo hi"',
      commandPreview: "echo hi",
      agentId: "main",
      sessionKey: null,
    });
  });

  it("inherits ask=off from local exec approvals when tools.exec.ask is unset", async () => {
    localExecApprovalsFile = {
      version: 1,
      defaults: {
        security: "allowlist",
        ask: "off",
        askFallback: "deny",
      },
      agents: {},
    };
    nodeExecApprovalsFile = {
      version: 1,
      defaults: {
        security: "allowlist",
        askFallback: "deny",
      },
      agents: {},
    };

    const invoke = await runNodesCommand(["nodes", "run", "--node", "mac-1", "echo", "hi"]);

    expect(invoke).toBeTruthy();
    expect(invoke?.params?.command).toBe("system.run");
    expect(invoke?.params?.params).toMatchObject({
      command: ["echo", "hi"],
      approved: false,
    });
    expect(invoke?.params?.params).not.toHaveProperty("approvalDecision");
    expect(getApprovalRequestCall()).toBeNull();
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
