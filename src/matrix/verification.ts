/**
 * Matrix E2EE device verification using SAS (Short Authentication String).
 *
 * This module implements interactive verification so that the bot's device
 * can be verified against a user's main session without manual key exchange.
 */
import type { MatrixClient } from "matrix-js-sdk";
import { CryptoEvent } from "matrix-js-sdk/lib/crypto-api/CryptoEvent.js";
import type {
  EmojiMapping,
  GeneratedSas,
  ShowSasCallbacks,
  VerificationRequest,
  Verifier,
} from "matrix-js-sdk/lib/crypto-api/verification.js";
import { VerifierEvent } from "matrix-js-sdk/lib/crypto-api/verification.js";

import type { RuntimeEnv } from "../runtime.js";

/**
 * SAS emoji representation.
 */
export type SasEmoji = {
  /** Emoji symbol (e.g. "🐶") */
  emoji: string;
  /** Human-readable label (e.g. "Dog") */
  description: string;
};

/**
 * SAS data shown during verification.
 */
export type SasShowData = {
  /** Array of 7 emoji objects for visual comparison */
  emoji?: SasEmoji[];
  /** Array of 3 decimal numbers for numeric comparison */
  decimal?: [number, number, number];
};

/**
 * Result of a verification flow.
 */
export type VerificationResult = {
  success: boolean;
  deviceId?: string;
  userId?: string;
  error?: string;
  cancelled?: boolean;
};

/**
 * Options for the interactive verification flow.
 */
export type VerificationOpts = {
  /** Matrix client (already started with crypto initialized) */
  client: MatrixClient;
  /** Runtime for logging and prompts */
  runtime: RuntimeEnv;
  /** Timeout for waiting for verification request (ms). Default: 120000 (2 min) */
  timeoutMs?: number;
  /** Callback to prompt user for SAS match confirmation */
  confirmSas: (sas: SasShowData) => Promise<boolean>;
  /** Optional abort signal */
  abortSignal?: AbortSignal;
  /** Optional callback when verification request is received */
  onRequest?: (request: VerificationRequest) => void;
  /** Optional callback when SAS is ready to show */
  onSasShow?: (sas: SasShowData) => void;
  /** Optional callback on success */
  onSuccess?: (result: VerificationResult) => void;
  /** Optional callback on error/cancel */
  onError?: (error: string) => void;
};

/**
 * Format SAS data for CLI display.
 */
export function formatSasForDisplay(sas: SasShowData): string {
  const lines: string[] = [];

  if (sas.decimal) {
    lines.push("Decimal codes:");
    lines.push(`  ${sas.decimal.join("  ")}`);
    lines.push("");
  }

  if (sas.emoji && sas.emoji.length > 0) {
    lines.push("Emoji sequence:");
    const emojiLine = sas.emoji.map((e) => e.emoji).join("  ");
    const labelLine = sas.emoji.map((e) => e.description).join(" | ");
    lines.push(`  ${emojiLine}`);
    lines.push(`  (${labelLine})`);
  }

  return lines.join("\n");
}

/**
 * Convert emoji mapping from SDK to our format.
 */
function convertEmojiMappings(mappings: EmojiMapping[]): SasEmoji[] {
  return mappings.map(([emoji, name]) => ({
    emoji,
    description: name,
  }));
}

/**
 * Convert GeneratedSas to our SasShowData format.
 */
function convertGeneratedSas(sas: GeneratedSas): SasShowData {
  return {
    emoji: sas.emoji ? convertEmojiMappings(sas.emoji) : undefined,
    decimal: sas.decimal,
  };
}

/**
 * Wait for and handle an incoming verification request.
 *
 * Flow:
 * 1. User initiates verification from their phone/web client
 * 2. Bot receives m.key.verification.request
 * 3. Bot accepts and waits for SAS exchange
 * 4. User confirms emojis match on both devices
 * 5. MACs are exchanged to complete verification
 */
