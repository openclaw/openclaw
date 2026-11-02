// Policy identity keeps this host-only grant out of the public SsrFPolicy shape.
// Do not import ssrf.ts here: it consumes this marker.
const podmanGatewayLinkLocalExemptPolicies = new WeakSet<object>();

/** The caller must scope this copy to the exact configured Podman origin. */
export function withTrustedHostPodmanGatewayLinkLocalExemption<T extends object>(policy: T): T {
  const exempt = { ...policy };
  podmanGatewayLinkLocalExemptPolicies.add(exempt);
  return exempt;
}

export function hasTrustedHostPodmanGatewayLinkLocalExemption(policy: object | undefined): boolean {
  return policy !== undefined && podmanGatewayLinkLocalExemptPolicies.has(policy);
}
