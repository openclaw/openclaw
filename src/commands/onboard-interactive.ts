import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { runOnboardingWizard } from "../wizard/onboarding.js";
import { WizardCancelledError } from "../wizard/prompts.js";
import type { OnboardOptions } from "./onboard-types.js";

export async function runInteractiveOnboarding(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const prompter = createClackPrompter();
  try {
    await runOnboardingWizard(opts, runtime, prompter);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(0);
      return;
    }
    throw err;
  }
}
