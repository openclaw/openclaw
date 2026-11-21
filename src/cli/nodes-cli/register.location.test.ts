import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as runtimeModule from "../../runtime.js";
import { defaultRuntime } from "../../runtime.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { registerNodesCli } from "./register.js";
import type { callNodesGatewayCli } from "./rpc.js";

const mocks = vi.hoisted(() => ({
  resolveCliNodeId: vi.fn(async () => "node-1"),
  callNodesGatewayCli: vi.fn<typeof callNodesGatewayCli>(async () => ({ payload: {} })),
}));

vi.mock("./rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rpc.js")>()),
  resolveCliNodeId: mocks.resolveCliNodeId,
  callNodesGatewayCli: mocks.callNodesGatewayCli,
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof runtimeModule>()),
  defaultRuntime: { writeJson: vi.fn(), log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));

async function runNodes(command: string[], ...options: string[]) {
  const program = new Command();
  await registerNodesCli(program, ["node", "openclaw", "nodes", "location"]);
  program.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} });
  return program.parseAsync(["nodes", ...command, "--node", "node-1", ...options], {
    from: "user",
  });
}

describe("nodes camera and location reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["--accuracy", "approximate", "invalid --accuracy (use coarse|balanced|precise)"],
    ["--location-timeout", "", "--location-timeout must be a positive integer"],
    ["--location-timeout", " \t ", "--location-timeout must be a positive integer"],
  ])("rejects invalid %s %j before node lookup", async (option, value, error) => {
    await runNodes(["location", "get"], option, value);
    expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(error));
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(mocks.resolveCliNodeId).not.toHaveBeenCalled();
    expect(mocks.callNodesGatewayCli).not.toHaveBeenCalled();
  });

  it("normalizes and forwards supported accuracy values", async () => {
    await runNodes(["location", "get"], "--accuracy", "PRECISE");
    expect(mocks.callNodesGatewayCli.mock.calls[0]?.[2]).toMatchObject({
      params: { desiredAccuracy: "precise" },
    });
  });

  it.each([
    ["camera", "list"],
    ["location", "get"],
  ])("cancels %s %s quietly", async (...command) => {
    const work = new AsyncWorkScope();
    mocks.callNodesGatewayCli.mockImplementationOnce(async (_method, _opts, _params, callOpts) => {
      work.beginClose();
      callOpts?.signal?.throwIfAborted();
      return { payload: {} };
    });
    await work.run(() => runNodes(command));
    expect(defaultRuntime.log).not.toHaveBeenCalled();
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(defaultRuntime.error).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });
});
