import { beforeEach, describe, expect, it, vi } from "vitest";
import { callGateway, installBaseProgramMocks, runTui, runtime } from "./program.test-mocks.js";

installBaseProgramMocks();

const { buildProgram } = await import("./program.js");

describe("cli program (nodes basics)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTui.mockResolvedValue(undefined);
  });

  it("runs nodes list and calls node.pair.list", async () => {
    callGateway.mockResolvedValue({ pending: [], paired: [] });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "list"], { from: "user" });
    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ method: "node.pair.list" }));
    expect(runtime.log).toHaveBeenCalledWith("Pending: 0 · Paired: 0");
  });

  it("runs nodes list --connected and filters to connected nodes", async () => {
    const now = Date.now();
    callGateway.mockImplementation(async (opts: { method?: string }) => {
      if (opts.method === "node.pair.list") {
        return {
          pending: [],
          paired: [
            {
              nodeId: "n1",
              displayName: "One",
              remoteIp: "10.0.0.1",
              lastConnectedAtMs: now - 1_000,
            },
            {
              nodeId: "n2",
              displayName: "Two",
              remoteIp: "10.0.0.2",
              lastConnectedAtMs: now - 1_000,
            },
          ],
        };
      }
      if (opts.method === "node.list") {
        return {
          nodes: [
            { nodeId: "n1", connected: true },
            { nodeId: "n2", connected: false },
          ],
        };
      }
      return { ok: true };
    });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "list", "--connected"], { from: "user" });

    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ method: "node.list" }));
    const output = runtime.log.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("One");
    expect(output).not.toContain("Two");
  });

  it("runs nodes status --last-connected and filters by age", async () => {
    const now = Date.now();
    callGateway.mockImplementation(async (opts: { method?: string }) => {
      if (opts.method === "node.list") {
        return {
          ts: now,
          nodes: [
            { nodeId: "n1", displayName: "One", connected: false },
            { nodeId: "n2", displayName: "Two", connected: false },
          ],
        };
      }
      if (opts.method === "node.pair.list") {
        return {
          pending: [],
          paired: [
            { nodeId: "n1", lastConnectedAtMs: now - 1_000 },
            { nodeId: "n2", lastConnectedAtMs: now - 2 * 24 * 60 * 60 * 1000 },
          ],
        };
      }
      return { ok: true };
    });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "status", "--last-connected", "24h"], {
      from: "user",
    });

    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ method: "node.pair.list" }));
    const output = runtime.log.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("One");
    expect(output).not.toContain("Two");
  });

  it("runs nodes status and calls node.list", async () => {
    callGateway.mockResolvedValue({
      ts: Date.now(),
      nodes: [
        {
          nodeId: "ios-node",
          displayName: "iOS Node",
          remoteIp: "192.168.0.88",
          deviceFamily: "iPad",
          modelIdentifier: "iPad16,6",
          caps: ["canvas", "camera"],
          paired: true,
          connected: true,
        },
      ],
    });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "status"], { from: "user" });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.list", params: {} }),
    );

    const output = runtime.log.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("Known: 1 · Paired: 1 · Connected: 1");
    expect(output).toContain("iOS Node");
    expect(output).toContain("Detail");
    expect(output).toContain("device: iPad");
    expect(output).toContain("hw: iPad16,6");
    expect(output).toContain("Status");
    expect(output).toContain("paired");
    expect(output).toContain("Caps");
    expect(output).toContain("camera");
    expect(output).toContain("canvas");
  });

  it("runs nodes status and shows unpaired nodes", async () => {
    callGateway.mockResolvedValue({
      ts: Date.now(),
      nodes: [
        {
          nodeId: "android-node",
          displayName: "Peter's Tab S10 Ultra",
          remoteIp: "192.168.0.99",
          deviceFamily: "Android",
          modelIdentifier: "samsung SM-X926B",
          caps: ["canvas", "camera"],
          paired: false,
          connected: true,
        },
      ],
    });
    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "status"], { from: "user" });

    const output = runtime.log.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(output).toContain("Known: 1 · Paired: 0 · Connected: 1");
    expect(output).toContain("Peter's Tab");
    expect(output).toContain("S10 Ultra");
    expect(output).toContain("Detail");
    expect(output).toContain("device: Android");
    expect(output).toContain("hw: samsung");
    expect(output).toContain("SM-X926B");
    expect(output).toContain("Status");
    expect(output).toContain("unpaired");
    expect(output).toContain("connected");
    expect(output).toContain("Caps");
    expect(output).toContain("camera");
    expect(output).toContain("canvas");
  });

  it("runs nodes describe and calls node.describe", async () => {
    callGateway.mockImplementation(async (opts: { method?: string }) => {
      if (opts.method === "node.list") {
        return {
          ts: Date.now(),
          nodes: [
            {
              nodeId: "ios-node",
              displayName: "iOS Node",
              remoteIp: "192.168.0.88",
              connected: true,
            },
          ],
        };
      }
      if (opts.method === "node.describe") {
        return {
          ts: Date.now(),
          nodeId: "ios-node",
          displayName: "iOS Node",
          caps: ["canvas", "camera"],
          commands: ["canvas.eval", "canvas.snapshot", "camera.snap"],
          connected: true,
        };
      }
      return { ok: true };
    });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "describe", "--node", "ios-node"], {
      from: "user",
    });

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.list", params: {} }),
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.describe",
        params: { nodeId: "ios-node" },
      }),
    );

    const out = runtime.log.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(out).toContain("Commands");
    expect(out).toContain("canvas.eval");
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
    callGateway.mockImplementation(async (opts: { method?: string }) => {
      if (opts.method === "node.list") {
        return {
          ts: Date.now(),
          nodes: [
            {
              nodeId: "ios-node",
              displayName: "iOS Node",
              remoteIp: "192.168.0.88",
              connected: true,
            },
          ],
        };
      }
      if (opts.method === "node.invoke") {
        return {
          ok: true,
          nodeId: "ios-node",
          command: "canvas.eval",
          payload: { result: "ok" },
        };
      }
      return { ok: true };
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
        "canvas.eval",
        "--params",
        '{"javaScript":"1+1"}',
      ],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.list", params: {} }),
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.invoke",
        params: {
          nodeId: "ios-node",
          command: "canvas.eval",
          params: { javaScript: "1+1" },
          timeoutMs: 15000,
          idempotencyKey: "idem-test",
        },
      }),
    );
    expect(runtime.log).toHaveBeenCalled();
  });
});
