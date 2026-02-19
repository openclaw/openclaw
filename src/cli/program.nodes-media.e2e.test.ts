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

function expectParserAcceptsUrlWithoutBase64(
  parse: (payload: Record<string, unknown>) => { url?: string; base64?: string },
  payload: Record<string, unknown>,
  expectedUrl: string,
) {
  const result = parse(payload);
  expect(result.url).toBe(expectedUrl);
  expect(result.base64).toBeUndefined();
}

function expectParserRejectsMissingMedia(
  parse: (payload: Record<string, unknown>) => unknown,
  payload: Record<string, unknown>,
  expectedMessage: string,
) {
  expect(() => parse(payload)).toThrow(expectedMessage);
}

const IOS_NODE = {
  nodeId: "ios-node",
  displayName: "iOS Node",
  remoteIp: "192.168.0.88",
  connected: true,
} as const;

function mockNodeGateway(command?: string, payload?: Record<string, unknown>) {
  callGateway.mockImplementation(async (...args: unknown[]) => {
    const opts = (args[0] ?? {}) as { method?: string };
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
  function createProgramWithCleanRuntimeLog() {
    const program = buildProgram();
    runtime.log.mockClear();
    return program;
  }

  async function runNodesCommand(argv: string[]) {
    const program = createProgramWithCleanRuntimeLog();
    await program.parseAsync(argv, { from: "user" });
  }

  async function runAndExpectUrlPayloadMediaFile(params: {
    command: "camera.snap" | "camera.clip";
    payload: Record<string, unknown>;
    argv: string[];
    expectedPathPattern: RegExp;
  }) {
    mockNodeGateway(params.command, params.payload);
    await runNodesCommand(params.argv);
    await expectLoggedSingleMediaFile({
      expectedPathPattern: params.expectedPathPattern,
      expectedContent: "url-content",
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    runTui.mockResolvedValue(undefined);
  });

  it("runs nodes camera snap and prints two MEDIA paths", async () => {
    mockNodeGateway("camera.snap", { format: "jpg", base64: "aGk=", width: 1, height: 1 });

    await runNodesCommand(["nodes", "camera", "snap", "--node", "ios-node"]);

    const invokeCalls = callGateway.mock.calls
      .map((call) => call[0] as { method?: string; params?: Record<string, unknown> })
      .filter((call) => call.method === "node.invoke");
    const facings = invokeCalls
      .map((call) => (call.params?.params as { facing?: string } | undefined)?.facing)
      .filter((facing): facing is string => Boolean(facing))
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

    await runNodesCommand(["nodes", "camera", "clip", "--node", "ios-node", "--duration", "3000"]);

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

    await runNodesCommand([
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
    ]);

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

    await runNodesCommand([
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
    ]);

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

    await runNodesCommand(["nodes", "camera", "clip", "--node", "ios-node", "--duration", "10s"]);

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

    await runNodesCommand(["nodes", "canvas", "snapshot", "--node", "ios-node", "--format", "png"]);

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

    it.each([
      {
        label: "runs nodes camera snap with url payload",
        command: "camera.snap" as const,
        payload: {
          format: "jpg",
          url: "https://example.com/photo.jpg",
          width: 640,
          height: 480,
        },
        argv: ["nodes", "camera", "snap", "--node", "ios-node", "--facing", "front"],
        expectedPathPattern: /openclaw-camera-snap-front-.*\.jpg$/,
      },
      {
        label: "runs nodes camera clip with url payload",
        command: "camera.clip" as const,
        payload: {
          format: "mp4",
          url: "https://example.com/clip.mp4",
          durationMs: 5000,
          hasAudio: true,
        },
        argv: ["nodes", "camera", "clip", "--node", "ios-node", "--duration", "5000"],
        expectedPathPattern: /openclaw-camera-clip-front-.*\.mp4$/,
      },
    ])("$label", async ({ command, payload, argv, expectedPathPattern }) => {
      await runAndExpectUrlPayloadMediaFile({
        command,
        payload,
        argv,
        expectedPathPattern,
      });
    });
  });

  describe("url payload parsers", () => {
    const parserCases = [
      {
        label: "camera snap parser",
        parse: (payload: Record<string, unknown>) => parseCameraSnapPayload(payload),
        validPayload: {
          format: "jpg",
          url: "https://example.com/photo.jpg",
          width: 640,
          height: 480,
        },
        invalidPayload: { format: "jpg", width: 640, height: 480 },
        expectedUrl: "https://example.com/photo.jpg",
        expectedError: "invalid camera.snap payload",
      },
      {
        label: "camera clip parser",
        parse: (payload: Record<string, unknown>) => parseCameraClipPayload(payload),
        validPayload: {
          format: "mp4",
          url: "https://example.com/clip.mp4",
          durationMs: 3000,
          hasAudio: true,
        },
        invalidPayload: { format: "mp4", durationMs: 3000, hasAudio: true },
        expectedUrl: "https://example.com/clip.mp4",
        expectedError: "invalid camera.clip payload",
      },
    ] as const;

    it.each(parserCases)(
      "accepts url without base64: $label",
      ({ parse, validPayload, expectedUrl }) => {
        expectParserAcceptsUrlWithoutBase64(parse, validPayload, expectedUrl);
      },
    );

    it.each(parserCases)(
      "rejects payload with neither base64 nor url: $label",
      ({ parse, invalidPayload, expectedError }) => {
        expectParserRejectsMissingMedia(parse, invalidPayload, expectedError);
      },
    );

    it("snap parser accepts both base64 and url", () => {
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
  });
});
