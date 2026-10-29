import fs from "node:fs/promises";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { defaultRuntime } from "../../runtime.js";
import { writeCameraPayloadToFile } from "../nodes-camera.js";
import { registerNodesCli } from "./register.js";
import * as rpc from "./rpc.js";

const cameraOutput = vi.hoisted(() => ({ root: "" }));

vi.mock("./cli-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cli-utils.js")>()),
  runNodesCommand: async (_label: string, action: () => Promise<void>) => action(),
}));

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
  defaultRuntime: { log: vi.fn(), error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
}));

vi.mock("./rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rpc.js")>()),
  resolveCliNode: vi.fn(async () => ({
    nodeId: "node-abc123",
    platform: "ios",
    remoteIp: "198.51.100.42",
  })),
  resolveCliNodeId: vi.fn(async () => "node-abc123"),
  callNodesGatewayCli: vi.fn(async () => ({
    payload: { format: "jpg", base64: "cmVkYWN0ZWQtYmFzZTY0", width: 1600, height: 1200 },
  })),
}));

async function runCamera(options: string[], action = "snap") {
  const program = new Command();
  await registerNodesCli(program, ["node", "openclaw", "nodes", "camera"]);
  const nodes = program.commands.find((command) => command.name() === "nodes");
  if (!nodes) {
    throw new Error("expected nodes command to be registered");
  }
  return nodes
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} })
    .parseAsync(["camera", action, "--node", "test-node", ...options], { from: "user" });
}

const invokes = () => vi.mocked(rpc.callNodesGatewayCli).mock.calls.map((call) => call[2]);

describe("nodes camera snap CLI option forwarding", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    cameraOutput.root = tempDirs.make("nodes-camera-cli-");
    vi.clearAllMocks();
  });

  it.each(["   "])("rejects blank --facing %j before invoking the node", async (facing) => {
    await expect(runCamera(["--facing", facing])).rejects.toThrow(/invalid facing/i);
    expect(rpc.resolveCliNode).not.toHaveBeenCalled();
    expect(rpc.callNodesGatewayCli).not.toHaveBeenCalled();
  });

  it.each([
    { facing: "both", expected: ["front", "back"] },
    { facing: " FRONT ", expected: ["front"] },
  ])("forwards normalized --facing $facing", async ({ facing, expected }) => {
    await runCamera(["--facing", facing]);
    expect(invokes()).toEqual(
      expected.map((value) =>
        expect.objectContaining({ params: expect.objectContaining({ facing: value }) }),
      ),
    );
  });

  it("makes one facing-less request and forwards deviceId when --facing is omitted", async () => {
    await runCamera(["--device-id", "camera-device"]);
    expect(invokes()).toEqual([
      expect.objectContaining({
        command: "camera.snap",
        nodeId: "node-abc123",
        params: expect.objectContaining({
          deviceId: "camera-device",
          quality: undefined,
          delayMs: undefined,
        }),
      }),
    ]);
    expect(invokes()[0]).not.toHaveProperty("params.facing");
  });

  it("forwards explicit --quality and --delay-ms values in RPC params", async () => {
    await runCamera(["--quality", "0.7", "--delay-ms", "500"]);
    expect(invokes()[0]).toMatchObject({ params: { quality: 0.7, delayMs: 500 } });
  });

  it.each([
    ["malformed image data", "jpg", "not-base64!"],
    ["an unsafe image extension", "../evil", "aGk="],
  ])(
    "does not publish the front camera when the back camera returns %s",
    async (_name, format, base64) => {
      vi.mocked(rpc.callNodesGatewayCli)
        .mockResolvedValueOnce({
          payload: { format: "jpg", base64: "aGk=", width: 1, height: 1 },
        })
        .mockResolvedValueOnce({ payload: { format, base64, width: 1, height: 1 } });
      const actualCamera =
        await vi.importActual<typeof import("../nodes-camera.js")>("../nodes-camera.js");
      const writer = vi.mocked(writeCameraPayloadToFile);
      writer.mockImplementation(actualCamera.writeCameraPayloadToFile);
      const rename = vi.spyOn(fs, "rename");

      try {
        await expect(runCamera(["--facing", "both"])).rejects.toThrow(
          /invalid base64|invalid media format/i,
        );
        expect(rename).not.toHaveBeenCalled();
        expect(writer).not.toHaveBeenCalled();
      } finally {
        rename.mockRestore();
        writer.mockImplementation(async () => {});
      }
    },
  );

  it("does not activate the back camera after the front returns an unsafe extension", async () => {
    vi.mocked(rpc.callNodesGatewayCli).mockResolvedValueOnce({
      payload: { format: "../evil", base64: "aGk=", width: 1, height: 1 },
    });

    await expect(runCamera(["--facing", "both"])).rejects.toThrow(/invalid media format/i);
    expect(rpc.callNodesGatewayCli).toHaveBeenCalledTimes(1);
    expect(writeCameraPayloadToFile).not.toHaveBeenCalled();
  });

  it.each([
    ["--quality", "1.5", "--quality must be at most 1"],
    ["--delay-ms", "-1", "--delay-ms must be a non-negative integer"],
  ])("rejects invalid %s", async (option, value, error) => {
    await expect(runCamera([option, value])).rejects.toThrow(error);
  });

  it("strips node-reported control characters from the camera list table", async () => {
    vi.mocked(rpc.callNodesGatewayCli).mockResolvedValueOnce({
      payload: {
        devices: [
          { name: "front\u0007cam", position: "\u001b[2Jback", id: "dev\u001b]0;x\u0007-1" },
        ],
      },
    });

    await runCamera([], "list");

    const output = vi.mocked(defaultRuntime.log).mock.calls.join("\n");
    expect(output).not.toContain("\u001b");
    expect(output).not.toContain("\u0007");
    expect(output).toMatch(/frontcam\s.*back\s.*dev-1/u);
  });
});
