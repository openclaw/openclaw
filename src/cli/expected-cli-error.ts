import type { CronCliJobMatch } from "./cron-cli/cron-cli-error.js";

// Bootstrap argument parsers use this module; keep runtime dependencies out.
export class ExpectedCliError extends Error {
  readonly humanOutput: string;
  readonly humanOutputWritten: boolean;
  readonly machineOutput: string;
  readonly matches?: readonly CronCliJobMatch[];

  constructor(params: {
    message: string;
    humanOutput: string;
    humanOutputWritten?: boolean;
    machineOutput: string;
    matches?: readonly CronCliJobMatch[];
    cause?: unknown;
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = "ExpectedCliError";
    this.humanOutput = params.humanOutput;
    this.humanOutputWritten = params.humanOutputWritten ?? false;
    this.machineOutput = params.machineOutput;
    this.matches = params.matches;
  }
}

export function throwExpectedCliError(message: string): never {
  throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
}
