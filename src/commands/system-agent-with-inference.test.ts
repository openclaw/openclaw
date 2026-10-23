import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
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
const expiredAuth = { ok: false, status: "auth", error: "login expired" };
const { runSystemAgent, verifySetupInference } = inferenceMocks;
const { requestExitAfterOneShotOutput } = exitMocks;

describe("runSystemAgentWithInference", () => {
  let currentRuntime: RuntimeEnv;
  beforeEach(() => {
    vi.resetAllMocks();
    currentRuntime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() as RuntimeEnv["exit"] };
    inferenceMocks.verifySetupInference.mockResolvedValue({
      ok: true,
      modelRef: "openai/gpt-5.5",
      latencyMs: 100,
      binding: verifiedInference,
    });
    requestExitAfterOneShotOutput.mockReturnValue(false);
  });

  it("requests a clean process exit after successful noninteractive output", async () => {
    await runSystemAgentWithInference({ interactive: false }, currentRuntime);

    expect(requestExitAfterOneShotOutput).toHaveBeenCalledWith(currentRuntime);
    expect(verifySetupInference).toHaveBeenCalledWith({
      runtime: currentRuntime,
      bindSession: true,
    });
    expect(runSystemAgent).toHaveBeenCalledWith(
      expect.objectContaining({ verifiedInference }),
      currentRuntime,
    );
    expect(verifySetupInference.mock.invocationCallOrder[0]).toBeLessThan(
      runSystemAgent.mock.invocationCallOrder[0]!,
    );
    expect(runSystemAgent.mock.invocationCallOrder[0]).toBeLessThan(
      requestExitAfterOneShotOutput.mock.invocationCallOrder[0]!,
    );
  });

  it("reports a one-shot execution error once and requests exit code 1", async () => {
    inferenceMocks.runSystemAgent.mockRejectedValue(new Error("Plugin install spec is invalid."));

    await runSystemAgentWithInference(
      { message: "install plugin https://example.test/plugin.tgz", yes: true },
      currentRuntime,
    );

    expect(currentRuntime.error).toHaveBeenCalledExactlyOnceWith("Plugin install spec is invalid.");
    expect(requestExitAfterOneShotOutput).toHaveBeenCalledExactlyOnceWith(currentRuntime, 1);
    expect(currentRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("returns one drained JSON error when inference verification throws", async () => {
    requestExitAfterOneShotOutput.mockReturnValueOnce(true);
    inferenceMocks.verifySetupInference.mockRejectedValue(new Error("verification exploded"));

    await runSystemAgentWithInference({ json: true }, currentRuntime);

    expect(currentRuntime.log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('"error": "verification exploded"'),
    );
    expect(currentRuntime.error).not.toHaveBeenCalled();
    expect(inferenceMocks.runSystemAgent).not.toHaveBeenCalled();
    expect(requestExitAfterOneShotOutput).toHaveBeenCalledExactlyOnceWith(currentRuntime, 1);
    expect(currentRuntime.exit).not.toHaveBeenCalled();
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
      json
        ? expiredAuth
        : {
            ok: false,
            status: "unavailable",
            error: "no configured model",
          },
    );
    await runSystemAgentWithInference(
      json ? { json: true } : { message: "status" },
      currentRuntime,
    );
    if (json) {
      expect(currentRuntime.log).toHaveBeenCalledWith(expect.stringContaining('"status": "auth"'));
      expect(currentRuntime.log).toHaveBeenCalledWith(
        expect.stringContaining('"guidance": "Run `openclaw onboard`'),
      );
      expect(currentRuntime.error).not.toHaveBeenCalled();
    } else {
      expect(currentRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("openclaw onboard"),
      );
      expect(requestExitAfterOneShotOutput).toHaveBeenCalledWith(currentRuntime, 1);
      expect(inferenceMocks.runGuidedOnboarding).not.toHaveBeenCalled();
    }
    expect(currentRuntime.exit).toHaveBeenCalledWith(1);
  });
});
