import * as fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNodesProgram,
  gatewayRequests,
  mockGateway,
} from "./program.nodes-cli-test-support.js";
import { IOS_NODE, createIosNodeListResponse } from "./program.nodes-test-helpers.js";
import { runtime } from "./program.test-mocks.js";

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

  it.each(["snap", "clip"] as const)("writes camera %s URL payloads", async (command) => {
    const snap = command === "snap";
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        async () =>
          new Response("url-content", { status: 200, headers: { "content-length": "11" } }),
      );
    try {
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
        expect(facings).toHaveLength(2);
        expect(facings).toEqual(expect.arrayContaining(["back", "front"]));
      }
      const pattern = snap
        ? /openclaw-camera-snap-(front|back)-.*\.jpg$/
        : /openclaw-camera-clip-front-.*\.mp4$/;
      await Promise.all(paths.map((file) => expectMediaFile(file, pattern, "url-content")));
    } finally {
      fetch.mockRestore();
    }
  });
});
