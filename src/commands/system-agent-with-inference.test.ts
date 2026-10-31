import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRequiredSessionPlacement } from "../agents/session-placement-admission.js";
import { getRuntimeConfig } from "../config/io.js";
import { resetConfigRuntimeState } from "../config/runtime-snapshot.js";
import type { RuntimeEnv } from "../runtime.js";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
import { runSystemAgentWithInference } from "./system-agent-with-inference.js";

const inferenceMocks = vi.hoisted(() => ({
  verifySetupInference: vi.fn(),
  runSystemAgent: vi.fn(),
  runGuidedOnboarding: vi.fn(),
}));
vi.mock("../system-agent/setup-inference.js", () => ({
  verifySetupInference: inferenceMocks.verifySetupInference,
}));
vi.mock("../system-agent/system-agent.js", () => ({
  runSystemAgent: inferenceMocks.runSystemAgent,
}));
vi.mock("./onboard-guided.js", () => ({
  runGuidedOnboarding: inferenceMocks.runGuidedOnboarding,
}));

const exitMocks = vi.hoisted(() => ({ requestExitAfterOneShotOutput: vi.fn() }));
vi.mock("../cli/one-shot-exit.js", () => ({
  requestExitAfterOneShotOutput: exitMocks.requestExitAfterOneShotOutput,
}));

const tty = { isTTY: true } as unknown as NodeJS.ReadableStream & NodeJS.WritableStream;
const pipe = { isTTY: false } as unknown as NodeJS.ReadableStream & NodeJS.WritableStream;
const verifiedInference = { execution: { modelLabel: "openai/gpt-5.5" } } as never;
const verifiedResult = {
  ok: true,
  modelRef: "openai/gpt-5.5",
  latencyMs: 100,
  binding: verifiedInference,
};
const expiredAuth = { ok: false, status: "auth", error: "login expired" };
const { runSystemAgent, verifySetupInference } = inferenceMocks;
const { requestExitAfterOneShotOutput } = exitMocks;

function expectFailureOutput(runtime: RuntimeEnv, json: boolean, expected: unknown) {
  const calls = vi.mocked(json ? runtime.log : runtime.error).mock.calls;
  expect(calls).toHaveLength(1);
  expect(json ? JSON.parse(String(calls[0]?.[0])) : calls[0]?.[0]).toEqual(expected);
  expect(json ? runtime.error : runtime.log).not.toHaveBeenCalled();
}

describe("runSystemAgentWithInference", () => {
  let runtime: RuntimeEnv;
  let home: Awaited<ReturnType<typeof createTempHomeEnv>>;
  beforeEach(async () => {
    home = await createTempHomeEnv("setup-cold-");
    const configPath = path.join(home.home, ".openclaw", "openclaw.json");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(configPath, JSON.stringify({ plugins: { enabled: false } }));
    resetConfigRuntimeState();
    vi.resetAllMocks();
    runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() as RuntimeEnv["exit"] };
    inferenceMocks.verifySetupInference.mockResolvedValue(verifiedResult);
    requestExitAfterOneShotOutput.mockReturnValue(false);
  });

  afterEach(async () => {
    resetConfigRuntimeState();
    vi.unstubAllEnvs();
    await home.restore();
  });

  it("publishes cold runtime before placement and drains successful output", async () => {
    expect(() => getRuntimeConfig()).toThrow("Runtime config is not prepared");
    verifySetupInference.mockImplementation(() =>
      withRequiredSessionPlacement(
        { sessionId: "setup-probe" },
        { config: {} },
        async () => verifiedResult,
      ),
    );
    await runSystemAgentWithInference({ interactive: false }, runtime);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(getRuntimeConfig().plugins?.enabled).toBe(false);
    const verifiedOptions = expect.objectContaining({ verifiedInference });
    expect(runSystemAgent).toHaveBeenCalledWith(verifiedOptions, runtime);
    expect(requestExitAfterOneShotOutput).toHaveBeenCalledExactlyOnceWith(runtime);
  });

  it.each([false, true])("reports one thrown failure with drained JSON=%s", async (json) => {
    const message = "verification or execution failed";
    (json ? verifySetupInference : runSystemAgent).mockRejectedValue(new Error(message));
    requestExitAfterOneShotOutput.mockReturnValue(json);
    await runSystemAgentWithInference({ json, message: "status", yes: true }, runtime);
    const expected = json ? { ok: false, error: { type: "cli_error", message } } : message;
    expectFailureOutput(runtime, json, expected);
    expect(requestExitAfterOneShotOutput).toHaveBeenCalledExactlyOnceWith(runtime, 1);
    expect(runSystemAgent).toHaveBeenCalledTimes(json ? 0 : 1);
    expect(vi.mocked(runtime.exit).mock.calls).toEqual(json ? [] : [[1]]);
  });

  it("lets interactive OpenClaw execution errors propagate", async () => {
    const message = "interactive operation failed";
    runSystemAgent.mockRejectedValue(new Error(message));
    const execution = runSystemAgentWithInference({ input: tty, output: tty }, runtime);
    await expect(execution).rejects.toThrow(message);
    expect(runtime.error).not.toHaveBeenCalled();
    expect(requestExitAfterOneShotOutput).not.toHaveBeenCalled();
  });

  it("routes an interactive inference failure into guided setup", async () => {
    inferenceMocks.verifySetupInference.mockResolvedValue(expiredAuth);
    await runSystemAgentWithInference({ input: tty, output: tty }, runtime, {
      workspace: "/tmp/work",
      acceptRisk: true,
    });
    expect(inferenceMocks.runGuidedOnboarding).toHaveBeenCalledWith(
      { workspace: "/tmp/work", acceptRisk: true },
      runtime,
      { handoffMode: "chat" },
    );
    expect(inferenceMocks.runSystemAgent).not.toHaveBeenCalled();
  });

  it("rejects an impossible interactive request before probing inference", async () => {
    await runSystemAgentWithInference({ input: pipe, output: pipe }, runtime);
    expect(runtime.error).toHaveBeenCalledWith(
      "OpenClaw needs an interactive TTY. Use --message for one command.",
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(inferenceMocks.verifySetupInference).not.toHaveBeenCalled();
  });

  it("returns one structured error for --json --yes without a message", async () => {
    await runSystemAgentWithInference({ json: true, yes: true }, runtime);
    expectFailureOutput(runtime, true, {
      ok: false,
      error: {
        type: "cli_error",
        message: "OpenClaw --yes requires --message so approval is limited to one request.",
      },
    });
    expect(requestExitAfterOneShotOutput).toHaveBeenCalledWith(runtime, 1);
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(inferenceMocks.verifySetupInference).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports unavailable inference (json=%s)", async (json) => {
    const failure = json
      ? expiredAuth
      : { ok: false, status: "unavailable", error: "no configured model" };
    verifySetupInference.mockResolvedValue(failure);
    await runSystemAgentWithInference({ json, message: "status" }, runtime);
    const guidance = "Run `openclaw onboard` to connect and live-test AI first.";
    const message = `OpenClaw requires working inference: ${failure.error}`;
    const expected = json
      ? { ok: false, status: failure.status, error: { type: "cli_error", message }, guidance }
      : `${message}\n${guidance}`;
    expectFailureOutput(runtime, json, expected);
    expect(requestExitAfterOneShotOutput).toHaveBeenCalledWith(runtime, 1);
    expect(inferenceMocks.runGuidedOnboarding).not.toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
