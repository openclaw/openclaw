import type { RuntimeEnv } from "../runtime.js";
import type { OnboardOptions } from "./onboard-types.js";
import { defaultRuntime } from "../runtime.js";
import { restoreTerminalState } from "../terminal/restore.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { runOnboardingWizard } from "../wizard/onboarding.js";
import { WizardCancelledError } from "../wizard/prompts.js";

export async function runInteractiveOnboarding(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const prompter = createClackPrompter();
  try {
    await runOnboardingWizard(opts, runtime, prompter);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  } finally {
    restoreTerminalState("onboarding finish");
  }
}
