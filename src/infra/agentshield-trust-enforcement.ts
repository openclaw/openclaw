import { loadKeyring, verifyWithKeyring, isKeyAuthorized } from "./agentshield-keyring.js";
import {
  isPublisherRevoked,
  isTrustCardRevoked,
  isSkillAttestationRevoked,
  loadRevocations,
} from "./agentshield-revocations.js";
import {
  getTrustEnforcementConfig,
  type TrustEnforcementConfig,
} from "./agentshield-trust-config.js";

/**
 * AgentShield Trust Enforcement
 *
 * Combines revocation checks and keyring verification into a single
 * enforcement decision for tool calls.
 *
 * Enforcement modes:
 * - require_keyring: Signing pubkey must be in publisher keyring (active/retired)
 * - require_not_revoked: Publisher/artifact must not be in revocation list
 *
 * Results:
 * - ALLOW: Trust checks pass
 * - BLOCK: Trust checks fail, tool call should be blocked
 * - WARN: Trust checks have warnings but not blocking
 */

export type TrustEnforcementResult = {
  action: "allow" | "block" | "warn";
  reason: string;
  details: TrustEnforcementDetails;
};

export type TrustEnforcementDetails = {
  enabled: boolean;
  revocationChecked: boolean;
  keyringChecked: boolean;
  publisherRevoked: boolean;
  artifactRevoked: boolean;
  keyringValid: boolean;
  revocationReason: string | null;
  keyringReason: string | null;
  keyId: string | null;
  config: {
    requireKeyring: boolean;
    requireNotRevoked: boolean;
    trustRoot: string | null;
  };
};

export type TrustCheckInput = {
  /** Publisher ID to check revocation and keyring */
  publisherId?: string;
  /** Artifact content SHA256 to check revocation */
  contentSha256?: string;
  /** Trust card ID to check revocation */
  trustCardId?: string;
  /** Signed object to verify against keyring */
  signedObject?: {
    payload: unknown;
    signature: string;
    public_key: string;
  };
  /** Expected type for signed object verification */
  expectedType?: string;
  /** Public key hex to check against keyring (alternative to signedObject) */
  signerPubkey?: string;
};

function createEmptyDetails(config: TrustEnforcementConfig): TrustEnforcementDetails {
  return {
    enabled: config.enabled,
    revocationChecked: false,
    keyringChecked: false,
    publisherRevoked: false,
    artifactRevoked: false,
    keyringValid: true,
    revocationReason: null,
    keyringReason: null,
    keyId: null,
    config: {
      requireKeyring: config.requireKeyring,
      requireNotRevoked: config.requireNotRevoked,
      trustRoot: config.trustRoot,
    },
  };
}

/**
 * Enforce trust policy on a tool call or artifact.
 *
 * Performs the following checks based on configuration:
 * 1. Publisher revocation (if publisherId provided)
 * 2. Artifact revocation (if contentSha256 or trustCardId provided)
 * 3. Keyring verification (if signedObject or signerPubkey provided)
 */
