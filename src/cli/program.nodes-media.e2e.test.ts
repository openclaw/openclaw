import fs from "node:fs/promises";
import type { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as tmpDirOwner from "../infra/tmp-openclaw-dir.js";
import {
  createNodesProgram,
  gatewayRequests,
  mockGateway,
} from "./program.nodes-cli-test-support.js";
import { IOS_NODE, createIosNodeListResponse } from "./program.nodes-test-helpers.js";
import { runtime } from "./program.test-mocks.js";

let nodesCamera: typeof import("./nodes-camera.js");
let registerNodesCli: typeof import("./nodes-cli.js").registerNodesCli;

const camera = { id: "front", name: "Front Camera", position: "front" };
const snapPayload = { format: "jpg", base64: "aGk=", width: 1, height: 1 };
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
  expect((await fs.stat(mediaPath)).isFile()).toBe(true);
  await expect(fs.readFile(mediaPath, "utf8")).resolves.toBe(content);
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
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let program: Command;

  beforeAll(async () => {
    ({ registerNodesCli } = await import("./nodes-cli.js"));
    nodesCamera = await import("./nodes-camera.js");
    program = await createNodesProgram(registerNodesCli);
  });

  async function runNodesCommand(argv: string[]) {
    runtime.log.mockClear();
    await program.parseAsync(argv, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(
      tempDirs.make("nodes-media-cli-"),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it.each([false, true])("lists legacy Windows cameras (JSON: %s)", async (json) => {
    // Response captured in #181348, with a shortened device ID.
    mockNodeGateway("camera.list", {
      cameras: [{ DeviceId: "windows-camera", Name: "EasyCamera", IsDefault: true }],
    });

    await runNodesCommand(cameraArgs("list", ...(json ? ["--json"] : [])));

    if (json) {
      expect(runtime.writeJson).toHaveBeenCalledWith([
        { id: "windows-camera", name: "EasyCamera", IsDefault: true },
      ]);
    } else {
      const output = runtime.log.mock.calls.join("\n");
      expect(output).toContain("EasyCamera");
      expect(output).toContain("windows-camera");
    }
  });

  it("strips node-reported control characters from the camera list table", async () => {
    mockNodeGateway("camera.list", {
      devices: [{ name: "front\u0007cam", position: "\u001b[2Jback", id: "dev\u001b]0;x\u0007-1" }],
    });

    await runNodesCommand(cameraArgs("list"));

    const output = runtime.log.mock.calls.join("\n");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
    expect(output).toMatch(/frontcam\s.*back\s.*dev-1/u);
  });

  it.each([
    ["--facing", "   ", "invalid facing:     (expected front|back|both)"],
    ["--quality", "1.5", "--quality must be at most 1."],
    ["--delay-ms", "-1", "--delay-ms must be a non-negative integer."],
  ])("rejects invalid %s before node lookup", async (option, value, diagnostic) => {
    mockNodeGateway();

    await expect(runNodesCommand(cameraArgs("snap", option, value))).rejects.toThrow(/exit/i);

    expect(runtime.error).toHaveBeenCalledWith("nodes camera snap failed: " + diagnostic);
    expect(gatewayRequests()).toEqual([]);
  });

  it("forwards normalized --facing FRONT", async () => {
    mockNodeGateway("camera.snap", snapPayload);

    await runNodesCommand(cameraArgs("snap", "--facing", " FRONT "));

    expect(nodeInvokeCalls()).toMatchObject([
      { params: { command: "camera.snap" }, commandParams: { facing: "front" } },
    ]);
    await expectMediaFile(getFirstRuntimeLogLine().trim(), /openclaw-camera-snap-front-.*\.jpg$/);
  });

  it("makes one facing-less request and forwards deviceId when --facing is omitted", async () => {
    mockNodeGateway("camera.snap", snapPayload);

    await runNodesCommand(cameraArgs("snap", "--device-id", "camera-device"));

    const invokes = nodeInvokeCalls();
    expect(invokes).toMatchObject([
      {
        params: { nodeId: "ios-node", command: "camera.snap" },
        commandParams: { deviceId: "camera-device", quality: undefined, delayMs: undefined },
      },
    ]);
    expect(invokes[0]?.commandParams).not.toHaveProperty("facing");
    await expectMediaFile(getFirstRuntimeLogLine().trim(), /openclaw-camera-snap-unknown-.*\.jpg$/);
  });

  it("forwards numeric --quality and --delay-ms values", async () => {
    mockNodeGateway("camera.snap", snapPayload);

    await runNodesCommand(cameraArgs("snap", "--quality", "0.7", "--delay-ms", "500"));

    expect(nodeInvokeCalls()).toMatchObject([{ commandParams: { quality: 0.7, delayMs: 500 } }]);
    await expectMediaFile(getFirstRuntimeLogLine().trim());
  });

  it.each([
    ["malformed image data", "jpg", "not-base64!", "writeBase64ToFile: invalid base64 payload"],
    ["an unsafe image extension", "../evil", "aGk=", "invalid media format"],
  ])(
    "does not publish the front camera when the back camera returns %s",
    async (_name, format, base64, diagnostic) => {
      mockGateway((request) => {
        if (request.method === "node.list") {
          return createIosNodeListResponse();
        }
        const params = request.params as { params: { facing: string } };
        return {
          payload:
            params.params.facing === "front" ? snapPayload : { ...snapPayload, format, base64 },
        };
      });
      using writer = vi.spyOn(nodesCamera, "writeCameraPayloadToFile");
      using rename = vi.spyOn(fs, "rename");

      await expect(runNodesCommand(cameraArgs("snap", "--facing", "both"))).rejects.toThrow(
        /exit/i,
      );

      expect(runtime.error).toHaveBeenCalledWith("nodes camera snap failed: " + diagnostic);
      expect(nodeInvokeCalls().map((call) => call.commandParams.facing)).toEqual(["front", "back"]);
      expect(writer).not.toHaveBeenCalled();
      expect(rename).not.toHaveBeenCalled();
    },
  );

  it("does not activate the back camera after the front returns an unsafe extension", async () => {
    mockNodeGateway("camera.snap", { ...snapPayload, format: "../evil" });
    using writer = vi.spyOn(nodesCamera, "writeCameraPayloadToFile");

    await expect(runNodesCommand(cameraArgs("snap", "--facing", "both"))).rejects.toThrow(/exit/i);

    expect(runtime.error).toHaveBeenCalledWith("nodes camera snap failed: invalid media format");
    expect(nodeInvokeCalls().map((call) => call.commandParams.facing)).toEqual(["front"]);
    expect(writer).not.toHaveBeenCalled();
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
    await expect(
      runNodesCommand(cameraArgs("snap", "--facing", "both", "--device-id", "cam-123")),
    ).rejects.toThrow(/exit/i);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringMatching(/facing=both is not allowed when --device-id is set/i),
    );
  });

  it.each(["snap", "clip"] as const)("writes camera %s URL payloads", async (command) => {
    const snap = command === "snap";
    using _ = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response("url-content", { status: 200, headers: { "content-length": "11" } }),
      );

    mockNodeGateway(`camera.${command}`, {
      url: `https://${IOS_NODE.remoteIp}/media`,
      ...(snap
        ? { format: "jpg", width: 640, height: 480 }
        : { format: "mp4", durationMs: 5000, hasAudio: true }),
    });
    await runNodesCommand(
      cameraArgs(command, ...(snap ? ["--facing", "both"] : ["--duration", "5000"])),
    );
    const paths = getFirstRuntimeLogLine().trim().split("\n");
    expect(paths).toHaveLength(snap ? 2 : 1);
    if (snap) {
      const facings = nodeInvokeCalls().map((call) => call.commandParams.facing);
      expect(facings).toEqual(["front", "back"]);
    }
    const pattern = snap
      ? /openclaw-camera-snap-(front|back)-.*\.jpg$/
      : /openclaw-camera-clip-front-.*\.mp4$/;
    await Promise.all(paths.map((file) => expectMediaFile(file, pattern, "url-content")));
  });
});
