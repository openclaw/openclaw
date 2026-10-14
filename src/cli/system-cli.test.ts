// System CLI tests cover system command registration and status output.
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const callGatewayFromCli = vi.fn();
const addGatewayClientOptions = vi.fn((command: Command) => command);

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } =
  createCliRuntimeCapture();

vi.mock("./gateway-rpc.js", () => ({
  addGatewayClientOptions,
  callGatewayFromCli,
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime,
  writeRuntimeJson: (runtime: { log: (...args: unknown[]) => void }, value: unknown, space = 2) =>
    runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined)),
}));

const { registerSystemCli } = await import("./system-cli.js");

function gatewayCall(callIndex = 0): ReadonlyArray<unknown> {
  const call = callGatewayFromCli.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected gateway call ${callIndex + 1}`);
  }
  return call;
}

function jsonFailure(message: string) {
  return { ok: false, error: { type: "cli_error", message } };
}

describe("system-cli", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerSystemCli(program);
    try {
      await program.parseAsync(args, { from: "user" });
    } catch (err) {
      if (!(err instanceof Error && err.message.startsWith("__exit__:"))) {
        throw err;
      }
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetRuntimeCapture();
    callGatewayFromCli.mockResolvedValue({ ok: true });
  });

  it("reports a rejected system event instead of claiming it was enqueued", async () => {
    callGatewayFromCli.mockResolvedValueOnce({ ok: false, reason: "unwakeable-session-key" });

    await runCli(["system", "event", "--text", "hello"]);

    expect(runtimeLogs).toEqual([]);
    expect(runtimeErrors[0]).toContain("unwakeable-session-key");
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it.each([
    {
      name: "invalid wake mode",
      args: ["system", "event", "--text", "hello", "--mode", "later", "--json"],
      gatewayResult: undefined,
      expectedError: "--mode must be now or next-heartbeat",
      gatewayCalls: 0,
    },
  ])(
    "writes JSON when $name fails",
    async ({ args, gatewayResult, expectedError, gatewayCalls }) => {
      if (gatewayResult) {
        callGatewayFromCli.mockResolvedValueOnce(gatewayResult);
      }

      await runCli(args);

      expect(runtimeLogs).toEqual([JSON.stringify(jsonFailure(expectedError), null, 2)]);
      expect(runtimeErrors).toEqual([]);
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(jsonFailure(expectedError));
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
      expect(callGatewayFromCli).toHaveBeenCalledTimes(gatewayCalls);
    },
  );

  it.each([{ mode: "human", args: ["system", "event", "--text", "hello"] }])(
    "hands agent selection refusals to the CLI failure owner in $mode mode",
    async ({ args }) => {
      const error = new Error("Multiple agents are configured, but this operation has no owner.");
      error.name = "AgentSelectionRequiredError";
      callGatewayFromCli.mockRejectedValueOnce(error);

      // The root failure owner renders expected conditions without crash framing;
      // the command must rethrow instead of printing its own copy.
      await expect(runCli(args)).rejects.toBe(error);

      expect(runtimeLogs).toEqual([]);
      expect(runtimeErrors).toEqual([]);
      expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect(defaultRuntime.exit).not.toHaveBeenCalled();
    },
  );

  it("forwards --session-key on system event", async () => {
    await runCli([
      "system",
      "event",
      "--text",
      "ping",
      "--session-key",
      "agent:main:telegram:dm:42",
    ]);

    expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
    const [method, gatewayOptions, params, requestOptions] = gatewayCall();
    expect(method).toBe("wake");
    expect(typeof gatewayOptions).toBe("object");
    expect(params).toEqual({
      mode: "next-heartbeat",
      text: "ping",
      sessionKey: "agent:main:telegram:dm:42",
    });
    expect(requestOptions).toEqual({ expectFinal: false });
  });

  it.each([{ args: ["system", "presence"], method: "system-presence", params: undefined }])(
    "routes $args to gateway",
    async ({ args, method, params }) => {
      callGatewayFromCli.mockResolvedValueOnce({ method });

      await runCli(args);

      expect(callGatewayFromCli).toHaveBeenCalledTimes(1);
      const [calledMethod, gatewayOptions, calledParams, requestOptions] = gatewayCall();
      expect(calledMethod).toBe(method);
      expect(typeof gatewayOptions).toBe("object");
      expect(calledParams).toEqual(params);
      expect(requestOptions).toEqual({ expectFinal: false });
      expect(runtimeLogs).toEqual([JSON.stringify({ method }, null, 2)]);
    },
  );
});
