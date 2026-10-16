import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { registerNodesCameraCommands } from "./register.camera.js";
import { registerNodesScreenCommands } from "./register.screen.js";
import * as rpc from "./rpc.js";

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: { log: vi.fn(), error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
}));

vi.mock("../nodes-camera.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nodes-camera.js")>()),
  writeCameraClipPayloadToFile: vi.fn(async () => "camera.mp4"),
}));

vi.mock("../nodes-screen.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../nodes-screen.js")>()),
  writeScreenRecordToFile: vi.fn(async () => ({ path: "screen.mp4" })),
}));

vi.mock("./rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rpc.js")>()),
  resolveCliNode: vi.fn(async () => ({ nodeId: "node-abc123", platform: "ios" })),
  resolveCliNodeId: vi.fn(async () => "node-abc123"),
  callNodesGatewayCli: vi.fn(async () => ({
    payload: { format: "mp4", base64: "aGk=", durationMs: 10_000, hasAudio: true },
  })),
}));

describe.each([
  { group: "camera", action: "clip", defaultDurationMs: 3000 },
  { group: "screen", action: "record", defaultDurationMs: 10_000 },
])("nodes $group $action duration", ({ group, action, defaultDurationMs }) => {
  beforeEach(() => vi.clearAllMocks());

  async function runCommand(duration?: string) {
    const nodes = new Command("nodes");
    registerNodesCameraCommands(nodes);
    registerNodesScreenCommands(nodes);
    await nodes
      .exitOverride()
      .parseAsync(
        [
          group,
          action,
          "--node",
          "test-node",
          ...(duration === undefined ? [] : ["--duration", duration]),
        ],
        { from: "user" },
      );
  }

  it.each(["0", "0ms", "0s", "0.4ms", "-1", "-1s", "nope", "", "  ", "9007199254740992ms"])(
    "rejects invalid --duration %j before node lookup",
    async (duration) => {
      await runCommand(duration);
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining(
          `nodes ${group} ${action} failed: --duration must be a positive duration (1–9007199254740991ms after rounding; e.g. 500ms, 10s, 1m).`,
        ),
      );
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      expect(rpc.resolveCliNode).not.toHaveBeenCalled();
      expect(rpc.resolveCliNodeId).not.toHaveBeenCalled();
      expect(rpc.callNodesGatewayCli).not.toHaveBeenCalled();
    },
  );

  it.each([
    { duration: undefined, expected: defaultDurationMs },
    { duration: "10s", expected: 10_000 },
    { duration: "5000", expected: 5000 },
    { duration: "1m", expected: 60_000 },
    { duration: "0.5ms", expected: 1 },
    { duration: "1s500ms", expected: 1500 },
  ])("forwards --duration $duration as $expected ms", async ({ duration, expected }) => {
    await runCommand(duration);
    expect(defaultRuntime.error).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(rpc.callNodesGatewayCli).toHaveBeenCalledExactlyOnceWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({
        nodeId: "node-abc123",
        command: `${group}.${action}`,
        params: expect.objectContaining({ durationMs: expected }),
      }),
    );
  });
});
