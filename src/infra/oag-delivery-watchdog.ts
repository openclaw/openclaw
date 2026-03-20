/**
 * OAG Delivery Watchdog - Monitors message delivery failures
 *
 * Subscribes to message:sent hook, detects delivery errors (like message too long),
 * and triggers OAG anomaly_detected event.
 */

import {
  registerInternalHook,
  unregisterInternalHook,
  type InternalHookHandler,
} from "../hooks/internal-hooks.js";
import { isMessageSentEvent } from "../hooks/internal-hooks.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { emitOagEvent } from "./oag-event-bus.js";

const log = createSubsystemLogger("oag/delivery-watchdog");

// Known delivery failure patterns
const DELIVERY_FAILURE_PATTERNS: readonly RegExp[] = [
  /message is too long/i,
  /message too long/i,
  /\b400\b.*bad request/i,
  /chat not found/i,
  /bot was blocked/i,
  /forbidden/i,
];

// Recoverable errors (should not trigger anomaly alert)
const RECOVERABLE_PATTERNS: readonly RegExp[] = [/timeout/i, /temporarily unavailable/i];

export interface DeliveryWatchdogConfig {
  enabled: boolean;
}

const DEFAULT_CONFIG: DeliveryWatchdogConfig = {
  enabled: true,
};

let currentConfig = DEFAULT_CONFIG;

/**
 * Start the Delivery Watchdog
 *
 * @returns Cleanup function to stop the watchdog
 */
export function startDeliveryWatchdog(config?: Partial<DeliveryWatchdogConfig>): () => void {
  currentConfig = { ...DEFAULT_CONFIG, ...config };

  if (!currentConfig.enabled) {
    log.info("Delivery watchdog disabled by config");
    return () => {};
  }

  const handler: InternalHookHandler = (event) => {
    if (!isMessageSentEvent(event)) {
      return;
    }

    const { context } = event;

    // Only process failed deliveries
    if (context.success) {
      return;
    }

    const error = context.error || "";

    // Ignore recoverable errors
    if (RECOVERABLE_PATTERNS.some((p) => p.test(error))) {
      log.debug(`Ignored recoverable delivery error: ${error}`);
      return;
    }

    // Check for known delivery failure patterns
    const isKnownFailure = DELIVERY_FAILURE_PATTERNS.some((p) => p.test(error));

    if (isKnownFailure) {
      log.warn(`Delivery failure detected: ${error}`);

      emitOagEvent("anomaly_detected", {
        type: "delivery_failure",
        channel: context.channelId,
        error,
        to: context.to,
        isGroup: context.isGroup,
        severity: "warning",
        timestamp: Date.now(),
      });
    }
  };

  registerInternalHook("message:sent", handler);

  log.info("Delivery watchdog started");

  // Return cleanup function
  return () => {
    unregisterInternalHook("message:sent", handler);
    log.info("Delivery watchdog stopped");
  };
}

/**
 * Update Delivery Watchdog configuration
 */
export function updateDeliveryWatchdogConfig(config: Partial<DeliveryWatchdogConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}
