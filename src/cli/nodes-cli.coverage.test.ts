import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerNodesCli } from "./nodes-cli.js";
import { callNodesGatewayCli } from "./nodes-cli/rpc.js";

type NodeInvokeCall = {
  method?: string;
  timeoutMs?: number | null;
  params?: {
    idempotencyKey?: string;
    command?: string;
    params?: unknown;
    timeoutMs?: number;
  };
};

let lastNodeInvokeCall: NodeInvokeCall | null = null;

async function gatewayResponse(opts: NodeInvokeCall): Promise<unknown> {
  if (opts.method === "node.list") {
    return { nodes: [{ nodeId: "mac-1" }] };
  }
  if (opts.method === "node.invoke") {
    lastNodeInvokeCall = opts;
    return { payload: { stdout: "", stderr: "", exitCode: 0, success: true, timedOut: false } };
  }
  return { ok: true };
}
const callGateway = vi.fn(gatewayResponse);

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return createCliRuntimeMock(vi);
});

const { runtimeLogs, runtimeErrors, defaultRuntime } = mocks;
const pairingList = (requestId: string) => ({
  pending: [{ requestId, nodeId: "n1", ts: Date.now() }],
  paired: [],
});
const missingRequest = () =>
  Object.assign(new Error("unknown requestId"), {
    name: "GatewayClientRequestError",
    gatewayCode: "INVALID_REQUEST",
  });

vi.mock("../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGateway(opts as NodeInvokeCall),
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.defaultRuntime,
}));

