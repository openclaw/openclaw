import * as fs from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendCommand = vi.fn();
const statusCommand = vi.fn();
const loginWeb = vi.fn();
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

  it("runs nodes camera snap and prints two MEDIA paths", async () => {
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
        command: "camera.snap",
        payload: { format: "jpg", base64: "aGk=", width: 1, height: 1 },
      })
      .mockResolvedValueOnce({
        ok: true,
        nodeId: "ios-node",
        command: "camera.snap",
        payload: { format: "jpg", base64: "aGk=", width: 1, height: 1 },
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      ["nodes", "camera", "snap", "--node", "ios-node"],
      {
        from: "user",
      },
    );

    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          nodeId: "ios-node",
          command: "camera.snap",
          timeoutMs: 20000,
          idempotencyKey: "idem-test",
          params: expect.objectContaining({ facing: "front", format: "jpg" }),
        }),
      }),
    );
    expect(callGateway).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          nodeId: "ios-node",
          command: "camera.snap",
          timeoutMs: 20000,
          idempotencyKey: "idem-test",
          params: expect.objectContaining({ facing: "back", format: "jpg" }),
        }),
      }),
    );

    const out = String(runtime.log.mock.calls[0]?.[0] ?? "");
    const mediaPaths = out
      .split("\n")
      .filter((l) => l.startsWith("MEDIA:"))
      .map((l) => l.replace(/^MEDIA:/, ""))
      .filter(Boolean);
    expect(mediaPaths).toHaveLength(2);

    try {
      for (const p of mediaPaths) {
        await expect(fs.readFile(p, "utf8")).resolves.toBe("hi");
      }
    } finally {
      await Promise.all(mediaPaths.map((p) => fs.unlink(p).catch(() => {})));
    }
  });

  it("runs nodes camera clip and prints one MEDIA path", async () => {
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
        command: "camera.clip",
        payload: {
          format: "mp4",
          base64: "aGk=",
          durationMs: 3000,
          hasAudio: true,
        },
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      ["nodes", "camera", "clip", "--node", "ios-node", "--duration", "3000"],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          nodeId: "ios-node",
          command: "camera.clip",
          timeoutMs: 45000,
          idempotencyKey: "idem-test",
          params: expect.objectContaining({
            facing: "front",
            durationMs: 3000,
            includeAudio: true,
            format: "mp4",
          }),
        }),
      }),
    );

    const out = String(runtime.log.mock.calls[0]?.[0] ?? "");
    const mediaPath = out.replace(/^MEDIA:/, "").trim();
    expect(mediaPath).toMatch(/clawdis-camera-clip-front-.*\.mp4$/);

    try {
      await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe("hi");
    } finally {
      await fs.unlink(mediaPath).catch(() => {});
    }
  });

  it("runs nodes camera snap with facing front and passes params", async () => {
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
        command: "camera.snap",
        payload: { format: "jpg", base64: "aGk=", width: 1, height: 1 },
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      [
        "nodes",
        "camera",
        "snap",
        "--node",
        "ios-node",
        "--facing",
        "front",
        "--max-width",
        "640",
        "--quality",
        "0.8",
      ],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          nodeId: "ios-node",
          command: "camera.snap",
          timeoutMs: 20000,
          idempotencyKey: "idem-test",
          params: expect.objectContaining({
            facing: "front",
            maxWidth: 640,
            quality: 0.8,
          }),
        }),
      }),
    );

    const out = String(runtime.log.mock.calls[0]?.[0] ?? "");
    const mediaPath = out.replace(/^MEDIA:/, "").trim();

    try {
      await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe("hi");
    } finally {
      await fs.unlink(mediaPath).catch(() => {});
    }
  });

  it("runs nodes camera clip with --no-audio", async () => {
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
        command: "camera.clip",
        payload: {
          format: "mp4",
          base64: "aGk=",
          durationMs: 3000,
          hasAudio: false,
        },
      });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      [
        "nodes",
        "camera",
        "clip",
        "--node",
        "ios-node",
        "--duration",
        "3000",
        "--no-audio",
      ],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          nodeId: "ios-node",
          command: "camera.clip",
          timeoutMs: 45000,
          idempotencyKey: "idem-test",
          params: expect.objectContaining({
            includeAudio: false,
          }),
        }),
      }),
    );

    const out = String(runtime.log.mock.calls[0]?.[0] ?? "");
    const mediaPath = out.replace(/^MEDIA:/, "").trim();

    try {
      await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe("hi");
    } finally {
      await fs.unlink(mediaPath).catch(() => {});
    }
  });

  it("fails nodes camera snap on invalid facing", async () => {
    callGateway.mockResolvedValueOnce({
      ts: Date.now(),
      nodes: [
        {
          nodeId: "ios-node",
          displayName: "iOS Node",
          remoteIp: "192.168.0.88",
          connected: true,
        },
      ],
    });

    const program = buildProgram();
    runtime.error.mockClear();

    await expect(
      program.parseAsync(
        ["nodes", "camera", "snap", "--node", "ios-node", "--facing", "nope"],
        { from: "user" },
      ),
    ).rejects.toThrow(/exit/i);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringMatching(/invalid facing/i),
    );
  });
});
