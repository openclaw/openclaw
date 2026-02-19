import { resolvePinnedHostnameWithPolicy, type SsrFPolicy } from "../infra/net/ssrf.js";

const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);

export async function assertBrowserNavigationAllowed(opts: {
  url: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<void> {
  const rawUrl = String(opts.url ?? "").trim();
  if (!rawUrl) {
    throw new Error("url is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    return;
  }

  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    policy: opts.ssrfPolicy,
  });
}
