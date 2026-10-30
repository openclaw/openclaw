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

describe("runSystemAgentWithInference", () => {
  let currentRuntime: RuntimeEnv;
  let home: Awaited<ReturnType<typeof createTempHomeEnv>>;
  let configPath: string;
  beforeEach(async () => {
    home = await createTempHomeEnv("setup-cold-");
    configPath = path.join(home.home, ".openclaw", "openclaw.json");
    vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
    await fs.writeFile(configPath, JSON.stringify({ plugins: { enabled: false } }));
    resetConfigRuntimeState();
    vi.resetAllMocks();
    currentRuntime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() as RuntimeEnv["exit"] };
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
    await runSystemAgentWithInference({ interactive: false }, currentRuntime);
    expect(currentRuntime.error).not.toHaveBeenCalled();
    expect(getRuntimeConfig().plugins?.enabled).toBe(false);
    expect(runSystemAgent).toHaveBeenCalledWith(
      expect.objectContaining({ verifiedInference }),
      currentRuntime,
    );
    expect(requestExitAfterOneShotOutput).toHaveBeenCalledExactlyOnceWith(currentRuntime);
  });

  it.each([false, true])("reports one thrown failure with drained JSON=%s", async (json) => {
    const message = "verification or execution failed";
    (json ? verifySetupInference : runSystemAgent).mockRejectedValue(new Error(message));
    requestExitAfterOneShotOutput.mockReturnValue(json);
    await runSystemAgentWithInference({ json, message: "status", yes: true }, currentRuntime);
    expect(json ? currentRuntime.log : currentRuntime.error).toHaveBeenCalledExactlyOnceWith(
      json ? expect.stringContaining(message) : message,
    );
    expect(json ? currentRuntime.error : currentRuntime.log).not.toHaveBeenCalled();
    expect(requestExitAfterOneShotOutput).toHaveBeenCalledExactlyOnceWith(currentRuntime, 1);
    expect(runSystemAgent).toHaveBeenCalledTimes(json ? 0 : 1);
    expect(vi.mocked(currentRuntime.exit).mock.calls).toEqual(json ? [] : [[1]]);
  });

  it("lets interactive OpenClaw execution errors propagate", async () => {
    inferenceMocks.runSystemAgent.mockRejectedValue(new Error("interactive operation failed"));

    await expect(
      runSystemAgentWithInference({ input: tty, output: tty }, currentRuntime),
    ).rejects.toThrow("interactive operation failed");

    expect(currentRuntime.error).not.toHaveBeenCalled();
    expect(requestExitAfterOneShotOutput).not.toHaveBeenCalled();
  });

  it("routes an interactive inference failure into guided setup", async () => {
    inferenceMocks.verifySetupInference.mockResolvedValue(expiredAuth);

    await runSystemAgentWithInference({ input: tty, output: tty }, currentRuntime, {
      workspace: "/tmp/work",
      acceptRisk: true,
    });

    expect(inferenceMocks.runGuidedOnboarding).toHaveBeenCalledWith(
      { workspace: "/tmp/work", acceptRisk: true },
      currentRuntime,
      { handoffMode: "chat" },
    );
    expect(inferenceMocks.runSystemAgent).not.toHaveBeenCalled();
  });

  it("rejects an impossible interactive request before probing inference", async () => {
    await runSystemAgentWithInference({ input: pipe, output: pipe }, currentRuntime);

    expect(currentRuntime.error).toHaveBeenCalledWith(
      "OpenClaw needs an interactive TTY. Use --message for one command.",
    );
    expect(currentRuntime.exit).toHaveBeenCalledWith(1);
    expect(inferenceMocks.verifySetupInference).not.toHaveBeenCalled();
  });

  it("returns one structured error for --json --yes without a message", async () => {
    await runSystemAgentWithInference({ json: true, yes: true }, currentRuntime);

    expect(currentRuntime.log).toHaveBeenCalledWith(
      expect.stringContaining('"error": "OpenClaw --yes requires --message'),
    );
    expect(currentRuntime.error).not.toHaveBeenCalled();
    expect(requestExitAfterOneShotOutput).toHaveBeenCalledWith(currentRuntime, 1);
    expect(currentRuntime.exit).toHaveBeenCalledWith(1);
    expect(inferenceMocks.verifySetupInference).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports unavailable inference (json=%s)", async (json) => {
    verifySetupInference.mockResolvedValue(
      json ? expiredAuth : { ok: false, status: "unavailable", error: "no configured model" },
    );
    await runSystemAgentWithInference({ json, message: "status" }, currentRuntime);
    expect(json ? currentRuntime.log : currentRuntime.error).toHaveBeenCalledWith(
      expect.stringContaining("Run `openclaw onboard`"),
    );
    if (json) {
      expect(currentRuntime.log).toHaveBeenCalledWith(expect.stringContaining('"status": "auth"'));
      expect(currentRuntime.error).not.toHaveBeenCalled();
    }
    expect(requestExitAfterOneShotOutput).toHaveBeenCalledWith(currentRuntime, 1);
    expect(inferenceMocks.runGuidedOnboarding).not.toHaveBeenCalled();
    expect(currentRuntime.exit).toHaveBeenCalledWith(1);
  });
});
