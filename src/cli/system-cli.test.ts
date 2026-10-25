import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const callGatewayFromCli = vi.fn();

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } =
  createCliRuntimeCapture();

const { readConfigFileSnapshot, resolveHeartbeatCliStatus } = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveHeartbeatCliStatus: vi.fn(),
}));

// mock-isolation: Local heartbeat status stubs snapshot + projection; real Automation
// job reads stay in heartbeat-cli-status unit coverage.
vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => readConfigFileSnapshot(...args),
}));
vi.mock("../infra/heartbeat-cli-status.js", () => ({
  resolveHeartbeatCliStatus: (...args: unknown[]) => resolveHeartbeatCliStatus(...args),
}));

// mock-isolation: Exercise command registration without opening a live Gateway connection.
vi.mock("./gateway-rpc.js", () => ({
  addGatewayClientOptions: (command: Command) => command,
  callGatewayFromCli,
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime,
  writeRuntimeJson: (runtime: { log: (...args: unknown[]) => void }, value: unknown, space = 2) =>
    runtime.log(JSON.stringify(value, null, space > 0 ? space : undefined)),
}));

const { registerSystemCli } = await import("./system-cli.js");

function expectGatewayCall(method: string, params: unknown) {
  expect(callGatewayFromCli).toHaveBeenCalledExactlyOnceWith(method, expect.any(Object), params, {
    expectFinal: false,
  });
}

describe("system-cli", () => {
  async function runCli(args: string[]) {
    const program = new Command();
    registerSystemCli(program);
    await program.parseAsync(args, { from: "user" }).catch((err: unknown) => {
      if (!(err instanceof Error && err.message.startsWith("__exit__:"))) {
        throw err;
      }
    });
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

  it("writes JSON when invalid wake mode fails", async () => {
    await runCli(["system", "event", "--text", "hello", "--mode", "later", "--json"]);
    const failure = {
      ok: false,
      error: { type: "cli_error", message: "--mode must be now or next-heartbeat" },
    };
    expect(runtimeLogs).toEqual([JSON.stringify(failure, null, 2)]);
    expect(runtimeErrors).toEqual([]);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(failure);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    expect(callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("hands agent selection refusals to the CLI failure owner in human mode", async () => {
    const error = new Error("Multiple agents are configured, but this operation has no owner.");
    error.name = "AgentSelectionRequiredError";
    callGatewayFromCli.mockRejectedValueOnce(error);

    await expect(runCli(["system", "event", "--text", "hello"])).rejects.toBe(error);

    expect(runtimeLogs).toEqual([]);
    expect(runtimeErrors).toEqual([]);
    expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
    expect(defaultRuntime.exit).not.toHaveBeenCalled();
  });

  it("forwards --session-key on system event", async () => {
    const sessionKey = "agent:main:telegram:dm:42";
    await runCli(["system", "event", "--text", "ping", "--session-key", sessionKey]);

    expectGatewayCall("wake", {
      mode: "next-heartbeat",
      text: "ping",
      sessionKey,
    });
  });

  it("routes system presence to gateway", async () => {
    const method = "system-presence";
    callGatewayFromCli.mockResolvedValueOnce({ method });

    await runCli(["system", "presence"]);
    expectGatewayCall(method, undefined);
    expect(runtimeLogs).toEqual([JSON.stringify({ method }, null, 2)]);
  });

  it("prints local heartbeat status without calling the Gateway", async () => {
    readConfigFileSnapshot.mockResolvedValueOnce({
      path: "/tmp/openclaw.json",
      exists: true,
      valid: true,
      config: {
        agents: {
          ownership: "explicit",
          defaults: { systemAgent: { agentId: "main" }, userTimezone: "UTC" },
          entries: { main: {} },
        },
      },
      sourceConfig: {},
      resolved: {},
      runtimeConfig: {},
      raw: "{}",
      parsed: {},
      issues: [],
      warnings: [],
      legacyIssues: [],
    });
    resolveHeartbeatCliStatus.mockResolvedValueOnce({
      agentId: "main",
      jobId: "job-1",
      enabled: true,
      every: "1800000ms",
      everyMs: 1_800_000,
      withinActiveHours: false,
      nextFireSource: "outside-active-hours",
      nextFireAt: null,
      nextFireInMs: null,
      activeHours: { start: "12:00", end: "12:00", timezone: "UTC" },
      prompt: "",
      target: "owner",
      ackMaxChars: 300,
    });

    await runCli(["system", "heartbeat", "status", "--json"]);

    expect(callGatewayFromCli).not.toHaveBeenCalled();
    expect(readConfigFileSnapshot).toHaveBeenCalled();
    expect(resolveHeartbeatCliStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: expect.objectContaining({
          ownership: "explicit",
        }),
      }),
      expect.objectContaining({ agentId: undefined }),
    );
    const payload = defaultRuntime.writeJson.mock.calls.at(-1)?.[0] as {
      every?: string;
      withinActiveHours?: boolean;
      nextFireSource?: string;
      nextFireAt?: string | null;
      jobId?: string | null;
    };
    expect(payload.every).toBe("1800000ms");
    expect(payload.withinActiveHours).toBe(false);
    expect(payload.nextFireSource).toBe("outside-active-hours");
    expect(payload.nextFireAt).toBeNull();
    expect(payload.jobId).toBe("job-1");
  });

});
