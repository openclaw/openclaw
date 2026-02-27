import {
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
  type SsrFPolicy,
} from "../infra/net/ssrf.js";

const NETWORK_NAVIGATION_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_NON_NETWORK_URLS = new Set(["about:blank"]);

function isAllowedNonNetworkNavigationUrl(parsed: URL): boolean {
  // Keep non-network navigation explicit; about:blank is the only allowed bootstrap URL.
  return SAFE_NON_NETWORK_URLS.has(parsed.href);
}

export class InvalidBrowserNavigationUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidBrowserNavigationUrlError";
  }
}

export type BrowserNavigationPolicyOptions = {
  ssrfPolicy?: SsrFPolicy;
};

export function withBrowserNavigationPolicy(
  ssrfPolicy?: SsrFPolicy,
): BrowserNavigationPolicyOptions {
  return ssrfPolicy ? { ssrfPolicy } : {};
}

export async function assertBrowserNavigationAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = String(opts.url ?? "").trim();
  if (!rawUrl) {
    throw new InvalidBrowserNavigationUrlError("url is required");
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new InvalidBrowserNavigationUrlError(`Invalid URL: ${rawUrl}`);
  }

  if (!NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    if (isAllowedNonNetworkNavigationUrl(parsed)) {
      return;
    }
    throw new InvalidBrowserNavigationUrlError(
      `Navigation blocked: unsupported protocol "${parsed.protocol}"`,
    );
  }

  await resolvePinnedHostnameWithPolicy(parsed.hostname, {
    lookupFn: opts.lookupFn,
    policy: opts.ssrfPolicy,
  });
}

/**
 * Best-effort post-navigation guard for final page URLs.
 * Only validates network URLs (http/https) and about:blank to avoid false
 * positives on browser-internal error pages (e.g. chrome-error://).
 */
export async function assertBrowserNavigationResultAllowed(
  opts: {
    url: string;
    lookupFn?: LookupFn;
  } & BrowserNavigationPolicyOptions,
): Promise<void> {
  const rawUrl = String(opts.url ?? "").trim();
  if (!rawUrl) {
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }
  if (
    NETWORK_NAVIGATION_PROTOCOLS.has(parsed.protocol) ||
    isAllowedNonNetworkNavigationUrl(parsed)
  ) {
    await assertBrowserNavigationAllowed(opts);
  }
}
