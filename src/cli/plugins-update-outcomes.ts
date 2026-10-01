import { theme } from "../../packages/terminal-core/src/theme.js";
import { isClawHubTrustSkippedOutcome, type PluginUpdateOutcome } from "../plugins/update.js";

/** Log update outcomes with severity styling and report whether any errors occurred. */
export function logPluginUpdateOutcomes(params: {
  outcomes: readonly Pick<PluginUpdateOutcome, "status" | "message" | "channelFallback" | "code">[];
  log: (message: string) => void;
  error: (message: string) => void;
}): { hasErrors: boolean } {
  let hasErrors = false;
  for (const outcome of params.outcomes) {
    if (outcome.status === "error") {
      hasErrors = true;
      params.error(theme.error(outcome.message));
    } else if (outcome.status === "skipped") {
      if (isClawHubTrustSkippedOutcome(outcome)) {
        hasErrors = true;
      }
      params.log(theme.warn(outcome.message));
    } else {
      params.log(outcome.message);
    }
    if (outcome.channelFallback) {
      params.log(theme.warn(outcome.channelFallback.message));
    }
  }
  return { hasErrors };
}
