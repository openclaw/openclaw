import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { registerNodesCli } from "./register.js";
import * as rpc from "./rpc.js";

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: { log: vi.fn(), error: vi.fn(), writeJson: vi.fn(), exit: vi.fn() },
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

describe("nodes screen record fps", () => {
  beforeEach(() => vi.clearAllMocks());

  async function runCommand(fps?: string) {
    const program = new Command();
    await registerNodesCli(program, ["node", "openclaw", "nodes", "screen"]);
    await program
      .exitOverride()
      .parseAsync(
        [
          "nodes",
          "screen",
          "record",
          "--node",
          "test-node",
          ...(fps === undefined ? [] : ["--fps", fps]),
        ],
        { from: "user" },
      );
  }

  it.each(["0", "-1", "1e300", "121", "nope"])(
    "rejects invalid --fps %j before node lookup",
    async (fps) => {
      await runCommand(fps);
      expect(defaultRuntime.error).toHaveBeenCalledWith(
        expect.stringMatching(/^nodes screen record failed: --fps must be /),
      );
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      expect(rpc.resolveCliNode).not.toHaveBeenCalled();
      expect(rpc.callNodesGatewayCli).not.toHaveBeenCalled();
    },
  );

  it.each([
    { fps: undefined, expected: 10 },
    { fps: "60", expected: 60 },
    { fps: "0.5", expected: 0.5 },
  ])("forwards --fps $fps as $expected", async ({ fps, expected }) => {
    await runCommand(fps);
    expect(defaultRuntime.error).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
    expect(rpc.callNodesGatewayCli).toHaveBeenCalledExactlyOnceWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({
        nodeId: "node-abc123",
        command: "screen.record",
        params: expect.objectContaining({ fps: expected }),
      }),
    );
  });
});
