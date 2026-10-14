/**
 * Direct-DM pre-crypto guard policy.
 *
 * Defines conservative shape, size, timestamp, and rate limits before decryption work starts.
 */
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";

/** Runtime limits applied before direct-DM encrypted payloads are decrypted. */
export type DirectDmPreCryptoGuardPolicy = {
  /** Accepted encrypted event kinds before decryption, e.g. Nostr kind 4. */
  allowedKinds: readonly number[];
  /** Maximum sender timestamp skew allowed into the future. */
  maxFutureSkewSec: number;
  /** Maximum encrypted payload bytes accepted before decrypt work starts. */
  maxCiphertextBytes: number;
  /** Maximum decrypted plaintext bytes accepted after decrypt succeeds. */
  maxPlaintextBytes: number;
  /** Per-sender and global throttles for encrypted DM ingress. */
  rateLimit: {
    /** Fixed rate-limit window size. */
    windowMs: number;
    /** Maximum messages per sender key inside one window. */
    maxPerSenderPerWindow: number;
    /** Maximum messages across all sender keys inside one window. */
    maxGlobalPerWindow: number;
    /** Maximum sender keys retained by the in-memory limiter. */
    maxTrackedSenderKeys: number;
  };
};

/** Partial overrides for channel plugins that need stricter pre-crypto limits. */
export type DirectDmPreCryptoGuardPolicyOverrides = Partial<
  Omit<DirectDmPreCryptoGuardPolicy, "rateLimit">
> & {
  rateLimit?: Partial<DirectDmPreCryptoGuardPolicy["rateLimit"]>;
};

/** Builds the shared policy object for DM-style pre-crypto guardrails. */
export function createDirectDmPreCryptoGuardPolicy(
  overrides: DirectDmPreCryptoGuardPolicyOverrides = {},
): DirectDmPreCryptoGuardPolicy {
  return {
    allowedKinds: overrides.allowedKinds ?? [4],
    maxFutureSkewSec: resolveIntegerOption(overrides.maxFutureSkewSec, 120, { min: 0 }),
    maxCiphertextBytes: resolveIntegerOption(overrides.maxCiphertextBytes, 16 * 1024, { min: 1 }),
    maxPlaintextBytes: resolveIntegerOption(overrides.maxPlaintextBytes, 8 * 1024, { min: 1 }),
    rateLimit: {
      windowMs: resolveIntegerOption(overrides.rateLimit?.windowMs, 60_000, { min: 1 }),
      maxPerSenderPerWindow: resolveIntegerOption(overrides.rateLimit?.maxPerSenderPerWindow, 20, {
        min: 1,
      }),
      maxGlobalPerWindow: resolveIntegerOption(overrides.rateLimit?.maxGlobalPerWindow, 200, {
        min: 1,
      }),
      maxTrackedSenderKeys: resolveIntegerOption(overrides.rateLimit?.maxTrackedSenderKeys, 4096, {
        min: 1,
      }),
    },
  };
}
