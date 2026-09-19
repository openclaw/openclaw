import { UPDATE_ACTIVATION_TIMEOUT_REASON } from "../../shared/update-outcome.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";

export class UpdateActivationTimeoutError extends UpdateCommandRecoveryPendingError {
  readonly reason = UPDATE_ACTIVATION_TIMEOUT_REASON;
  constructor(
    readonly root: string,
    readonly timeoutMs: number,
  ) {
    super(`Update activation exceeded its ${timeoutMs / 1000}-second budget.`);
    this.name = "UpdateActivationTimeoutError";
  }
}
