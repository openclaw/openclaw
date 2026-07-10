// Crestodian command gate: prove inference before starting conversational setup.
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
  const oneShot = isOneShotRequest(opts);
  if (!oneShot && !hasInteractiveTty(opts)) {
    runtime.error("Crestodian needs an interactive TTY. Use --message for one command.");
    runtime.exit(1);
    return;
  }
  const verifyInference =
    deps.verifyInference ?? (await import("../crestodian/setup-inference.js")).verifySetupInference;
  const inference = await withConsoleSubsystemsSuppressed(() => verifyInference({ runtime }));
  if (inference.ok) {
    const runCrestodian =
      deps.runCrestodian ?? (await import("../crestodian/crestodian.js")).runCrestodian;
    await runCrestodian(opts, runtime);
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
    runtime.exit(1);
    return;
  }

  runtime.log("Crestodian requires working inference. Starting guided AI setup…");
  const runGuidedOnboarding =
    deps.runGuidedOnboarding ?? (await import("./onboard-guided.js")).runGuidedOnboarding;
  await runGuidedOnboarding(onboardingOptions, runtime);
}
