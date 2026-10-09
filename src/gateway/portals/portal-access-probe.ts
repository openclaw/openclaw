import type { PortalInspectResult } from "../../../packages/gateway-protocol/src/index.js";

const PORTAL_ACCESS_PROBE_TIMEOUT_MS = 4_000;

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

export function isCloudflareAccessLoginRedirect(sourceUrl: string, location: string): boolean {
  const source = URL.parse(sourceUrl);
  const destination = URL.parse(location, sourceUrl);
  if (!source || !destination || !destination.pathname.startsWith("/cdn-cgi/access/login")) {
    return false;
  }
  return (
    destination.origin === source.origin ||
    destination.hostname.toLowerCase().endsWith(".cloudflareaccess.com")
  );
}

/** Detects an identity edge without sending the portal bearer token off-host. */
export async function probePortalAccess(publicUrl: string): Promise<PortalInspectResult> {
  try {
    const response = await fetch(publicUrl, {
      method: "GET",
      redirect: "manual",
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(PORTAL_ACCESS_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel();
    const location = response.headers.get("location");
    return {
      access:
        location &&
        isRedirect(response.status) &&
        isCloudflareAccessLoginRedirect(publicUrl, location)
          ? "cloudflare"
          : "none",
    };
  } catch {
    // Gateway-side DNS and routing can differ from the operator's browser. An
    // inconclusive server probe must not suppress the existing browser check.
    return { access: "unknown" };
  }
}
