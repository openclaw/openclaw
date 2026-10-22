// Node camera command tests cover help text and RPC handling for optional values.
import fs from "node:fs/promises";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../../runtime.js";
import { writeCameraPayloadToFile } from "../nodes-camera.js";
import { registerNodesCli } from "./register.js";
import * as rpc from "./rpc.js";

const capturedInvokeParams: Record<string, unknown>[] = [];
const cameraOutput = vi.hoisted(() => ({ root: "" }));

vi.mock("./cli-utils.js", async () => {
  const actual = await vi.importActual<typeof import("./cli-utils.js")>("./cli-utils.js");
  return {
    ...actual,
    runNodesCommand: async (_label: string, action: () => Promise<void>) => action(),
  };
});

vi.mock("../nodes-camera.js", async () => {
  const actual = await vi.importActual<typeof import("../nodes-camera.js")>("../nodes-camera.js");
  return {
    ...actual,
    // Successful snaps create batch output directories; keep them out of the shared temp root.
    cameraTempPath: (opts: Parameters<typeof actual.cameraTempPath>[0]) =>
      actual.cameraTempPath({ ...opts, tmpDir: cameraOutput.root }),
    writeCameraPayloadToFile: vi.fn(async () => {}),
    writeCameraClipPayloadToFile: vi.fn(async () => {}),
  };
});

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("./rpc.js", async () => {
  const actual = await vi.importActual<typeof import("./rpc.js")>("./rpc.js");
  return {
    ...actual,
    resolveCliNode: vi.fn(async () => ({
      nodeId: "node-abc123",
      platform: "ios",
      remoteIp: "198.51.100.42",
    })),
    resolveCliNodeId: vi.fn(async () => "node-abc123"),
    callNodesGatewayCli: vi.fn(async (_method, _opts, invokeParams) => {
      capturedInvokeParams.push(invokeParams as Record<string, unknown>);
      return {
        payload: {
          format: "jpg",
          base64: "cmVkYWN0ZWQtYmFzZTY0",
          width: 1600,
          height: 1200,
        },
      };
    }),
  };
});

async function buildRootCommand(): Promise<Command> {
  const program = new Command();
  await registerNodesCli(program, ["node", "openclaw", "nodes", "camera"]);
  const nodes = program.commands.find((command) => command.name() === "nodes");
  if (!nodes) {
    throw new Error("expected nodes command to be registered");
  }
  return nodes.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
}

function cameraSnapArgs(extra: string[]): string[] {
  // Commander.parseAsync expects argv[0]/argv[1] to be the node/script names.
  return ["node", "nodes", "camera", "snap", ...extra];
}

