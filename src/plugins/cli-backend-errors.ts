/**
 * A selected auth profile could not be staged by its CLI backend.
 * Backends must not use this for local preparation or transport failures:
 * core treats it as evidence that the exact profile should be quarantined.
 */
export class CliBackendAuthProfilePreparationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "CliBackendAuthProfilePreparationError";
  }
}

/** Native process/protocol facts only; never an auth or retry-policy signal. */
export class CliBackendTransportError extends Error {
  readonly cliBackendTransportError = "v1";
  constructor(
    message: string,
    readonly diagnostic:
      | {
          kind: "exit";
          exitCode: number | null;
          signal: NodeJS.Signals | null;
          processStderr?: {
            received: boolean;
            complete: boolean;
            crashBanner: boolean;
            outOfMemoryBanner: boolean;
          };
        }
      | { kind: "initialize" | "protocol" },
  ) {
    // Preserve the existing Error name/message used by unrelated policy readers.
    super(message);
  }

  /** Process-wide observations, never a turn attribution or failure cause. */
  withProcessStderr(observation: {
    received: boolean;
    complete: boolean;
    crashBanner: boolean;
    outOfMemoryBanner: boolean;
  }): CliBackendTransportError {
    if (this.diagnostic.kind !== "exit") {
      return this;
    }
    return new CliBackendTransportError(this.message, {
      ...this.diagnostic,
      processStderr: Object.freeze({
        received: observation.received,
        complete: observation.complete,
        crashBanner: observation.crashBanner,
        outOfMemoryBanner: observation.outOfMemoryBanner,
      }),
    });
  }
}
