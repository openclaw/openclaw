/**
 * Credential Access Detector - Runtime Singleton
 *
 * Thin wrapper around getCredentialAccessDetector() for production use.
 * Import this module wherever you need to record credential access events.
 */

import type { CredentialAccessDetector } from "./anomaly-detection.js";
import { getCredentialAccessDetector, resetAnomalyDetectors } from "./anomaly-detection.js";

let instance: CredentialAccessDetector | null = null;

/**
 * Get the singleton CredentialAccessDetector instance.
 * Lazily initialized with production-safe defaults on first call.
 */
export function credentialDetector(): CredentialAccessDetector {
  if (!instance) {
    instance = getCredentialAccessDetector({
      enabled: true,
      sensitivity: 2.5,
      minDataPoints: 5,
      windowSize: 100,
    });
  }
  return instance;
}

/**
 * Flush the credential detector's pending buckets.
 * Safe to call on shutdown — resolves within 1.5s, never throws.
 */
export async function flushCredentialDetector(): Promise<void> {
  if (!instance) {
    return;
  }
  try {
    await Promise.race([
      Promise.resolve(instance.flush()),
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("credential detector flush timeout")), 1500),
      ),
    ]);
  } catch {
    // Swallow: shutdown must proceed regardless.
  }
}

/**
 * Reset the runtime singleton (for testing only).
 */
export function resetCredentialDetectorRuntime(): void {
  instance = null;
  resetAnomalyDetectors();
}