describe("nodes camera snap CLI option forwarding", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    cameraOutput.root = tempDirs.make("nodes-camera-cli-");
    capturedInvokeParams.length = 0;
    vi.clearAllMocks();
  });

  it.each(["   "])("rejects blank --facing %j before invoking the node", async (facing) => {
    const nodes = await buildRootCommand();
    await expect(
      nodes.parseAsync(cameraSnapArgs(["--node", "test-node", "--facing", facing])),
    ).rejects.toThrow(/invalid facing/i);
    expect(rpc.resolveCliNode).not.toHaveBeenCalled();
    expect(rpc.callNodesGatewayCli).not.toHaveBeenCalled();
  });

  it.each([
    { facing: "both", expected: ["front", "back"] },
    { facing: " FRONT ", expected: ["front"] },
  ])("forwards normalized --facing $facing", async ({ facing, expected }) => {
    await (
      await buildRootCommand()
    ).parseAsync(cameraSnapArgs(["--node", "test-node", "--facing", facing]));
    expect(capturedInvokeParams.map((invoke) => invoke.params)).toEqual(
      expected.map((value) => expect.objectContaining({ facing: value })),
    );
  });

  it("makes one facing-less request and forwards deviceId when --facing is omitted", async () => {
    const nodes = await buildRootCommand();
    await nodes.parseAsync(cameraSnapArgs(["--node", "test-node", "--device-id", "camera-device"]));

    expect(rpc.callNodesGatewayCli).toHaveBeenCalledTimes(1);
    expect(capturedInvokeParams).toHaveLength(1);
    expect(capturedInvokeParams[0]).toMatchObject({
      command: "camera.snap",
      nodeId: "node-abc123",
    });
    const forwardedParams = capturedInvokeParams[0]?.params as Record<string, unknown>;
    expect(forwardedParams).not.toHaveProperty("facing");
    expect(forwardedParams.deviceId).toBe("camera-device");
    expect(forwardedParams.quality).toBeUndefined();
    expect(forwardedParams.delayMs).toBeUndefined();
  });

  it("forwards explicit --quality and --delay-ms values in RPC params", async () => {
    const nodes = await buildRootCommand();
    await nodes.parseAsync(
      cameraSnapArgs(["--node", "test-node", "--quality", "0.7", "--delay-ms", "500"]),
    );

    const firstInvokeParams = capturedInvokeParams[0];
    if (!firstInvokeParams) {
      throw new Error("expected at least one camera.snap node.invoke call");
    }
    const forwardedParams = firstInvokeParams.params as Record<string, unknown>;
    expect(forwardedParams.quality).toBe(0.7);
    expect(forwardedParams.delayMs).toBe(500);
  });

  it.each([
    {
      name: "malformed image data",
      payload: { format: "jpg", base64: "not-base64!", width: 1, height: 1 },
    },
    {
      name: "an unsafe image extension",
      payload: { format: "../evil", base64: "aGk=", width: 1, height: 1 },
    },
  ])(
    "does not publish the front camera when the back camera returns $name",
    async ({ payload }) => {
      vi.mocked(rpc.callNodesGatewayCli)
        .mockResolvedValueOnce({
          payload: { format: "jpg", base64: "aGk=", width: 1, height: 1 },
        })
        .mockResolvedValueOnce({ payload });
      const actualCamera =
        await vi.importActual<typeof import("../nodes-camera.js")>("../nodes-camera.js");
      const writer = vi.mocked(writeCameraPayloadToFile);
      writer.mockImplementation(actualCamera.writeCameraPayloadToFile);
      const rename = vi.spyOn(fs, "rename");

      try {
        await expect(
          (await buildRootCommand()).parseAsync(
            cameraSnapArgs(["--node", "test-node", "--facing", "both"]),
          ),
        ).rejects.toThrow(/invalid base64|invalid media format/i);
        expect(rename).not.toHaveBeenCalled();
        expect(writer).not.toHaveBeenCalled();
      } finally {
        const publishedPaths = rename.mock.calls.map(([, destination]) => String(destination));
        rename.mockRestore();
        writer.mockImplementation(async () => {});
        await Promise.all(
          publishedPaths.map(async (filePath) => fs.unlink(filePath).catch(() => {})),
        );
      }
    },
  );

  it("does not activate the back camera after the front returns an unsafe extension", async () => {
    vi.mocked(rpc.callNodesGatewayCli).mockResolvedValueOnce({
      payload: { format: "../evil", base64: "aGk=", width: 1, height: 1 },
    });

    await expect(
      (await buildRootCommand()).parseAsync(
        cameraSnapArgs(["--node", "test-node", "--facing", "both"]),
      ),
    ).rejects.toThrow(/invalid media format/i);
    expect(rpc.callNodesGatewayCli).toHaveBeenCalledTimes(1);
    expect(writeCameraPayloadToFile).not.toHaveBeenCalled();
  });

  it("rejects out-of-range --quality", async () => {
    const nodes = await buildRootCommand();
    await expect(
      nodes.parseAsync(cameraSnapArgs(["--node", "test-node", "--quality", "1.5"])),
    ).rejects.toThrow("--quality must be at most 1");
  });

  it("rejects negative --delay-ms", async () => {
    const nodes = await buildRootCommand();
    await expect(
      nodes.parseAsync(cameraSnapArgs(["--node", "test-node", "--delay-ms", "-1"])),
    ).rejects.toThrow("--delay-ms must be a non-negative integer");
  });

  it("strips node-reported control characters from the camera list table", async () => {
    vi.mocked(rpc.callNodesGatewayCli).mockResolvedValueOnce({
      payload: {
        devices: [
          { name: "front\u0007cam", position: "\u001b[2Jback", id: "dev\u001b]0;x\u0007-1" },
        ],
      },
    });

    await (
      await buildRootCommand()
    ).parseAsync(["node", "nodes", "camera", "list", "--node", "test-node"]);

    const output = vi.mocked(defaultRuntime.log).mock.calls.join("\n");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
    expect(output).toMatch(/frontcam\s.*back\s.*dev-1/u);
  });
});
