import type { RouterConfig } from "../config/types.agent-defaults.js";
import type { RouterSignals } from "./signals.js";

export class EscalationPolicy {
  constructor(private config: RouterConfig) {}

  shouldEscalate(signals: RouterSignals): boolean {
    if (!this.config.enabled) {
      return false;
    }

    const { maxRetries, maxToolCalls, maxContextGrowth, errorPatterns } =
      this.config.escalation.signals;

    if (maxRetries !== undefined && signals.retryCount > maxRetries) {
      return true;
    }

    if (maxToolCalls !== undefined && signals.toolCallCount > maxToolCalls) {
      return true;
    }

    if (maxContextGrowth !== undefined && signals.contextGrowth > maxContextGrowth) {
      return true;
    }

    if (errorPatterns && errorPatterns.length > 0) {
      const hasMatchingError = signals.errors.some((error) =>
        errorPatterns.some((pattern) => error.toLowerCase().includes(pattern.toLowerCase())),
      );
      if (hasMatchingError) {
        return true;
      }
    }

    return false;
  }
}
