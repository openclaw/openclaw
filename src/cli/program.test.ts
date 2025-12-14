import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCommand = vi.fn();
const statusCommand = vi.fn();
const loginWeb = vi.fn();
const startWebChatServer = vi.fn(async () => ({ port: 18788 }));
const callGateway = vi.fn();

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(() => {
    throw new Error("exit");
  }),
};

vi.mock("../commands/send.js", () => ({ sendCommand }));
vi.mock("../commands/status.js", () => ({ statusCommand }));
vi.mock("../runtime.js", () => ({ defaultRuntime: runtime }));
vi.mock("../provider-web.js", () => ({
  loginWeb,
}));
vi.mock("../gateway/call.js", () => ({
  callGateway,
  randomIdempotencyKey: () => "idem-test",
}));
vi.mock("../webchat/server.js", () => ({
  startWebChatServer,
  getWebChatServer: () => null,
}));
vi.mock("./deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

const { buildProgram } = await import("./program.js");

describe("cli program", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs send with required options", async () => {
    const program = buildProgram();
    await program.parseAsync(["send", "--to", "+1", "--message", "hi"], {
      from: "user",
    });
    expect(sendCommand).toHaveBeenCalled();
  });

  it("runs status command", async () => {
    const program = buildProgram();
    await program.parseAsync(["status"], { from: "user" });
    expect(statusCommand).toHaveBeenCalled();
  });

  it("starts webchat server and prints json", async () => {
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["webchat", "--json"], { from: "user" });
    expect(startWebChatServer).toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      JSON.stringify({ port: 18788, basePath: "/", host: "127.0.0.1" }),
    );
  });

  it("runs nodes list and calls node.pair.list", async () => {
    callGateway.mockResolvedValue({ pending: [], paired: [] });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "list"], { from: "user" });
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.pair.list",
      }),
    );
    expect(runtime.log).toHaveBeenCalledWith("Pending: 0 · Paired: 0");
  });

  it("runs nodes approve and calls node.pair.approve", async () => {
    callGateway.mockResolvedValue({
      requestId: "r1",
      node: { nodeId: "n1", token: "t1" },
    });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "approve", "r1"], { from: "user" });
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.pair.approve",
        params: { requestId: "r1" },
      }),
    );
    expect(runtime.log).toHaveBeenCalled();
  });

  it("runs nodes invoke and calls node.invoke", async () => {
    callGateway
      .mockResolvedValueOnce({
        ts: Date.now(),
        nodes: [
          {
            nodeId: "ios-node",
            displayName: "iOS Node",
            remoteIp: "192.168.0.88",
            connected: true,
          },
        ],
      })
      .mockResolvedValueOnce({
        ok: true,
        nodeId: "ios-node",
        command: "screen.eval",
        payload: { result: "ok" },
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      [
        "nodes",
        "invoke",
        "--node",
        "ios-node",
        "--command",
        "screen.eval",
        "--params",
        '{"javaScript":"1+1"}',
      ],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: "node.list", params: {} }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "node.invoke",
        params: {
          nodeId: "ios-node",
          command: "screen.eval",
          params: { javaScript: "1+1" },
          timeoutMs: 15000,
          idempotencyKey: "idem-test",
        },
      }),
    );
    expect(runtime.log).toHaveBeenCalled();
  });
});
