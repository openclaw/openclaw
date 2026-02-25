import { randomUUID } from "node:crypto";
import { DEFAULT_GATEWAY_PORT } from "../config/config.js";
import type { OnboardOptions } from "../commands/onboard-types.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";
import type { WizardStep } from "./session.js";
import {
  createWebOnboardingWizardSteps,
  processWebOnboardingStep,
  type WebOnboardingState,
} from "./onboarding-web-steps.js";

export async function runWebOnboardingWizard(
  opts: OnboardOptions,
  runtime: RuntimeEnv = defaultRuntime,
  prompter: WizardPrompter,
): Promise<void> {
  const state: WebOnboardingState = { step: 1 };
  const steps = await createWebOnboardingWizardSteps(prompter, runtime);

  let currentStepIndex = 0;
  let currentStep: WizardStep | null = steps[0] || null;
  let config: any = null;

  while (currentStep) {
    // Push step to prompter
    await prompter.intro(currentStep.title || "");

    // Wait for answer (this will be handled by the client via wizard.next)
    // For now, we'll use a simplified approach where we process steps sequentially
    const answer = await waitForStepAnswer(currentStep, prompter);

    // Process the step
    const result = await processWebOnboardingStep(currentStep, answer, state, runtime);

    if (result.done) {
      // Wizard complete
      await prompter.outro("Activi ist bereit!");
      return;
    }

    if (result.nextStep) {
      currentStep = result.nextStep;
    } else {
      currentStepIndex++;
      currentStep = steps[currentStepIndex] || null;
    }

    if (result.config) {
      config = result.config;
    }
  }

  await prompter.outro("Wizard abgeschlossen.");
}

async function waitForStepAnswer(step: WizardStep, prompter: WizardPrompter): Promise<unknown> {
  switch (step.type) {
    case "welcome":
      // Just wait for confirmation
      await prompter.note(step.message || "", step.title);
      return { confirmed: true };

    case "api-key":
      // This would be handled by client-side UI
      // For now, return a placeholder
      return { provider: step.initialValue || "anthropic", apiKey: "" };

    case "workspace-path":
      return await prompter.text({
        message: step.message || "Workspace-Verzeichnis",
        initialValue: (step.initialValue as string) || "~/.activi/workspace",
        placeholder: step.placeholder,
      });

    case "gateway-config":
      const bind = await prompter.select({
        message: "Gateway Bind-Modus",
        options: step.options || [],
        initialValue: step.initialValue as string,
      });
      const authMode = await prompter.select({
        message: "Gateway Authentifizierung",
        options: [
          { value: "token", label: "Token (auto-generiert)" },
          { value: "password", label: "Passwort" },
        ],
        initialValue: "token",
      });
      return { bind, authMode, port: DEFAULT_GATEWAY_PORT };

    case "channel-cards":
      // Channels are optional, can skip
      const setupChannels = await prompter.confirm({
        message: "Channels jetzt einrichten?",
        initialValue: false,
      });
      return setupChannels ? [] : [];

    case "agent-mode-select":
      return await prompter.select({
        message: step.message || "Agent-Modus",
        options: step.options || [],
        initialValue: step.initialValue as string,
      });

    case "agent-single-form":
      const agentName = await prompter.text({
        message: "Agent-Name",
        initialValue: (step.initialValue as string) || "main",
        placeholder: step.placeholder,
      });
      return { name: agentName };

    case "agent-team-count":
      const count = await prompter.text({
        message: step.message || "Wie viele Agents?",
        initialValue: (step.initialValue as string) || "3",
        placeholder: step.placeholder,
        validate: (value) => {
          const num = parseInt(value, 10);
          if (isNaN(num) || num < 2 || num > 20) {
            return "Anzahl muss zwischen 2 und 20 sein";
          }
          return undefined;
        },
      });
      return count;

    case "agent-grid":
      // Just show the grid, proceed to summary
      await prompter.note(step.message || "", step.title);
      return { confirmed: true };

    case "summary":
      await prompter.note(step.message || "Activi ist bereit.", step.title);
      return { confirmed: true };

    default:
      return {};
  }
}
