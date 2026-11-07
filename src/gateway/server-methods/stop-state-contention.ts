import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolveStateContentionPresentation } from "../../sessions/session-run-error-presentation.js";
import type { RespondFn } from "./types.js";

/** Shared by every Stop route so contention keeps one typed, uncertainty-preserving outcome. */
export async function withStopStateContention(
  respond: RespondFn,
  stop: () => Promise<void>,
): Promise<void> {
  try {
    await stop();
  } catch (error) {
    const contention = resolveStateContentionPresentation(error);
    if (!contention) {
      throw error;
    }
    // A session read can fail even though cancellation takes effect. Do not
    // replay Stop or claim it had no effect; preserve uncertainty at the RPC boundary.
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.UNAVAILABLE,
        "The server is busy. Check this turn's status before trying Stop again.\n\n" +
          "SQLite transaction admission remained busy. Stopping may already have taken effect.",
        { details: { errorKind: contention.errorKind } },
      ),
    );
  }
}
