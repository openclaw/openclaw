import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { registerNodesCli } from "./register.js";

// Keep the real read-cancel owner (runNodesReadCommand) under test; the plain
// runNodesCommand wrapper stays a direct runner so interruption is settled by
// the read owner's signal guard rather than the generic error handler.
vi.mock("./cli-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cli-utils.js")>()),
  runNodesCommand: async (_label: string, action: () => Promise<void>) => action(),
}));

const mocks = vi.hoisted(() => ({
  resolveCliNodeId: vi.fn(async () => "node-abc"),
  callNodesGatewayCli: vi.fn<typeof import("./rpc.js").callNodesGatewayCli>(async () => ({
    payload: {},
  })),
}));

vi.mock("./rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rpc.js")>()),
  resolveCliNodeId: mocks.resolveCliNodeId,
  callNodesGatewayCli: mocks.callNodesGatewayCli,
}));

async function runNodes(argv: string[]) {
  const program = new Command();
  await registerNodesCli(program, ["node", "openclaw", "nodes", "camera"]);
  const nodes = program.commands.find((command) => command.name() === "nodes");
  if (!nodes) {
    throw new Error("expected nodes command to be registered");
  }
  return nodes
    .exitOverride()
    .configureOutput({ writeErr: () => {}, writeOut: () => {} })
    .parseAsync(argv, { from: "user" });
}

describe("nodes read commands cancel quietly", () => {
  const output: string[] = [];
  const errors: string[] = [];
  let exitCalls: number[] = [];

  beforeEach(() => {
    output.length = 0;
    errors.length = 0;
    exitCalls = [];
    vi.clearAllMocks();
    vi.spyOn(defaultRuntime, "log").mockImplementation((value) => {
      output.push(String(value));
    });
    vi.spyOn(defaultRuntime, "error").mockImplementation((value) => {
      errors.push(String(value));
    });
    vi.spyOn(defaultRuntime, "writeJson").mockImplementation((value) => {
      output.push(JSON.stringify(value));
    });
    vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
      exitCalls.push(code);
    });
  });

  it.each([
    ["camera list", ["camera", "list", "--node", "test-node"]],
    ["location get", ["location", "get", "--node", "test-node"]],
  ])("keeps an interrupted %s quiet", async (_name, argv) => {
    const work = new AsyncWorkScope();
    // A read interrupted while the Gateway reply is pending settles with no
    // output: the invoke rejects on the aborted signal and the read owner
    // swallows it.
    mocks.callNodesGatewayCli.mockImplementation(async (_m, _o, _p, callOpts) => {
      work.beginClose();
      callOpts?.signal?.throwIfAborted();
      return { payload: {} };
    });
    await work.run(() => runNodes(argv));
    expect(output).toEqual([]);
    expect(errors).toEqual([]);
    expect(exitCalls).toEqual([]);
  });
});
