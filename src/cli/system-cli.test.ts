import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const callGatewayFromCli = vi.fn();

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } =
  createCliRuntimeCapture();

// mock-isolation: Exercise command registration without opening a live Gateway connection.
vi.mock("./gateway-rpc.js", () => ({
  addGatewayClientOptions: (command: Command) => command,
  callGatewayFromCli,
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime,
}));

const { registerSystemCli } = await import("./system-cli.js");

describe("system-cli", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerSystemCli(program);
    await program.parseAsync(args, { from: "user" });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  it("reports a rejected system event instead of claiming it was enqueued", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ ok: false, reason: "unwakeable-session-key" });

    await expect(runCli(["system", "event", "--text", "hello"])).rejects.toThrow("__exit__:1");

    expect(runtimeLogs).toEqual([]);
    expect(runtimeErrors[0]).toContain("unwakeable-session-key");
  });

  it("writes JSON when invalid wake mode fails", async () => {
    await expect(
      runCli(["system", "event", "--text", "hello", "--mode", "later", "--json"]),
    ).rejects.toThrow("__exit__:1");
    const failure = {
      ok: false,
      error: { type: "cli_error", message: "--mode must be now or next-heartbeat" },
    };
    expect(runtimeLogs).toEqual([JSON.stringify(failure, null, 2)]);
    expect(runtimeErrors).toEqual([]);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("hands agent selection refusals to the CLI failure owner in human mode", async () => {
    const error = new Error("Multiple agents are configured, but this operation has no owner.");
    error.name = "AgentSelectionRequiredError";
    callGatewayFromCli.mockRejectedValueOnce(error);

    await expect(runCli(["system", "event", "--text", "hello"])).rejects.toBe(error);

    expect(runtimeLogs).toEqual([]);
    expect(runtimeErrors).toEqual([]);
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it.each([
    [
      ["event", "--text", "ping", "--session-key", "agent:main:telegram:dm:42"],
      "wake",
      { mode: "next-heartbeat", text: "ping", sessionKey: "agent:main:telegram:dm:42" },
      "ok",
    ],
    [["presence"], "system-presence", undefined, '{\n  "ok": true\n}'],
  ] as const)("routes system %j to gateway", async (args, method, params, output) => {
    await runCli(["system", ...args]);
    expect(callGatewayFromCli.mock.calls[0]?.slice(0, 3)).toEqual([
      method,
      expect.any(Object),
      params,
    ]);
    expect(runtimeLogs).toEqual([output]);
  });
});
