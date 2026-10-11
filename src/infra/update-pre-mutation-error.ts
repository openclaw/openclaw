import type { UpdateRecoveryStep } from "../shared/update-outcome.js";
import { normalizeUpdateFailureFacts, type UpdateFailureFact } from "./update-failure-facts.js";
import type { UpdateStepResult } from "./update-step-result.js";

type PreMutationStepResult = {
  steps: UpdateStepResult[];
  failedStep?: UpdateStepResult;
};

export class UpdatePreMutationError<Reason extends string = string> extends Error {
  readonly origin?: "candidate-admission";
  readonly nextAction?: string;
  readonly recoverySteps?: readonly UpdateRecoveryStep[];
  readonly failureFacts: UpdateFailureFact[];
  readonly #stepResult?: PreMutationStepResult;

  get stepResult(): PreMutationStepResult | undefined {
    return this.#stepResult;
  }

  constructor(
    readonly reason: Reason,
    message: string,
    options?: ErrorOptions & {
      failureFacts?: readonly UpdateFailureFact[];
      stepResult?: PreMutationStepResult;
      recoverySteps?: readonly UpdateRecoveryStep[];
      origin?: "candidate-admission";
      nextAction?: string;
    },
  ) {
    super(message, options);
    this.name = "UpdatePreMutationError";
    this.origin = options?.origin;
    this.nextAction = options?.nextAction;
    this.recoverySteps = options?.recoverySteps;
    // Completed attempts are diagnostics, never recovery authority or enumerable error output.
    this.#stepResult = options?.stepResult
      ? { steps: options.stepResult.steps, failedStep: options.stepResult.failedStep }
      : undefined;
    this.failureFacts = normalizeUpdateFailureFacts(
      options?.failureFacts ?? [{ check: reason, code: reason, message }],
    );
  }
}
