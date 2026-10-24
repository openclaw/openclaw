import * as fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNodesProgram,
  gatewayRequests,
  mockGateway,
} from "./program.nodes-cli-test-support.js";
import { IOS_NODE, createIosNodeListResponse } from "./program.nodes-test-helpers.js";
import { programGatewayCallMock, runtime } from "./program.test-mocks.js";

let registerNodesCli: typeof import("./nodes-cli.js").registerNodesCli;

const camera = { id: "front", name: "Front Camera", position: "front" };
const malformedDevices = [null, 7, "invalid", []];
function cameraArgs(command: string, ...extra: string[]) {
  return ["nodes", "camera", command, "--node", "ios-node", ...extra];
}

function getFirstRuntimeLogLine(): string {
  const first = runtime.log.mock.calls[0]?.[0];
  if (typeof first !== "string") {
    throw new Error(`Expected runtime.log first arg to be string, got ${typeof first}`);
  }
  return first;
}

async function expectMediaFile(mediaPath: string, pattern?: RegExp, content = "hi") {
  if (pattern) {
    expect(mediaPath).toMatch(pattern);
  }
  try {
    expect((await fs.stat(mediaPath)).isFile()).toBe(true);
    await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe(content);
  } finally {
    await fs.unlink(mediaPath).catch(() => {});
    // Snap batches publish inside an owned directory; remove it once its last photo is gone.
    const batchDir = path.dirname(mediaPath);
    if (path.basename(batchDir).startsWith(".openclaw-camera-batch-")) {
      await fs.rmdir(batchDir).catch(() => {});
    }
  }
}

function mockNodeGateway(command?: string, payload?: Record<string, unknown>) {
  mockGateway({
    "node.list": createIosNodeListResponse(),
    "node.invoke": command ? { ok: true, nodeId: IOS_NODE.nodeId, command, payload } : { ok: true },
  });
}

function nodeInvokeCalls() {
  return gatewayRequests()
    .filter((call) => call.method === "node.invoke")
    .map((call) => {
      const params = (call.params ?? {}) as Record<string, unknown>;
      const commandParams = (params.params ?? {}) as Record<string, unknown>;
      return { method: call.method, params, commandParams };
    });
}

describe("cli program (nodes media)", () => {
  let program: Command;

  beforeAll(async () => {
    ({ registerNodesCli } = await import("./nodes-cli.js"));
    program = await createNodesProgram(registerNodesCli);
  });

  async function runNodesCommand(argv: string[]) {
    runtime.log.mockClear();
    await program.parseAsync(argv, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([false, true])("filters malformed cameras from output (JSON: %s)", async (json) => {
    mockNodeGateway("camera.list", { devices: [...malformedDevices, camera] });
    await runNodesCommand(cameraArgs("list", ...(json ? ["--json"] : [])));
    if (json) {
      expect(runtime.writeJson).toHaveBeenCalledWith([camera]);
    } else {
      expect(runtime.log.mock.calls.flat().join("\n")).toContain("Front Camera");
      expect(runtime.error).not.toHaveBeenCalled();
    }
  });

  it("reports no cameras when every returned device record is malformed", async () => {
    mockNodeGateway("camera.list", { devices: malformedDevices });

    await runNodesCommand(cameraArgs("list"));

    expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("No cameras reported."));
  });

  it("runs one default snap and two explicitly requested facing snaps", async () => {
    mockNodeGateway("camera.snap", { format: "jpg", base64: "aGk=", width: 1, height: 1 });

    await runNodesCommand(cameraArgs("snap"));

    const defaultInvokeCalls = nodeInvokeCalls();
    expect(defaultInvokeCalls).toHaveLength(1);
    expect(defaultInvokeCalls[0]?.commandParams).not.toHaveProperty("facing");
    await expectMediaFile(getFirstRuntimeLogLine().trim(), /openclaw-camera-snap-unknown-.*\.jpg$/);

    programGatewayCallMock.mockClear();
    await runNodesCommand(cameraArgs("snap", "--facing", "both"));

    const invokeCalls = nodeInvokeCalls();
    const facings = invokeCalls
      .map((call) => call.commandParams.facing)
      .toSorted((a, b) => String(a).localeCompare(String(b)));
    expect(facings).toEqual(["back", "front"]);

    const mediaPaths = getFirstRuntimeLogLine()
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(mediaPaths).toHaveLength(2);
    await Promise.all(
      mediaPaths.map((mediaPath) => expectMediaFile(mediaPath, /openclaw-camera-snap-/)),
    );
  });

  it("runs nodes camera clip with --no-audio", async () => {
    mockNodeGateway("camera.clip", {
      format: "mp4",
      base64: "aGk=",
      durationMs: 3000,
      hasAudio: false,
    });

    await runNodesCommand(
      cameraArgs("clip", "--duration", "3000", "--no-audio", "--device-id", "cam-123"),
    );

    const invoke = nodeInvokeCalls().at(-1);
    expect(invoke).toMatchObject({
      method: "node.invoke",
      params: {
        nodeId: "ios-node",
        command: "camera.clip",
        timeoutMs: 90000,
      },
      commandParams: { includeAudio: false, deviceId: "cam-123" },
    });
    expect(invoke?.params.idempotencyKey).toEqual(
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      ),
    );

    await expectMediaFile(getFirstRuntimeLogLine().trim());
  });

  it("fails nodes camera snap when --facing both and --device-id are combined", async () => {
    mockNodeGateway();
    const parseProgram = await createNodesProgram(registerNodesCli);
    runtime.error.mockClear();
    await expect(
      parseProgram.parseAsync(cameraArgs("snap", "--facing", "both", "--device-id", "cam-123"), {
        from: "user",
      }),
    ).rejects.toThrow(/exit/i);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringMatching(/facing=both is not allowed when --device-id is set/i),
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
            headers: { "content-length": "11" },
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
          url: `https://${IOS_NODE.remoteIp}/photo.jpg`,
          width: 640,
          height: 480,
        },
        argv: cameraArgs("snap", "--facing", "front"),
        expectedPathPattern: /openclaw-camera-snap-front-.*\.jpg$/,
      },
      {
        label: "runs nodes camera clip with url payload",
        command: "camera.clip" as const,
        payload: {
          format: "mp4",
          url: `https://${IOS_NODE.remoteIp}/clip.mp4`,
          durationMs: 5000,
          hasAudio: true,
        },
        argv: cameraArgs("clip", "--duration", "5000"),
        expectedPathPattern: /openclaw-camera-clip-front-.*\.mp4$/,
      },
    ])("$label", async ({ command, payload, argv, expectedPathPattern }) => {
      mockNodeGateway(command, payload);
      await runNodesCommand(argv);
      await expectMediaFile(getFirstRuntimeLogLine().trim(), expectedPathPattern, "url-content");
    });
  });
});
