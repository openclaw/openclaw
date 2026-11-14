import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

const callGatewayFromCli = vi.fn();

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } =
  createCliRuntimeCapture();

const { readConfigFileSnapshot, resolveHeartbeatCliStatus } = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveHeartbeatCliStatus: vi.fn(),
}));

// mock-isolation: Local heartbeat status stubs snapshot; real Automation job reads stay in unit coverage.
vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: (...args: unknown[]) => readConfigFileSnapshot(...args),
}));
// mock-isolation: Project heartbeat status without reading live Automation jobs here.
vi.mock("../infra/heartbeat-cli-status.js", () => ({
  resolveHeartbeatCliStatus: (...args: unknown[]) => resolveHeartbeatCliStatus(...args),
}));
// mock-isolation: Exercise command registration without opening a live Gateway connection.
vi.mock("./gateway-rpc.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./gateway-rpc.js")>()),
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
    [["presence"], "system-presence", undefined, undefined],
  ] as const)("settles interrupted system %j", async (args, method, params, output) => {
    const scope = new AsyncWorkScope();
    const pending = scope.run(() => runCli(["system", ...args]));
    scope.beginClose();
    await pending;
    expect(callGatewayFromCli.mock.calls[0]?.slice(0, 3)).toEqual([
      method,
      expect.any(Object),
      params,
    ]);
    expect(runtimeLogs).toEqual(output ? [output] : []);
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
