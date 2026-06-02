import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";

export type DirectDmPreCryptoGuardPolicy = {
  /** Provider message kinds accepted before decrypted content is available. */
  allowedKinds: readonly number[];
  /** Maximum future timestamp skew accepted before rejecting a message. */
  maxFutureSkewSec: number;
  /** Maximum encrypted payload bytes accepted before crypto work starts. */
  maxCiphertextBytes: number;
  /** Maximum decrypted plaintext bytes accepted after crypto succeeds. */
  maxPlaintextBytes: number;
  /** Per-sender and global limits applied before expensive crypto/decode work. */
  rateLimit: {
    windowMs: number;
    maxPerSenderPerWindow: number;
    maxGlobalPerWindow: number;
    maxTrackedSenderKeys: number;
  };
};

export type DirectDmPreCryptoGuardPolicyOverrides = Partial<
  Omit<DirectDmPreCryptoGuardPolicy, "rateLimit">
> & {
  rateLimit?: Partial<DirectDmPreCryptoGuardPolicy["rateLimit"]>;
};

/** Shared policy object for DM-style pre-crypto guardrails. */
export function createDirectDmPreCryptoGuardPolicy(
  overrides: DirectDmPreCryptoGuardPolicyOverrides = {},
): DirectDmPreCryptoGuardPolicy {
  const defaultMaxFutureSkewSec = 120;
  const defaultMaxCiphertextBytes = 16 * 1024;
  const defaultMaxPlaintextBytes = 8 * 1024;
  const defaultWindowMs = 60_000;
  const defaultMaxPerSenderPerWindow = 20;
  const defaultMaxGlobalPerWindow = 200;
  const defaultMaxTrackedSenderKeys = 4096;
  return {
    allowedKinds: overrides.allowedKinds ?? [4],
    maxFutureSkewSec: resolveIntegerOption(overrides.maxFutureSkewSec, defaultMaxFutureSkewSec, {
      min: 0,
    }),
    maxCiphertextBytes: resolveIntegerOption(
      overrides.maxCiphertextBytes,
      defaultMaxCiphertextBytes,
      { min: 1 },
    ),
    maxPlaintextBytes: resolveIntegerOption(overrides.maxPlaintextBytes, defaultMaxPlaintextBytes, {
      min: 1,
    }),
    rateLimit: {
      windowMs: resolveIntegerOption(overrides.rateLimit?.windowMs, defaultWindowMs, { min: 1 }),
      maxPerSenderPerWindow: resolveIntegerOption(
        overrides.rateLimit?.maxPerSenderPerWindow,
        defaultMaxPerSenderPerWindow,
        { min: 1 },
      ),
      maxGlobalPerWindow: resolveIntegerOption(
        overrides.rateLimit?.maxGlobalPerWindow,
        defaultMaxGlobalPerWindow,
        { min: 1 },
      ),
      maxTrackedSenderKeys: resolveIntegerOption(
        overrides.rateLimit?.maxTrackedSenderKeys,
        defaultMaxTrackedSenderKeys,
        { min: 1 },
      ),
    },
  };
}
