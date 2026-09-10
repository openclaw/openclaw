import { enableConsoleCapture, routeLogsToStderr } from "../logging/console.js";
import type { SupervisedOperationOutcome } from "./supervised-operation.types.js";

/** Stdout carries one receipt, never a display transcript. */
export async function writeSupervisedReviewOutcome(
  run: () => Promise<SupervisedOperationOutcome>,
): Promise<void> {
  // Keep routing in force through runtime disposal and process shutdown too.
  routeLogsToStderr();
  enableConsoleCapture();
  process.stdout.write(JSON.stringify(await run()));
}
