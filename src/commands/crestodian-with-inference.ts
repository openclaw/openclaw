// Crestodian command gate: prove inference before starting conversational setup.

import { requestExitAfterOneShotOutput } from "../cli/one-shot-exit.js";
import type { RunCrestodianOptions } from "../crestodian/crestodian.js";
import { withConsoleSubsystemsSuppressed } from "../logging/console.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { OnboardOptions } from "./onboard-types.js";

type RunCrestodian = typeof import("../crestodian/crestodian.js").runCrestodian;
type VerifySetupInference = typeof import("../crestodian/setup-inference.js").verifySetupInference;
type RunGuidedOnboarding = typeof import("./onboard-guided.js").runGuidedOnboarding;

export type CrestodianWithInferenceDeps = {
  verifyInference?: VerifySetupInference;
  runGuidedOnboarding?: RunGuidedOnboarding;
  runCrestodian?: RunCrestodian;
};

function hasInteractiveTty(opts: RunCrestodianOptions): boolean {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  return (
    (input as { isTTY?: boolean }).isTTY === true && (output as { isTTY?: boolean }).isTTY === true
  );
}

function isOneShotRequest(opts: RunCrestodianOptions): boolean {
  return Boolean(opts.json || opts.message?.trim() || opts.interactive === false);
}

function formatOneShotExecutionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failOneShotExecution(
  opts: RunCrestodianOptions,
  runtime: RuntimeEnv,
  error: unknown,
): void {
  const message = formatOneShotExecutionError(error);
  if (opts.json) {
    writeRuntimeJson(runtime, { ok: false, error: message });
  } else {
    runtime.error(message);
  }
  if (!requestExitAfterOneShotOutput(runtime, 1)) {
    runtime.exit(1);
  }
}

/**
 * Start Crestodian only after the configured default model completes a real
 * turn. Interactive failures return to inference onboarding; automation fails
 * closed with a stable command operators can run to repair the prerequisite.
 */
export async function runCrestodianWithInference(
  opts: RunCrestodianOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
  onboardingOptions: Pick<OnboardOptions, "workspace" | "acceptRisk"> = {},
  deps: CrestodianWithInferenceDeps = {},
): Promise<void> {
  if (opts.yes && !opts.message?.trim()) {
    failOneShotExecution(
      opts,
      runtime,
      new Error("Crestodian --yes requires --message so approval is limited to one request."),
    );
    return;
  }
  const oneShot = isOneShotRequest(opts);
  if (!oneShot && !hasInteractiveTty(opts)) {
    runtime.error("Crestodian needs an interactive TTY. Use --message for one command.");
    runtime.exit(1);
    return;
  }
  let inference: Awaited<ReturnType<VerifySetupInference>>;
  try {
    const verifyInference =
      deps.verifyInference ??
      (await import("../crestodian/setup-inference.js")).verifySetupInference;
    inference = await withConsoleSubsystemsSuppressed(() => verifyInference({ runtime }));
  } catch (error) {
    if (!oneShot) {
      throw error;
    }
    failOneShotExecution(opts, runtime, error);
    return;
  }
  if (inference.ok) {
    const runCrestodian =
      deps.runCrestodian ?? (await import("../crestodian/crestodian.js")).runCrestodian;
    try {
      await runCrestodian(opts, runtime);
    } catch (error) {
      if (!oneShot) {
        throw error;
      }
      failOneShotExecution(opts, runtime, error);
      return;
    }
    if (oneShot) {
      requestExitAfterOneShotOutput(runtime);
    }
    return;
  }

  if (oneShot) {
    const guidance = "Run `openclaw onboard` to connect and live-test AI first.";
    if (opts.json) {
      writeRuntimeJson(runtime, {
        ok: false,
        status: inference.status,
        error: `Crestodian requires working inference: ${inference.error}`,
        guidance,
      });
    } else {
      runtime.error(
        [`Crestodian requires working inference: ${inference.error}`, guidance].join("\n"),
      );
    }
    if (!requestExitAfterOneShotOutput(runtime, 1)) {
      runtime.exit(1);
    }
    return;
  }

  runtime.log("Crestodian requires working inference. Starting guided AI setup…");
  const runGuidedOnboarding =
    deps.runGuidedOnboarding ?? (await import("./onboard-guided.js")).runGuidedOnboarding;
  await runGuidedOnboarding(onboardingOptions, runtime);
}
