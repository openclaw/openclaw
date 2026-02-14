import * as fs from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCameraSnapPayload, parseCameraClipPayload } from "./nodes-camera.js";
import { callGateway, installBaseProgramMocks, runTui, runtime } from "./program.test-mocks.js";

installBaseProgramMocks();

const IOS_NODE = {
  nodeId: "ios-node",
  displayName: "iOS Node",
  remoteIp: "192.168.0.88",
  connected: true,
} as const;

function mockCameraGateway(
  command: "camera.snap" | "camera.clip",
  payload: Record<string, unknown>,
) {
  callGateway.mockImplementation(async (opts: { method?: string }) => {
    if (opts.method === "node.list") {
      return {
        ts: Date.now(),
        nodes: [IOS_NODE],
      };
    }
    if (opts.method === "node.invoke") {
      return {
        ok: true,
        nodeId: IOS_NODE.nodeId,
        command,
        payload,
      };
    }
    return { ok: true };
  });
}

const { buildProgram } = await import("./program.js");

describe("cli program (nodes media)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runTui.mockResolvedValue(undefined);
  });

  it("runs nodes camera snap and prints two MEDIA paths", async () => {
    mockCameraGateway("camera.snap", { format: "jpg", base64: "aGk=", width: 1, height: 1 });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(["nodes", "camera", "snap", "--node", "ios-node"], { from: "user" });

    const invokeCalls = callGateway.mock.calls
      .map((call) => call[0] as { method?: string; params?: Record<string, unknown> })
      .filter((call) => call.method === "node.invoke");
    const facings = invokeCalls
      .map((call) => (call.params?.params as { facing?: string } | undefined)?.facing)
      .filter(Boolean)
      .toSorted((a, b) => a.localeCompare(b));
    expect(facings).toEqual(["back", "front"]);

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
          command: "camera.clip",
          payload: {
            format: "mp4",
            base64: "aGk=",
            durationMs: 3000,
            hasAudio: true,
          },
        };
      }
      return { ok: true };
    });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      ["nodes", "camera", "clip", "--node", "ios-node", "--duration", "3000"],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          nodeId: "ios-node",
          command: "camera.clip",
          timeoutMs: 90000,
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
    expect(mediaPath).toMatch(/openclaw-camera-clip-front-.*\.mp4$/);

    try {
      await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe("hi");
    } finally {
      await fs.unlink(mediaPath).catch(() => {});
    }
  });

  it("runs nodes camera snap with facing front and passes params", async () => {
    mockCameraGateway("camera.snap", { format: "jpg", base64: "aGk=", width: 1, height: 1 });

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
        "--delay-ms",
        "2000",
        "--device-id",
        "cam-123",
      ],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenCalledWith(
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
            delayMs: 2000,
            deviceId: "cam-123",
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
          command: "camera.clip",
          payload: {
            format: "mp4",
            base64: "aGk=",
            durationMs: 3000,
            hasAudio: false,
          },
        };
      }
      return { ok: true };
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
        "--device-id",
        "cam-123",
      ],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          nodeId: "ios-node",
          command: "camera.clip",
          timeoutMs: 90000,
          idempotencyKey: "idem-test",
          params: expect.objectContaining({
            includeAudio: false,
            deviceId: "cam-123",
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

  it("runs nodes camera clip with human duration (10s)", async () => {
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
          command: "camera.clip",
          payload: {
            format: "mp4",
            base64: "aGk=",
            durationMs: 10_000,
            hasAudio: true,
          },
        };
      }
      return { ok: true };
    });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      ["nodes", "camera", "clip", "--node", "ios-node", "--duration", "10s"],
      { from: "user" },
    );

    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "node.invoke",
        params: expect.objectContaining({
          nodeId: "ios-node",
          command: "camera.clip",
          params: expect.objectContaining({ durationMs: 10_000 }),
        }),
      }),
    );
  });

  it("runs nodes canvas snapshot and prints MEDIA path", async () => {
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
          command: "canvas.snapshot",
          payload: { format: "png", base64: "aGk=" },
        };
      }
      return { ok: true };
    });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      ["nodes", "canvas", "snapshot", "--node", "ios-node", "--format", "png"],
      { from: "user" },
    );

    const out = String(runtime.log.mock.calls[0]?.[0] ?? "");
    const mediaPath = out.replace(/^MEDIA:/, "").trim();
    expect(mediaPath).toMatch(/openclaw-canvas-snapshot-.*\.png$/);

    try {
      await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe("hi");
    } finally {
      await fs.unlink(mediaPath).catch(() => {});
    }
  });

  it("fails nodes camera snap on invalid facing", async () => {
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
      return { ok: true };
    });

    const program = buildProgram();
    runtime.error.mockClear();

    await expect(
      program.parseAsync(["nodes", "camera", "snap", "--node", "ios-node", "--facing", "nope"], {
        from: "user",
      }),
    ).rejects.toThrow(/exit/i);

    expect(runtime.error.mock.calls.some(([msg]) => /invalid facing/i.test(String(msg)))).toBe(
      true,
    );
  });

  describe("URL-based payloads", () => {
    let originalFetch: typeof globalThis.fetch;

    beforeAll(() => {
      originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(
        async () =>
          new Response("url-content", {
            status: 200,
            headers: { "content-length": String("11") },
          }),
      ) as unknown as typeof globalThis.fetch;
    });

    afterAll(() => {
      globalThis.fetch = originalFetch;
    });

    it("runs nodes camera snap with url payload", async () => {
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
            command: "camera.snap",
            payload: {
              format: "jpg",
              url: "https://example.com/photo.jpg",
              width: 640,
              height: 480,
            },
          };
        }
        return { ok: true };
      });

      const program = buildProgram();
      runtime.log.mockClear();
      await program.parseAsync(
        ["nodes", "camera", "snap", "--node", "ios-node", "--facing", "front"],
        { from: "user" },
      );

      const out = String(runtime.log.mock.calls[0]?.[0] ?? "");
      const mediaPath = out.replace(/^MEDIA:/, "").trim();
      expect(mediaPath).toMatch(/openclaw-camera-snap-front-.*\.jpg$/);

      try {
        await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe("url-content");
      } finally {
        await fs.unlink(mediaPath).catch(() => {});
      }
    });

    it("runs nodes camera clip with url payload", async () => {
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
            command: "camera.clip",
            payload: {
              format: "mp4",
              url: "https://example.com/clip.mp4",
              durationMs: 5000,
              hasAudio: true,
            },
          };
        }
        return { ok: true };
      });

      const program = buildProgram();
      runtime.log.mockClear();
      await program.parseAsync(
        ["nodes", "camera", "clip", "--node", "ios-node", "--duration", "5000"],
        { from: "user" },
      );

      const out = String(runtime.log.mock.calls[0]?.[0] ?? "");
      const mediaPath = out.replace(/^MEDIA:/, "").trim();
      expect(mediaPath).toMatch(/openclaw-camera-clip-front-.*\.mp4$/);

      try {
        await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe("url-content");
      } finally {
        await fs.unlink(mediaPath).catch(() => {});
      }
    });
  });

  describe("parseCameraSnapPayload with url", () => {
    it("accepts url without base64", () => {
      const result = parseCameraSnapPayload({
        format: "jpg",
        url: "https://example.com/photo.jpg",
        width: 640,
        height: 480,
      });
      expect(result.url).toBe("https://example.com/photo.jpg");
      expect(result.base64).toBeUndefined();
    });

    it("accepts both base64 and url", () => {
      const result = parseCameraSnapPayload({
        format: "jpg",
        base64: "aGk=",
        url: "https://example.com/photo.jpg",
        width: 640,
        height: 480,
      });
      expect(result.base64).toBe("aGk=");
      expect(result.url).toBe("https://example.com/photo.jpg");
    });

    it("rejects payload with neither base64 nor url", () => {
      expect(() => parseCameraSnapPayload({ format: "jpg", width: 640, height: 480 })).toThrow(
        "invalid camera.snap payload",
      );
    });
  });

  describe("parseCameraClipPayload with url", () => {
    it("accepts url without base64", () => {
      const result = parseCameraClipPayload({
        format: "mp4",
        url: "https://example.com/clip.mp4",
        durationMs: 3000,
        hasAudio: true,
      });
      expect(result.url).toBe("https://example.com/clip.mp4");
      expect(result.base64).toBeUndefined();
    });

    it("rejects payload with neither base64 nor url", () => {
      expect(() =>
        parseCameraClipPayload({ format: "mp4", durationMs: 3000, hasAudio: true }),
      ).toThrow("invalid camera.clip payload");
    });
  });
});
