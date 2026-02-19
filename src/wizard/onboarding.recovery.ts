import type { OpenClawConfig } from "../config/config.js";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "./prompts.js";
import {
  categorizeOnboardingError,
  formatOnboardingError,
  generateRecoveryAction,
  type OnboardingErrorContext,
} from "./onboarding.errors.js";

export type RecoveryResult = {
  recovered: boolean;
  shouldRetry: boolean;
  shouldSkip: boolean;
  message: string;
};

/**
 * Attempt to recover from an onboarding error.
 */
export async function attemptRecovery(
  context: OnboardingErrorContext,
  prompter: WizardPrompter,
  runtime: RuntimeEnv,
): Promise<RecoveryResult> {
  const categorized = categorizeOnboardingError(context.error);
  const action = generateRecoveryAction(context);

  // For transient errors, suggest retry
  if (categorized.isTransient && categorized.isRecoverable) {
    const retry = await prompter.confirm({
      message: `${action.message} Would you like to retry?`,
      initialValue: true,
    });

    if (retry) {
      return {
        recovered: false,
        shouldRetry: true,
        shouldSkip: false,
        message: "Retrying...",
      };
    }
  }

  // For config errors, try auto-repair
  if (categorized.category === "config" && action.type === "fix") {
    const snapshot = await readConfigFileSnapshot();
    if (snapshot.exists && !snapshot.valid) {
      const tryFix = await prompter.confirm({
        message: "Would you like to attempt automatic config repair?",
        initialValue: true,
      });

      if (tryFix) {
        try {
          // Try to load and re-validate config
          // If it's just missing required fields, we can continue
          if (snapshot.config && Object.keys(snapshot.config).length > 0) {
            // Config exists but invalid - suggest manual fix
            return {
              recovered: false,
              shouldRetry: false,
              shouldSkip: false,
              message:
                "Config repair requires manual intervention. Run `openclaw doctor` to fix.",
            };
          }
        } catch {
          // Repair failed
        }
      }
    }
  }

  // For permission errors, provide guidance
  if (categorized.category === "permission") {
    await prompter.note(
      [
        formatOnboardingError(context, runtime),
        "",
        "Please fix the permission issue and retry onboarding.",
      ].join("\n"),
      "Permission Error",
    );

    return {
      recovered: false,
      shouldRetry: false,
      shouldSkip: false,
      message: "Permission error - please fix and retry",
    };
  }

  // For port conflicts, offer to skip or use different port
  if (categorized.category === "port") {
    const skipPortCheck = await prompter.confirm({
      message:
        "Port conflict detected. Continue anyway? (You can configure a different port)",
      initialValue: true,
    });

    if (skipPortCheck) {
      return {
        recovered: true,
        shouldRetry: false,
        shouldSkip: true,
        message: "Skipping port check - you can configure port during setup",
      };
    }
  }

  // Default: show error and ask what to do
  await prompter.note(formatOnboardingError(context, runtime), "Error");

  const choice = await prompter.select({
    message: "How would you like to proceed?",
    options: [
      { value: "retry", label: "Retry this step" },
      { value: "skip", label: "Skip this step" },
      { value: "abort", label: "Abort onboarding" },
    ],
  });

  if (choice === "retry") {
    return {
      recovered: false,
      shouldRetry: true,
      shouldSkip: false,
      message: "Retrying step...",
    };
  }

  if (choice === "skip") {
    return {
      recovered: true,
      shouldRetry: false,
      shouldSkip: true,
      message: "Skipping step...",
    };
  }

  return {
    recovered: false,
    shouldRetry: false,
    shouldSkip: false,
    message: "Onboarding aborted by user",
  };
}

/**
 * Wrap an async function with error recovery.
 */
export async function withErrorRecovery<T>(
  stepName: string,
  fn: () => Promise<T>,
  prompter: WizardPrompter,
  runtime: RuntimeEnv,
  maxRetries: number = 3,
): Promise<T> {
  let lastError: Error | null = null;
  let attempts = 0;

  while (attempts < maxRetries) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      attempts++;

      const context: OnboardingErrorContext = {
        step: stepName,
        error: lastError,
      };

      const recovery = await attemptRecovery(context, prompter, runtime);

      if (recovery.shouldRetry && attempts < maxRetries) {
        continue;
      }

      if (recovery.shouldSkip) {
        throw new Error(`Step skipped: ${stepName}`);
      }

      if (!recovery.shouldRetry) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error(`Failed after ${maxRetries} attempts`);
}
