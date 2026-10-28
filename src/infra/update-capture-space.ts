import { collectErrorGraphCandidates } from "./errors.js";

type UpdateCaptureSpace = {
  requiredBytes: number;
  availableBytes: number;
};

/** Capture refusal is distinct from update failure; its caller decides whether to continue. */
export class UpdateCaptureSpaceError extends Error {
  constructor(
    message: string,
    readonly capacity: UpdateCaptureSpace,
  ) {
    super(message);
    this.name = "UpdateCaptureSpaceError";
  }
}

export function findUpdateCaptureSpaceError(error: unknown): UpdateCaptureSpaceError | undefined {
  return collectErrorGraphCandidates(error, (current) => [current.cause]).find(
    (candidate): candidate is UpdateCaptureSpaceError =>
      candidate instanceof UpdateCaptureSpaceError,
  );
}
