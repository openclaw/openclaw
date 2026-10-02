import { formatErrorMessage } from "../infra/errors.js";

type GatewayShutdownStep = {
  name: string;
  run: () => Promise<void> | void;
};

/** Failed acquisition retains its owner when native cleanup cannot finish. */
export class GatewayStartupCleanupError extends AggregateError {
  constructor(startupError: unknown, cleanupError: unknown) {
    super([startupError, cleanupError], "Gateway startup failed and cleanup did not complete", {
      cause: startupError,
    });
    this.name = "GatewayStartupCleanupError";
  }
}

export async function rethrowGatewayStartupError(
  error: unknown,
  cleanup: () => Promise<void> | void,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new GatewayStartupCleanupError(error, cleanupError);
  }
  throw error;
}

/** Run every shutdown step even when one owner fails, with the failed owner named. */
export async function runGatewayShutdownSteps(params: {
  steps: readonly GatewayShutdownStep[];
  onError: (message: string) => void;
}): Promise<void> {
  const errors: Error[] = [];
  for (const step of params.steps) {
    try {
      await step.run();
    } catch (error) {
      const message = `shutdown step failed (${step.name}): ${formatErrorMessage(error)}`;
      params.onError(message);
      errors.push(new Error(message, { cause: error }));
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Gateway shutdown did not complete cleanly");
  }
}