export function enforceTrust(input: TrustCheckInput): TrustEnforcementResult {
  const config = getTrustEnforcementConfig();
  const details = createEmptyDetails(config);

  // If trust enforcement is not enabled, allow everything
  if (!config.enabled) {
    return {
      action: "allow",
      reason: "trust enforcement not enabled",
      details,
    };
  }

  const failures: string[] = [];
  const warnings: string[] = [];

  // ── Revocation checks ──

  // Check publisher revocation
  if (input.publisherId && config.revocationsFile) {
    details.revocationChecked = true;
    const pubRevoked = isPublisherRevoked(input.publisherId);
    if (pubRevoked.revoked) {
      details.publisherRevoked = true;
      details.revocationReason = pubRevoked.reason ?? "publisher revoked";
      if (config.requireNotRevoked) {
        failures.push(`publisher '${input.publisherId}' is revoked: ${pubRevoked.reason}`);
      } else {
        warnings.push(`publisher '${input.publisherId}' is revoked: ${pubRevoked.reason}`);
      }
    }
  }

  // Check artifact revocation (by content SHA256)
  if (input.contentSha256 && config.revocationsFile) {
    details.revocationChecked = true;
    const artifactRevoked = isSkillAttestationRevoked(input.contentSha256);
    if (artifactRevoked.revoked) {
      details.artifactRevoked = true;
      details.revocationReason = artifactRevoked.reason ?? "artifact revoked";
      if (config.requireNotRevoked) {
        failures.push(`artifact is revoked: ${artifactRevoked.reason}`);
      } else {
        warnings.push(`artifact is revoked: ${artifactRevoked.reason}`);
      }
    }
  }

  // Check trust card revocation
  if (input.trustCardId && config.revocationsFile) {
    details.revocationChecked = true;
    const cardRevoked = isTrustCardRevoked(input.trustCardId);
    if (cardRevoked.revoked) {
      details.artifactRevoked = true;
      details.revocationReason = cardRevoked.reason ?? "trust card revoked";
      if (config.requireNotRevoked) {
        failures.push(`trust card is revoked: ${cardRevoked.reason}`);
      } else {
        warnings.push(`trust card is revoked: ${cardRevoked.reason}`);
      }
    }
  }

  // ── Keyring checks ──

  // Verify signed object against keyring
  if (input.signedObject && input.publisherId && config.requireKeyring) {
    details.keyringChecked = true;
    const expectedType = input.expectedType ?? "agentshield.trust_card";
    const result = verifyWithKeyring(input.signedObject, expectedType, input.publisherId);

    if (!result.ok) {
      details.keyringValid = false;
      details.keyringReason = result.reason;
      failures.push(`keyring verification failed: ${result.reason}`);
    } else {
      details.keyId = result.keyId;
    }
  }

  // Alternative: check pubkey directly against keyring
  if (input.signerPubkey && input.publisherId && config.requireKeyring && !input.signedObject) {
    details.keyringChecked = true;
    const result = isKeyAuthorized(input.publisherId, input.signerPubkey);

    if (!result.authorized) {
      details.keyringValid = false;
      details.keyringReason =
        result.status === "revoked"
          ? `key '${result.keyId}' is revoked`
          : "signing key not found in keyring";
      failures.push(`keyring check failed: ${details.keyringReason}`);
    } else {
      details.keyId = result.keyId;
    }
  }

  // ── Final decision ──

  if (failures.length > 0) {
    return {
      action: "block",
      reason: failures.join("; "),
      details,
    };
  }

  if (warnings.length > 0) {
    return {
      action: "warn",
      reason: warnings.join("; "),
      details,
    };
  }

  return {
    action: "allow",
    reason: "trust checks passed",
    details,
  };
}

/**
 * Quick check: is trust enforcement enabled?
 */
export function isTrustEnforcementEnabled(): boolean {
  return getTrustEnforcementConfig().enabled;
}

/**
 * Check if revocations file is available and verified.
 */
export function getRevocationsStatus(): {
  available: boolean;
  verified: boolean;
  error: string | null;
} {
  const config = getTrustEnforcementConfig();
  if (!config.revocationsFile) {
    return { available: false, verified: false, error: "no revocations file configured" };
  }

  const { data, verified, error } = loadRevocations();
  return {
    available: data !== null,
    verified,
    error,
  };
}

/**
 * Check keyring status for a publisher.
 */
export function getKeyringStatus(publisherId: string): {
  available: boolean;
  verified: boolean;
  error: string | null;
  activeKeyCount: number;
} {
  const { keyring, verified, error } = loadKeyring(publisherId);
  if (!keyring) {
    return { available: false, verified: false, error, activeKeyCount: 0 };
  }

  const activeKeys = (keyring.keys ?? []).filter((k) => k.status === "active");
  return {
    available: true,
    verified,
    error,
    activeKeyCount: activeKeys.length,
  };
}

/**
 * Perform all trust checks and return a summary suitable for logging/incidents.
 */
export function runTrustChecks(input: TrustCheckInput): {
  result: TrustEnforcementResult;
  revocationsStatus: ReturnType<typeof getRevocationsStatus>;
  keyringStatus: ReturnType<typeof getKeyringStatus> | null;
} {
  const result = enforceTrust(input);
  const revocationsStatus = getRevocationsStatus();
  const keyringStatus = input.publisherId ? getKeyringStatus(input.publisherId) : null;

  return {
    result,
    revocationsStatus,
    keyringStatus,
  };
}

/**
 * Export config getter for testing.
 */
export { getTrustEnforcementConfig };
