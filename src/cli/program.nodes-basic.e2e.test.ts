import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createIosNodeListResponse } from "./program.nodes-test-helpers.js";
import { callGateway, installBaseProgramMocks, runtime } from "./program.test-mocks.js";

installBaseProgramMocks();
let registerNodesCli: (program: Command) => void;

function formatRuntimeLogCallArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value == null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
}

describe("cli program (nodes basics)", () => {
  let program: Command;

  beforeAll(async () => {
    ({ registerNodesCli } = await import("./nodes-cli.js"));
    program = new Command();
    program.exitOverride();
    registerNodesCli(program);
  });

  async function runProgram(argv: string[]) {
    runtime.log.mockClear();
    runtime.writeJson.mockClear();
    await program.parseAsync(argv, { from: "user" });
  }

  async function expectRunProgramFailure(argv: string[], expectedError: RegExp) {
    runtime.error.mockClear();
    await expect(program.parseAsync(argv, { from: "user" })).rejects.toThrow(/exit/i);
    expect(runtime.error.mock.calls.some(([msg]) => expectedError.test(String(msg)))).toBe(true);
  }

  function getRuntimeOutput() {
    return runtime.log.mock.calls.map((c) => formatRuntimeLogCallArg(c[0])).join("\n");
  }

  function mockGatewayWithIosNodeListAnd(method: "node.describe" | "node.invoke", result: unknown) {
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.list") {
        return createIosNodeListResponse();
      }
      if (opts.method === method) {
        return result;
      }
      return { ok: true };
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs nodes list --connected and filters to connected nodes", async () => {
    const now = Date.now();
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
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
    await runProgram(["nodes", "list", "--connected"]);

    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ method: "node.list" }));
    const output = getRuntimeOutput();
    expect(output).toContain("One");
    expect(output).not.toContain("Two");
  });

  it("runs nodes list and includes paired nodes from node.list when node.pair.list is empty", async () => {
    const now = Date.now();
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.pair.list") {
        return {
          pending: [],
          paired: [],
        };
      }
      if (opts.method === "node.list") {
        return {
          ts: now,
          nodes: [
            {
              nodeId: "n1",
              displayName: "One",
              remoteIp: "10.0.0.1",
              paired: true,
              connected: true,
              connectedAtMs: now - 1_000,
            },
          ],
        };
      }
      return { ok: true };
    });

    await runProgram(["nodes", "list"]);

    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ method: "node.pair.list" }));
    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ method: "node.list" }));

    const output = getRuntimeOutput();
    expect(output).toContain("Pending: 0 · Paired: 1");
    expect(output).toContain("One");
  });

  it("runs nodes list and falls back to node.pair.list when node.list is unavailable", async () => {
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.pair.list") {
        return {
          pending: [],
          paired: [
            {
              nodeId: "n1",
              displayName: "One",
              remoteIp: "10.0.0.1",
              lastConnectedAtMs: Date.now() - 1_000,
            },
          ],
        };
      }
      if (opts.method === "node.list") {
        throw new Error("unknown method");
      }
      return { ok: true };
    });

    await runProgram(["nodes", "list"]);

    expect(callGateway).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ method: "node.pair.list" }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: "node.list" }),
    );

    const output = getRuntimeOutput();
    expect(output).toContain("Pending: 0 · Paired: 1");
    expect(output).toContain("One");
  });

  it("runs nodes list and falls back to node.pair.list on invalid request", async () => {
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.pair.list") {
        return {
          pending: [],
          paired: [
            {
              nodeId: "n1",
              displayName: "One",
              remoteIp: "10.0.0.1",
              lastConnectedAtMs: Date.now() - 1_000,
            },
          ],
        };
      }
      if (opts.method === "node.list") {
        throw new Error("invalid request");
      }
      return { ok: true };
    });

    await runProgram(["nodes", "list"]);

    const output = getRuntimeOutput();
    expect(output).toContain("Pending: 0 · Paired: 1");
    expect(output).toContain("One");
  });

  it("runs nodes list and falls back to node.pair.list on missing read scope", async () => {
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.pair.list") {
        return {
          pending: [],
          paired: [
            {
              nodeId: "n1",
              displayName: "One",
              remoteIp: "10.0.0.1",
              lastConnectedAtMs: Date.now() - 1_000,
            },
          ],
        };
      }
      if (opts.method === "node.list") {
        throw new Error("missing scope: operator.read");
      }
      return { ok: true };
    });

    await runProgram(["nodes", "list"]);

    const output = getRuntimeOutput();
    expect(output).toContain("Pending: 0 · Paired: 1");
    expect(output).toContain("One");
  });

  it("fails clearly for nodes list --connected when node.list is unavailable", async () => {
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.pair.list") {
        return {
          pending: [],
          paired: [
            {
              nodeId: "n1",
              displayName: "One",
              remoteIp: "10.0.0.1",
              lastConnectedAtMs: Date.now() - 1_000,
            },
          ],
        };
      }
      if (opts.method === "node.list") {
        throw new Error("unknown method");
      }
      return { ok: true };
    });

    await expectRunProgramFailure(
      ["nodes", "list", "--connected"],
      /node\.list is unavailable .* require live node data/i,
    );
  });

  it("preserves legacy paired metadata in nodes list --json fallback output", async () => {
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
      if (opts.method === "node.pair.list") {
        return {
          pending: [],
          paired: [
            {
              nodeId: "n1",
              token: "tok-1",
              displayName: "One",
              remoteIp: "10.0.0.1",
              approvedAtMs: 123,
              createdAtMs: 122,
            },
          ],
        };
      }
      if (opts.method === "node.list") {
        throw new Error("unknown method");
      }
      return { ok: true };
    });

    await runProgram(["nodes", "list", "--json"]);

    const payload = runtime.writeJson.mock.calls.at(-1)?.[0] as
      | {
          paired: Array<Record<string, unknown>>;
        }
      | undefined;
    expect(payload).toBeDefined();
    const jsonPayload = payload as {
      paired: Array<Record<string, unknown>>;
    };
    expect(jsonPayload.paired).toHaveLength(1);
    expect(jsonPayload.paired[0]?.token).toBe("tok-1");
    expect(jsonPayload.paired[0]?.approvedAtMs).toBe(123);
    expect(jsonPayload.paired[0]?.createdAtMs).toBe(122);
  });

  it("runs nodes status --last-connected and filters by age", async () => {
    const now = Date.now();
    callGateway.mockImplementation(async (...args: unknown[]) => {
      const opts = (args[0] ?? {}) as { method?: string };
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
    await runProgram(["nodes", "status", "--last-connected", "24h"]);

    expect(callGateway).toHaveBeenCalledWith(expect.objectContaining({ method: "node.pair.list" }));
    const output = getRuntimeOutput();
    expect(output).toContain("One");
    expect(output).not.toContain("Two");
  });

  it.each([
    {
      label: "paired node details",
      node: {
        nodeId: "ios-node",
        displayName: "iOS Node",
        remoteIp: "192.168.0.88",
        deviceFamily: "iPad",
        modelIdentifier: "iPad16,6",
        caps: ["canvas", "camera"],
        paired: true,
        connected: true,
      },
      expectedOutput: [
        "Known: 1 · Paired: 1 · Connected: 1",
        "iOS Node",
        "Detail",
        "device: iPad",
        "hw: iPad16,6",
        "Status",
        "paired",
        "Caps",
        "camera",
        "canvas",
      ],
    },
    {
      label: "unpaired node details",
      node: {
        nodeId: "android-node",
        displayName: "Peter's Tab S10 Ultra",
        remoteIp: "192.168.0.99",
        deviceFamily: "Android",
        modelIdentifier: "samsung SM-X926B",
        caps: ["canvas", "camera"],
        paired: false,
        connected: true,
      },
      expectedOutput: [
        "Known: 1 · Paired: 0 · Connected: 1",
        "Peter's Tab",
        "S10 Ultra",
        "Detail",
        "device: Android",
        "hw: samsung",
        "SM-X926B",
        "Status",
        "unpaired",
        "connected",
        "Caps",
        "camera",
        "canvas",
      ],
    },
  ])("runs nodes status and renders $label", async ({ node, expectedOutput }) => {
    callGateway.mockResolvedValue({
      ts: Date.now(),
      nodes: [node],
    });
    await runProgram(["nodes", "status"]);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.list", params: {} }),
    );

    const output = getRuntimeOutput();
    for (const expected of expectedOutput) {
      expect(output).toContain(expected);
    }
  });

  it("runs nodes describe and calls node.describe", async () => {
    mockGatewayWithIosNodeListAnd("node.describe", {
      ts: Date.now(),
      nodeId: "ios-node",
      displayName: "iOS Node",
      caps: ["canvas", "camera"],
      commands: ["canvas.eval", "canvas.snapshot", "camera.snap"],
      connected: true,
    });

    await runProgram(["nodes", "describe", "--node", "ios-node"]);

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "node.list", params: {} }),
    );
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.describe",
        params: { nodeId: "ios-node" },
      }),
    );

    const out = getRuntimeOutput();
    expect(out).toContain("Commands");
    expect(out).toContain("canvas.eval");
  });

  it("runs nodes approve and calls node.pair.approve", async () => {
    callGateway.mockResolvedValue({
      requestId: "r1",
      node: { nodeId: "n1", token: "t1" },
    });
    await expect(runProgram(["nodes", "approve", "r1"])).rejects.toThrow("exit");
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.pair.approve",
        params: { requestId: "r1" },
      }),
    );
  });

  it("runs nodes invoke and calls node.invoke", async () => {
    mockGatewayWithIosNodeListAnd("node.invoke", {
      ok: true,
      nodeId: "ios-node",
      command: "canvas.eval",
      payload: { result: "ok" },
    });

    await expect(
      runProgram([
        "nodes",
        "invoke",
        "--node",
        "ios-node",
        "--command",
        "canvas.eval",
        "--params",
        '{"javaScript":"1+1"}',
      ]),
    ).rejects.toThrow("exit");

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
  });
});
