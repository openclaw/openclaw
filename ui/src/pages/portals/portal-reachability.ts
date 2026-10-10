const PORTAL_REACHABILITY_TIMEOUT_MS = 4_000;

/**
 * `blocked` means the probe never reached the network: Content Security Policy
 * refused the connection, so the result says nothing about the portal. Frames
 * obey `frame-src`, not `connect-src`, so a blocked probe must never be
 * reported to the operator as an unreachable portal.
 */
export type PortalReachability = "reachable" | "unreachable" | "blocked";

export async function probePortalReachable(url: string): Promise<PortalReachability> {
  const target = URL.parse(url);
  if (!target) {
    return "unreachable";
  }
  let blocked = false;
  const onViolation = (event: Event) => {
    // Keyword blockedURI values ("inline", "eval") never describe this fetch.
    if (URL.parse((event as SecurityPolicyViolationEvent).blockedURI)?.origin === target.origin) {
      blocked = true;
    }
  };
  // Callable outside a DOM (tests, any non-browser import): without a document
  // there is no violation signal, so the probe stays reachable/unreachable.
  const violationTarget = typeof document === "undefined" ? undefined : document;
  violationTarget?.addEventListener("securitypolicyviolation", onViolation);
  try {
    await fetch(url, {
      mode: "no-cors",
      signal: AbortSignal.timeout(PORTAL_REACHABILITY_TIMEOUT_MS),
    });
    return "reachable";
  } catch {
    // The violation event and the fetch rejection race; let the event land.
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    return blocked ? "blocked" : "unreachable";
  } finally {
    violationTarget?.removeEventListener("securitypolicyviolation", onViolation);
  }
}
