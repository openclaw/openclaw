import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { restoreTerminalState } from "../terminal/restore.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { runOnboardingWizard } from "../wizard/onboarding.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import type { OnboardOptions } from "./onboard-types.js";

export async function runInteractiveOnboarding(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const prompter = createClackPrompter();
  let exitCode: number | null = null;
  try {
    await runOnboardingWizard(opts, runtime, prompter);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      // Best practice: cancellation is not a successful completion.
      // Also clear the sentinel so the next run does not falsely report
      // an interrupted session — the user simply chose to cancel.
      const { clearOnboardingInProgress } = await import("./onboard-helpers.js");
      await clearOnboardingInProgress();
      exitCode = 1;
      return;
    }
    throw err;
  } finally {
    // Keep stdin paused so non-daemon runs can exit cleanly (e.g. Docker setup).
    restoreTerminalState("onboarding finish", { resumeStdinIfPaused: false });
    if (exitCode !== null) {
      runtime.exit(exitCode);
    }
  }
}
