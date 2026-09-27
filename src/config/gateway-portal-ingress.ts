import { isIP } from "node:net";

/** Validate a bare DNS suffix with room for a random per-portal hostname label. */
export function isValidPortalIngressDomain(domain: string): boolean {
  try {
    if (new URL(`https://portal.${domain}`).hostname !== `portal.${domain.toLowerCase()}`) {
      return false;
    }
  } catch {
    return false;
  }
  return (
    domain.length <= 220 &&
    domain.includes(".") &&
    isIP(domain) === 0 &&
    domain.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu.test(label))
  );
}

/** Reject a portal namespace containing a known Gateway/Control UI hostname. */
export function portalIngressConflictsWithOrigin(domain: string, origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    const suffix = domain.toLowerCase();
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  } catch {
    return false;
  }
}