export async function waitForVerificationRequest(
  opts: VerificationOpts,
): Promise<VerificationResult> {
  const { client, runtime, confirmSas, abortSignal } = opts;
  const timeoutMs = opts.timeoutMs ?? 120_000;

  const crypto = client.getCrypto();
  if (!crypto) {
    throw new Error("Crypto not initialized - call initRustCrypto first");
  }

  return new Promise<VerificationResult>((resolve) => {
    let done = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    let currentSasCallbacks: ShowSasCallbacks | undefined;

    const cleanup = () => {
      if (done) return;
      done = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      client.off(CryptoEvent.VerificationRequestReceived, onRequest);
      abortSignal?.removeEventListener("abort", onAbort);
    };

    const complete = (result: VerificationResult) => {
      cleanup();
      if (result.success) {
        opts.onSuccess?.(result);
      } else if (result.error) {
        opts.onError?.(result.error);
      }
      resolve(result);
    };

    const onAbort = () => {
      if (currentSasCallbacks) {
        currentSasCallbacks.cancel();
      }
      complete({
        success: false,
        cancelled: true,
        error: "Verification aborted",
      });
    };

    const onRequest = async (request: VerificationRequest) => {
      if (done) return;

      const otherUserId = request.otherUserId;
      const otherDeviceId = request.otherDeviceId;

      runtime.log?.(
        `Incoming verification request from ${otherUserId} (device: ${otherDeviceId ?? "unknown"})`,
      );
      opts.onRequest?.(request);

      try {
        // Accept the verification request
        await request.accept();
        runtime.log?.("Request accepted. Starting SAS verification...");

        // Start SAS verification
        const methods = request.methods;
        if (!methods.includes("m.sas.v1")) {
          complete({
            success: false,
            error: `Other device does not support SAS verification. Methods: ${methods.join(", ")}`,
          });
          return;
        }

        // Start the verifier - this initiates the key exchange
        const verifierResult = await request.startVerification("m.sas.v1");
        // startVerification returns the Verifier directly in v39
        const verifier = verifierResult as unknown as Verifier;
        if (!verifier) {
          complete({
            success: false,
            error: "Failed to start SAS verification",
          });
          return;
        }

        // Set up SAS display listener
        const sasPromise = new Promise<ShowSasCallbacks | null>(
          (resolveSas) => {
            let resolved = false;

            const handleShowSas = (sasCallbacks: ShowSasCallbacks) => {
              if (resolved) return;
              resolved = true;
              verifier.off(VerifierEvent.ShowSas, handleShowSas);
              resolveSas(sasCallbacks);
            };

            const handleCancel = () => {
              if (resolved) return;
              resolved = true;
              verifier.off(VerifierEvent.ShowSas, handleShowSas);
              verifier.off(VerifierEvent.Cancel, handleCancel);
              resolveSas(null);
            };

            verifier.on(VerifierEvent.ShowSas, handleShowSas);
            verifier.on(VerifierEvent.Cancel, handleCancel);
          },
        );

        // Wait for SAS to be ready
        const sasCallbacks = await sasPromise;
        if (!sasCallbacks) {
          complete({
            success: false,
            error: "SAS exchange failed or was cancelled",
          });
          return;
        }

        currentSasCallbacks = sasCallbacks;
        const sasData = convertGeneratedSas(sasCallbacks.sas);
        opts.onSasShow?.(sasData);

        // Prompt user to confirm the SAS match
        const confirmed = await confirmSas(sasData);

        if (!confirmed) {
          sasCallbacks.mismatch();
          complete({
            success: false,
            cancelled: true,
            error: "User declined SAS match",
          });
          return;
        }

        // Confirm the match - this exchanges MACs and completes verification
        await sasCallbacks.confirm();

        runtime.log?.("Device verified successfully!");
        complete({
          success: true,
          deviceId: otherDeviceId ?? undefined,
          userId: otherUserId,
        });
      } catch (err) {
        complete({
          success: false,
          error: `Verification failed: ${String(err)}`,
        });
      }
    };

    // Set up listeners
    client.on(CryptoEvent.VerificationRequestReceived, onRequest);
    abortSignal?.addEventListener("abort", onAbort, { once: true });

    // Set timeout
    timeoutHandle = setTimeout(() => {
      complete({
        success: false,
        error: `Verification timeout (${timeoutMs / 1000}s)`,
      });
    }, timeoutMs);

    runtime.log?.(
      `Waiting for verification request (timeout: ${timeoutMs / 1000}s)...`,
    );
    runtime.log?.(
      'Start verification from your other device (e.g., Element: Settings > Security > "Verify this session")',
    );
  });
}

/**
 * Get the verification status of the current device.
 */
export async function getDeviceVerificationStatus(
  client: MatrixClient,
): Promise<{
  deviceId: string | null;
  userId: string | null;
  crossSigningReady: boolean;
  privateKeysInStorage: boolean;
  deviceVerified: boolean;
}> {
  const crypto = client.getCrypto();
  if (!crypto) {
    return {
      deviceId: client.getDeviceId() ?? null,
      userId: client.getUserId() ?? null,
      crossSigningReady: false,
      privateKeysInStorage: false,
      deviceVerified: false,
    };
  }

  const status = await crypto.getCrossSigningStatus();
  const deviceId = client.getDeviceId();
  const userId = client.getUserId();

  // Check if our device is verified via cross-signing
  let deviceVerified = false;
  if (userId && deviceId) {
    try {
      const deviceInfo = await crypto.getDeviceVerificationStatus(
        userId,
        deviceId,
      );
      deviceVerified = deviceInfo?.crossSigningVerified ?? false;
    } catch {
      // Device not found or error
    }
  }

  return {
    deviceId: deviceId ?? null,
    userId: userId ?? null,
    crossSigningReady: status.publicKeysOnDevice,
    privateKeysInStorage: status.privateKeysCachedLocally.masterKey,
    deviceVerified,
  };
}
