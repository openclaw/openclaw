import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { runCrestodianWithInference } from "./crestodian-with-inference.js";

function runtime(): RuntimeEnv {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
}

const tty = { isTTY: true } as NodeJS.ReadableStream & NodeJS.WritableStream;
const pipe = { isTTY: false } as NodeJS.ReadableStream & NodeJS.WritableStream;

describe("runCrestodianWithInference", () => {
  it("starts Crestodian only after live inference succeeds", async () => {
    const runCrestodian = vi.fn(async () => {});
    const verifyInference = vi.fn(async () => ({
      ok: true as const,
      modelRef: "openai/gpt-5.5",
      latencyMs: 100,
    }));
    const currentRuntime = runtime();

    await runCrestodianWithInference(
      { input: tty, output: tty },
      currentRuntime,
      {},
      {
        verifyInference,
        runCrestodian,
      },
    );

    expect(verifyInference).toHaveBeenCalledWith({ runtime: currentRuntime });
    expect(runCrestodian).toHaveBeenCalledOnce();
    expect(verifyInference.mock.invocationCallOrder[0]).toBeLessThan(
      runCrestodian.mock.invocationCallOrder[0]!,
    );
  });

  it("routes an interactive inference failure into guided setup", async () => {
    const runGuidedOnboarding = vi.fn(async () => {});
    const runCrestodian = vi.fn(async () => {});
    const currentRuntime = runtime();

    await runCrestodianWithInference(
      { input: tty, output: tty },
      currentRuntime,
      { workspace: "/tmp/work", acceptRisk: true },
      {
        verifyInference: vi.fn(async () => ({
          ok: false as const,
          status: "auth" as const,
          error: "login expired",
        })),
        runGuidedOnboarding,
        runCrestodian,
      },
    );

    expect(runGuidedOnboarding).toHaveBeenCalledWith(
      { workspace: "/tmp/work", acceptRisk: true },
      currentRuntime,
    );
    expect(runCrestodian).not.toHaveBeenCalled();
  });

  it("rejects an impossible interactive request before probing inference", async () => {
    const currentRuntime = runtime();
    const verifyInference = vi.fn();

    await runCrestodianWithInference(
      { input: pipe, output: pipe },
      currentRuntime,
      {},
      { verifyInference },
    );

    expect(currentRuntime.error).toHaveBeenCalledWith(
      "Crestodian needs an interactive TTY. Use --message for one command.",
    );
    expect(currentRuntime.exit).toHaveBeenCalledWith(1);
    expect(verifyInference).not.toHaveBeenCalled();
  });

  it.each([
    { label: "one-shot", options: { message: "status" } },
    { label: "noninteractive", options: { interactive: false } },
  ])(
    "fails $label mode with onboarding guidance when inference is unavailable",
    async ({ options }) => {
      const currentRuntime = runtime();
      const runGuidedOnboarding = vi.fn(async () => {});

      await runCrestodianWithInference(
        options,
        currentRuntime,
        {},
        {
          verifyInference: vi.fn(async () => ({
            ok: false as const,
            status: "unavailable" as const,
            error: "no configured model",
          })),
          runGuidedOnboarding,
        },
      );

      expect(currentRuntime.error).toHaveBeenCalledWith(
        expect.stringContaining("openclaw onboard"),
      );
      expect(currentRuntime.exit).toHaveBeenCalledWith(1);
      expect(runGuidedOnboarding).not.toHaveBeenCalled();
    },
  );

  it("returns a structured JSON error when inference is unavailable", async () => {
    const currentRuntime = runtime();

    await runCrestodianWithInference(
      { json: true },
      currentRuntime,
      {},
      {
        verifyInference: vi.fn(async () => ({
          ok: false as const,
          status: "auth" as const,
          error: "login expired",
        })),
      },
    );

    expect(currentRuntime.log).toHaveBeenCalledWith(expect.stringContaining('"status": "auth"'));
    expect(currentRuntime.log).toHaveBeenCalledWith(
      expect.stringContaining('"guidance": "Run `openclaw onboard`'),
    );
    expect(currentRuntime.error).not.toHaveBeenCalled();
    expect(currentRuntime.exit).toHaveBeenCalledWith(1);
  });
});
