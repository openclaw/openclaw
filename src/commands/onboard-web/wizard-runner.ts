/**
 * Wizard runner for web-based onboarding.
 *
 * Runs the onboarding wizard using the WebPrompter.
 */

import type { RuntimeEnv } from "../../runtime.js";
import type { OnboardOptions } from "../onboard-types.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { runOnboardingWizard as runWizard } from "../../wizard/onboarding.js";

export async function runOnboardingWizard(
  prompter: WizardPrompter,
  opts: OnboardOptions,
  runtime: RuntimeEnv,
): Promise<void> {
  // Run the onboarding wizard with web prompter
  await runWizard(
    {
      ...opts,
      // Force quickstart flow for web UI (simpler experience)
      flow: opts.flow ?? "quickstart",
    },
    runtime,
    prompter,
  );
}
