import * as fs from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCameraSnapPayload, parseCameraClipPayload } from "./nodes-camera.js";
import { callGateway, installBaseProgramMocks, runTui, runtime } from "./program.test-mocks.js";

installBaseProgramMocks();

function getFirstRuntimeLogLine(): string {
  const first = runtime.log.mock.calls[0]?.[0];
  if (typeof first !== "string") {
    throw new Error(`Expected runtime.log first arg to be string, got ${typeof first}`);
  }
  return first;
}

async function expectLoggedSingleMediaFile(params?: {
  expectedContent?: string;
  expectedPathPattern?: RegExp;
}): Promise<string> {
  const out = getFirstRuntimeLogLine();
  const mediaPath = out.replace(/^MEDIA:/, "").trim();
  if (params?.expectedPathPattern) {
    expect(mediaPath).toMatch(params.expectedPathPattern);
  }
  try {
    await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe(params?.expectedContent ?? "hi");
  } finally {
    await fs.unlink(mediaPath).catch(() => {});
  }
  return mediaPath;
}

const IOS_NODE = {
  nodeId: "ios-node",
  displayName: "iOS Node",
  remoteIp: "192.168.0.88",
  connected: true,
} as const;

function mockNodeGateway(command?: string, payload?: Record<string, unknown>) {
  callGateway.mockImplementation(async (opts: { method?: string }) => {
    if (opts.method === "node.list") {
      return {
        ts: Date.now(),
        nodes: [IOS_NODE],
      };
    }
    if (opts.method === "node.invoke" && command) {
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
    mockNodeGateway("camera.snap", { format: "jpg", base64: "aGk=", width: 1, height: 1 });

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

    const out = getFirstRuntimeLogLine();
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
    mockNodeGateway("camera.clip", {
      format: "mp4",
      base64: "aGk=",
      durationMs: 3000,
      hasAudio: true,
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

    await expectLoggedSingleMediaFile({
      expectedPathPattern: /openclaw-camera-clip-front-.*\.mp4$/,
    });
  });

  it("runs nodes camera snap with facing front and passes params", async () => {
    mockNodeGateway("camera.snap", { format: "jpg", base64: "aGk=", width: 1, height: 1 });

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

    await expectLoggedSingleMediaFile();
  });

  it("runs nodes camera clip with --no-audio", async () => {
    mockNodeGateway("camera.clip", {
      format: "mp4",
      base64: "aGk=",
      durationMs: 3000,
      hasAudio: false,
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

    await expectLoggedSingleMediaFile();
  });

  it("runs nodes camera clip with human duration (10s)", async () => {
    mockNodeGateway("camera.clip", {
      format: "mp4",
      base64: "aGk=",
      durationMs: 10_000,
      hasAudio: true,
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
    mockNodeGateway("canvas.snapshot", { format: "png", base64: "aGk=" });

    const program = buildProgram();
    runtime.log.mockClear();
    await program.parseAsync(
      ["nodes", "canvas", "snapshot", "--node", "ios-node", "--format", "png"],
      { from: "user" },
    );

    await expectLoggedSingleMediaFile({
      expectedPathPattern: /openclaw-canvas-snapshot-.*\.png$/,
    });
  });

  it("fails nodes camera snap on invalid facing", async () => {
    mockNodeGateway();

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
      mockNodeGateway("camera.snap", {
        format: "jpg",
        url: "https://example.com/photo.jpg",
        width: 640,
        height: 480,
      });

      const program = buildProgram();
      runtime.log.mockClear();
      await program.parseAsync(
        ["nodes", "camera", "snap", "--node", "ios-node", "--facing", "front"],
        { from: "user" },
      );

      await expectLoggedSingleMediaFile({
        expectedPathPattern: /openclaw-camera-snap-front-.*\.jpg$/,
        expectedContent: "url-content",
      });
    });

    it("runs nodes camera clip with url payload", async () => {
      mockNodeGateway("camera.clip", {
        format: "mp4",
        url: "https://example.com/clip.mp4",
        durationMs: 5000,
        hasAudio: true,
      });

      const program = buildProgram();
      runtime.log.mockClear();
      await program.parseAsync(
        ["nodes", "camera", "clip", "--node", "ios-node", "--duration", "5000"],
        { from: "user" },
      );

      await expectLoggedSingleMediaFile({
        expectedPathPattern: /openclaw-camera-clip-front-.*\.mp4$/,
        expectedContent: "url-content",
      });
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
