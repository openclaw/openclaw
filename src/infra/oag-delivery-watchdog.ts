/**
 * OAG Delivery Watchdog - Monitors message delivery failures
 *
 * Subscribes to message:sent hook, detects delivery errors (like message too long),
 * and triggers OAG anomaly_detected event.
 */

import type { OpenClawConfig } from "../config/config.js";
import {
  registerInternalHook,
  unregisterInternalHook,
  type InternalHookHandler,
} from "../hooks/internal-hooks.js";
import { isMessageSentEvent } from "../hooks/internal-hooks.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { emitOagEvent } from "./oag-event-bus.js";

const log = createSubsystemLogger("oag/delivery-watchdog");

// Default text limits per channel (based on platform API limits)
// Source: src/channels/dock.ts and src/infra/outbound/deliver.ts
const DEFAULT_CHANNEL_TEXT_LIMITS: Record<string, number> = {
  telegram: 4096, // Telegram Bot API limit
  discord: 2000, // Discord message limit
  slack: 4000, // Slack message limit
  whatsapp: 4000, // WhatsApp Business API limit
  signal: 4000, // Signal message limit
  imessage: 4000, // iMessage limit
  irc: 350, // IRC message limit
  line: 5000, // LINE message limit
  web: 4000, // Web chat default
};

// Known delivery failure patterns
const DEFAULT_DELIVERY_FAILURE_PATTERNS: readonly RegExp[] = [
  /message is too long/i,
  /message too long/i,
  /\b400\b.*bad request/i,
  /chat not found/i,
  /bot was blocked/i,
  /forbidden/i,
  /user not found/i,
  /recipient is not a valid/i,
];

// Recoverable errors (should not trigger anomaly alert)
const RECOVERABLE_PATTERNS: readonly RegExp[] = [
  /timeout/i,
  /temporarily unavailable/i,
  /rate limit/i,
];

export interface DeliveryWatchdogConfig {
  enabled: boolean;
  channelTextLimits: Record<string, number>;
  additionalErrorPatterns: RegExp[];
}

/**
 * Resolve the delivery watchdog configuration from OpenClaw config.
 */
export function resolveDeliveryWatchdogConfig(cfg?: OpenClawConfig): DeliveryWatchdogConfig {
  const watchdogConfig = cfg?.gateway?.oag?.watchdog;

  const additionalPatterns = (watchdogConfig?.additionalErrorPatterns ?? []).map(
    (pattern) => new RegExp(pattern, "i"),
  );

  return {
    enabled: watchdogConfig?.enabled ?? true,
    channelTextLimits: {
      ...DEFAULT_CHANNEL_TEXT_LIMITS,
      ...watchdogConfig?.channelTextLimits,
    },
    additionalErrorPatterns: additionalPatterns,
  };
}

/**
 * Check if an error indicates message too long for the given channel.
 */
function checkMessageTooLong(
  error: string,
  channel: string,
  config: DeliveryWatchdogConfig,
): { isTooLong: boolean; limit: number; actual?: number } {
  const limit = config.channelTextLimits[channel] ?? 4000;

  // Check if error explicitly mentions "too long"
  if (/message is too long|message too long/i.test(error)) {
    return { isTooLong: true, limit };
  }

  return { isTooLong: false, limit };
}

let currentConfig: DeliveryWatchdogConfig = {
  enabled: true,
  channelTextLimits: DEFAULT_CHANNEL_TEXT_LIMITS,
  additionalErrorPatterns: [],
};

let currentHandler: InternalHookHandler | null = null;

/**
 * Reset the watchdog state (for testing).
 * @internal
 */
export function resetDeliveryWatchdog(): void {
  if (currentHandler) {
    unregisterInternalHook("message:sent", currentHandler);
    currentHandler = null;
  }
  currentConfig = {
    enabled: true,
    channelTextLimits: { ...DEFAULT_CHANNEL_TEXT_LIMITS },
    additionalErrorPatterns: [],
  };
}

/**
 * Start the Delivery Watchdog
 *
 * @param config Optional partial config override
 * @returns Cleanup function to stop the watchdog
 */
export function startDeliveryWatchdog(config?: Partial<DeliveryWatchdogConfig>): () => void {
  // Deep merge channelTextLimits
  currentConfig = {
    ...currentConfig,
    ...config,
    channelTextLimits: {
      ...currentConfig.channelTextLimits,
      ...config?.channelTextLimits,
    },
    additionalErrorPatterns:
      config?.additionalErrorPatterns ?? currentConfig.additionalErrorPatterns,
  };

  if (!currentConfig.enabled) {
    log.info("Delivery watchdog disabled by config");
    return () => {};
  }

  // Combine default and additional error patterns
  const allFailurePatterns = [
    ...DEFAULT_DELIVERY_FAILURE_PATTERNS,
    ...currentConfig.additionalErrorPatterns,
  ];

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
    const channel = context.channelId || "unknown";

    // Ignore recoverable errors
    if (RECOVERABLE_PATTERNS.some((p) => p.test(error))) {
      log.debug(`Ignored recoverable delivery error on ${channel}: ${error}`);
      return;
    }

    // Check for known delivery failure patterns
    const isKnownFailure = allFailurePatterns.some((p) => p.test(error));

    if (isKnownFailure) {
      // Special handling for "message too long"
      const tooLongCheck = checkMessageTooLong(error, channel, currentConfig);

      log.warn(`Delivery failure detected on ${channel}: ${error}`);

      emitOagEvent("anomaly_detected", {
        type: "delivery_failure",
        subtype: tooLongCheck.isTooLong ? "message_too_long" : "delivery_error",
        channel,
        error,
        to: context.to,
        isGroup: context.isGroup,
        severity: "warning",
        timestamp: Date.now(),
        // Include limit info for "too long" errors
        ...(tooLongCheck.isTooLong && {
          suggestion: {
            action: "truncate_or_split",
            channelLimit: tooLongCheck.limit,
          },
        }),
      });
    }
  };

  currentHandler = handler;
  registerInternalHook("message:sent", handler);

  log.info("Delivery watchdog started", {
    channelsConfigured: Object.keys(currentConfig.channelTextLimits).length,
  });

  // Return cleanup function
  return () => {
    if (currentHandler) {
      unregisterInternalHook("message:sent", currentHandler);
      currentHandler = null;
    }
    log.info("Delivery watchdog stopped");
  };
}

/**
 * Update Delivery Watchdog configuration at runtime.
 */
export function updateDeliveryWatchdogConfig(config: Partial<DeliveryWatchdogConfig>): void {
  currentConfig = { ...currentConfig, ...config };
  log.info("Delivery watchdog config updated");
}

/**
 * Get the current channel text limits (for diagnostics).
 */
export function getChannelTextLimits(): Record<string, number> {
  return { ...currentConfig.channelTextLimits };
}

/**
 * Get the default channel text limits (for reference).
 */
export function getDefaultChannelTextLimits(): Record<string, number> {
  return { ...DEFAULT_CHANNEL_TEXT_LIMITS };
}
