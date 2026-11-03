import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerNodesCli } from "./register.js";

const mocks = vi.hoisted(() => ({
  resolveCliNodeId: vi.fn(async () => "node-1"),
  callNodesGatewayCli: vi.fn(async () => ({ payload: { lat: 48.2, lon: 16.3 } })),
}));

vi.mock("./cli-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cli-utils.js")>()),
  runNodesCommand: async (_label: string, action: () => Promise<void>) => action(),
}));

vi.mock("./rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rpc.js")>()),
  resolveCliNodeId: mocks.resolveCliNodeId,
  callNodesGatewayCli: mocks.callNodesGatewayCli,
}));

vi.mock("../../gateway/call.js", () => ({
  randomIdempotencyKey: () => "location-test-key",
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    writeJson: vi.fn(),
    log: vi.fn(),
  },
}));

async function getLocation(...options: string[]) {
  const program = new Command();
  await registerNodesCli(program, ["node", "openclaw", "nodes", "location"]);
  program.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
  return program.parseAsync(["nodes", "location", "get", "--node", "node-1", ...options], {
    from: "user",
  });
}

describe("nodes location get validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unsupported accuracy values before resolving or invoking a node", async () => {
    await expect(getLocation("--accuracy", "approximate")).rejects.toThrow(
      "invalid --accuracy (use coarse|balanced|precise)",
    );

    expect(mocks.resolveCliNodeId).not.toHaveBeenCalled();
    expect(mocks.callNodesGatewayCli).not.toHaveBeenCalled();
  });

  it("normalizes and forwards supported accuracy values", async () => {
    await getLocation("--accuracy", "PRECISE");

    expect(mocks.callNodesGatewayCli).toHaveBeenCalledWith(
      "node.invoke",
      expect.anything(),
      expect.objectContaining({
        params: expect.objectContaining({ desiredAccuracy: "precise" }),
      }),
    );
  });

  it.each(["", " \t "])(
    "rejects explicit blank --location-timeout %j before resolving or invoking a node",
    async (locationTimeout) => {
      await expect(getLocation("--location-timeout", locationTimeout)).rejects.toThrow(
        "--location-timeout must be a positive integer",
      );

      expect(mocks.resolveCliNodeId).not.toHaveBeenCalled();
      expect(mocks.callNodesGatewayCli).not.toHaveBeenCalled();
    },
  );
});
