import type { SsrFPolicy } from "./ssrf.js";

// Host-granted exemptions are keyed by policy identity instead of a policy field so
// the Plugin SDK SsrFPolicy contract (including the infra-runtime star export)
// cannot express them. Only host code holding this module can mark a policy.
const unspecifiedIpv4ExemptPolicies = new WeakSet<SsrFPolicy>();

/**
 * Copy a policy whose trusted hostname may resolve into nonzero IPv4 0.0.0.0/8,
 * where container runtimes such as OrbStack place host.docker.internal.
 */
export function withTrustedHostUnspecifiedIpv4Exemption(policy: SsrFPolicy): SsrFPolicy {
  const exempt = { ...policy };
  unspecifiedIpv4ExemptPolicies.add(exempt);
  return exempt;
}

export function hasTrustedHostUnspecifiedIpv4Exemption(policy: SsrFPolicy | undefined): boolean {
  return policy !== undefined && unspecifiedIpv4ExemptPolicies.has(policy);
}