describe("nodes-cli coverage", () => {
  const sharedProgram: Command = new Command();

  const getNodeInvokeCall = () => {
    const last = lastNodeInvokeCall;
    if (!last) {
      throw new Error("expected node.invoke call");
    }
    return last;
  };

  const parseNodes = (args: readonly string[] | string) =>
    sharedProgram.parseAsync(typeof args === "string" ? args.split(" ") : args, {
      from: "user",
    });
  const expectFailure = (args: readonly string[] | string) =>
    expect(parseNodes(args)).rejects.toThrow("__exit__:1");

  const runNodesCommand = async (args: readonly string[] | string) => {
    await parseNodes(args);
    return getNodeInvokeCall();
  };

  function expectPairingError(requestId: string) {
    const output = runtimeErrors.join("\n");
    expect(output).toContain(`Unknown node pairing requestId: ${requestId}`);
    expect(output).toContain("openclaw nodes pending");
    expect(output).not.toContain("GatewayClientRequestError: unknown requestId");
    return output;
  }

  function expectSafeConnectionHint(output: string) {
    expect(output).toContain("Reuse the same connection options when rerunning: --url, --token.");
    expect(output).not.toContain("gateway.example.test");
    expect(output).not.toContain("secret-token");
  }

  beforeAll(async () => {
    sharedProgram.exitOverride();
    await registerNodesCli(sharedProgram, ["node", "openclaw", "nodes", "status"]);
  });

  beforeEach(() => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    vi.clearAllMocks();
    callGateway.mockReset().mockImplementation(gatewayResponse);
    lastNodeInvokeCall = null;
  });

  it("escapes node mutation confirmations without changing request or JSON values", async () => {
    const nodeId = "ios-node\u001b[2J\nnext";
    const name = "Desk\u001b[2J\nrenamed\u0007";
    callGateway.mockImplementation(async (request) =>
      request.method === "node.list"
        ? { nodes: [{ nodeId, displayName: "Desk node" }] }
        : { ok: true, nodeId, displayName: name },
    );

    await parseNodes(["nodes", "rename", "--node", "Desk node", "--name", name]);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.rename", params: { nodeId, displayName: name } }),
    );
    expect(runtimeLogs.join("\n")).toContain("node rename ok: ios-node\\nnext -> Desk\\nrenamed");
    expect(runtimeLogs.join("\n")).not.toContain("\u0007");
    expect(runtimeLogs.join("\n")).not.toContain("\u001b[2J");

    await parseNodes(["nodes", "rename", "--node", "Desk node", "--name", name, "--json"]);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({ ok: true, nodeId, displayName: name });

    await parseNodes(["nodes", "remove", "--node", "Desk node"]);
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.pair.remove", params: { nodeId } }),
    );
    expect(runtimeLogs.join("\n")).toContain("Removed paired node ios-node\\nnext");
    expect(runtimeLogs.join("\n")).not.toContain("\u001b[2J");
  });

  it("escapes node mutation failure diagnostics", async () => {
    callGateway
      .mockResolvedValueOnce({ nodes: [{ nodeId: "ios-node" }] })
      .mockRejectedValueOnce(new Error("unavailable\u001b]2;changed\u0007\rnext"));

    await expectFailure(["nodes", "rename", "--node", "ios-node", "--name", "Desk"]);

    expect(runtimeErrors).toEqual([
      expect.stringContaining("nodes rename failed: unavailable\\rnext"),
    ]);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("shows the registered pending command in node pairing help", () => {
    const nodes = sharedProgram.commands.find((command) => command.name() === "nodes");
    const output: string[] = [];

    expect(nodes).toBeDefined();
    nodes?.configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });
    nodes?.outputHelp();

    expect(output.join("")).toContain("openclaw nodes pending");
    expect(output.join("")).not.toContain("openclaw nodes pairing pending");
  });

  it("explains unknown nodes approve request ids with the current pending requests", async () => {
    callGateway.mockResolvedValueOnce(pairingList("current-request"));

    await expectFailure(
      "nodes approve stale-request --url wss://gateway.example.test --token secret-token",
    );

    const output = expectPairingError("stale-request");
    expect(output).toContain("Pending requestIds: current-request");
    expectSafeConnectionHint(output);
    expect(output).not.toContain("nodes approve failed: Error:");
    expect(callGateway.mock.calls.map(([call]) => call.method)).toEqual(["node.pair.list"]);
  });

  it("explains when a nodes approve request disappears after the preflight", async () => {
    callGateway
      .mockResolvedValueOnce(pairingList("expired-request"))
      .mockRejectedValueOnce(missingRequest());

    await expectFailure(["nodes", "approve", "expired-request"]);

    const output = expectPairingError("expired-request");
    expect(output).not.toContain("No pending node pairing requests are currently visible.");
    expect(output).not.toContain("Pending requestIds:");
    expect(callGateway.mock.calls.map(([call]) => call.method)).toEqual([
      "node.pair.list",
      "node.pair.approve",
    ]);
  });

  it("still approves when the pairing preflight is unavailable", async () => {
    callGateway
      .mockRejectedValueOnce(new Error("pairing list unavailable"))
      .mockResolvedValueOnce({ approved: true });

    await parseNodes("nodes approve request-1");

    expect(callGateway.mock.calls.map(([call]) => call.method)).toEqual([
      "node.pair.list",
      "node.pair.approve",
    ]);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({ approved: true });
  });

  it("explains unknown nodes reject request ids without leaking connection credentials", async () => {
    callGateway.mockRejectedValueOnce(missingRequest());

    await expectFailure(
      "nodes reject stale-request --url wss://gateway.example.test --token secret-token",
    );

    const output = expectPairingError("stale-request");
    expectSafeConnectionHint(output);
    expect(callGateway.mock.calls.map(([call]) => call.method)).toEqual(["node.pair.reject"]);
  });

  it.each([
    [
      "list",
      ["nodes", "list", "--last-connected", "not-a-duration"],
      "Invalid --last-connected: Invalid duration",
    ],
    ["status", ["nodes", "status", "--last-connected", ""], "Invalid --last-connected"],
    [
      "invoke",
      ["nodes", "invoke", "--node", "   ", "--command", "canvas.eval"],
      "--node and --command required",
    ],
    [
      "invoke",
      ["nodes", "invoke", "--node", "mac-1", "--command", "   "],
      "--node and --command required",
    ],
    [
      "invoke",
      ["nodes", "invoke", "--node", "mac-1", "--command", "canvas.eval", "--idempotency-key", ""],
      "--idempotency-key",
    ],
    ["rename", ["nodes", "rename", "--node", "mac-1", "--name", "   "], "--name must not be empty"],
    [
      "push",
      "nodes push --node mac-1 --environment staging".split(" "),
      "invalid --environment (use sandbox|production)",
    ],
    [
      "notify",
      ["nodes", "notify", "--node", "mac-1", "--title", " ", "--body", " "],
      "missing --title or --body",
    ],
    [
      "camera snap",
      "nodes camera snap --node mac-1 --facing side".split(" "),
      "invalid facing: side (expected front|back|both)",
    ],
    [
      "camera clip",
      "nodes camera clip --node mac-1 --facing both".split(" "),
      "invalid facing: both (expected front|back)",
    ],
  ] as const)(
    "reports invalid %s input once before calling the gateway",
    async (command, args, message) => {
      await expect(sharedProgram.parseAsync(args, { from: "user" })).rejects.toThrow("__exit__:1");

      expect(callGateway).not.toHaveBeenCalled();
      expect(runtimeErrors).toEqual([
        expect.stringContaining(`nodes ${command} failed: ${message}`),
      ]);
      expect(defaultRuntime.exit).toHaveBeenCalledTimes(1);
    },
  );

  it("blocks system.run on nodes invoke", async () => {
    await expectFailure("nodes invoke --node mac-1 --command system.run");
    expect(runtimeErrors.at(-1)).toContain('command "system.run" is reserved for shell execution');
  });

  it("rejects malformed nodes invoke params before opening a gateway call", async () => {
    await expectFailure("nodes invoke --node mac-1 --command canvas.eval --params not-json");

    expect(runtimeErrors.at(-1)).toContain("--params must be valid JSON.");
    expect(callGateway).not.toHaveBeenCalled();
    expect(lastNodeInvokeCall).toBeNull();
  });

  it("forwards notification priority with the default system delivery", async () => {
    const invoke = await runNodesCommand(
      "nodes notify --node mac-1 --title Ping --priority timeSensitive",
    );

    expect(invoke.params?.params).toMatchObject({ priority: "timeSensitive", delivery: "system" });
  });

  it("keeps the gateway transport alive beyond a shorter explicit gateway timeout", async () => {
    const invoke = await runNodesCommand(
      "nodes invoke --node mac-1 --command canvas.eval --invoke-timeout 15000 --timeout 5000",
    );
    expect(invoke).toMatchObject({ params: { timeoutMs: 15_000 }, timeoutMs: 25_000 });
    expect(
      callGateway.mock.calls.find(([call]) => call.method === "node.list")?.[0].timeoutMs,
    ).toBe(5_000);
  });

  it("disables the gateway request deadline for an unbounded node invocation", async () => {
    const params = {
      nodeId: "mac-1",
      command: "canvas.eval",
      timeoutMs: 0,
      idempotencyKey: "rk_test",
    };

    await callNodesGatewayCli("node.invoke", { timeout: "10000", json: true }, params);

    expect(getNodeInvokeCall()).toMatchObject({ method: "node.invoke", timeoutMs: null, params });
  });

  it("invokes location.get with params", async () => {
    const invoke = await runNodesCommand(
      "nodes location get --node mac-1 --accuracy precise --max-age 1000 --location-timeout 5000 --invoke-timeout 6000",
    );

    expect(invoke.params).toEqual(
      expect.objectContaining({
        command: "location.get",
        timeoutMs: 6000,
        params: { maxAgeMs: 1000, desiredAccuracy: "precise", timeoutMs: 5000 },
      }),
    );
  });

  it.each([
    ["nodes location get --node mac-1 --invoke-timeout 6s".split(" "), "--invoke-timeout"],
    ["nodes camera snap --node mac-1 --invoke-timeout 20s".split(" "), "--invoke-timeout"],
    ["nodes camera snap --node mac-1 --quality 1.1".split(" "), "--quality"],
    ["nodes camera clip --node mac-1 --invoke-timeout 90s".split(" "), "--invoke-timeout"],
    ["nodes screen record --node mac-1 --invoke-timeout 120s".split(" "), "--invoke-timeout"],
    ["nodes screen record --node mac-1 --fps 10fps".split(" "), "--fps"],
    ["nodes screen record --node mac-1 --fps 0".split(" "), "--fps"],
  ])("rejects invalid numeric option before calling the gateway for %s", async (args, flag) => {
    await expect(sharedProgram.parseAsync(args, { from: "user" })).rejects.toThrow("__exit__:1");
    expect(runtimeErrors.at(-1)).toContain(`${flag} must be`);
    expect(callGateway).not.toHaveBeenCalled();
    expect(lastNodeInvokeCall).toBeNull();
  });
});
