import type { Model } from "@openclaw/ai";
import { isLoopbackIpAddress } from "@openclaw/net-policy/ip";

/** Explicit loopback literals support same-host proxies and isolated wire proof without DNS. */
export function isNativeRuntimeEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" ||
        (url.protocol === "http:" && isLoopbackIpAddress(url.hostname))) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      !/[{}]/.test(value)
    );
  } catch {
    return false;
  }
}

/** The operator selects one origin, not an authority to replay credentials through redirects. */
export function buildNativeRuntimeFetch(model: Pick<Model, "baseUrl">): typeof fetch {
  if (!isNativeRuntimeEndpoint(model.baseUrl)) {
    throw new Error("Native inference requires HTTPS or a literal loopback HTTP endpoint");
  }
  const origin = new URL(model.baseUrl).origin;
  const fetcher = globalThis.fetch;
  return (input, init) => {
    const target = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    if (target.origin !== origin || target.username || target.password) {
      throw new Error("Native inference request left its configured endpoint origin");
    }
    // Even same-origin redirects are rejected: providers must be provisioned with their final
    // endpoint, and SDK retries cannot silently broaden the credential-bearing route.
    return fetcher(input, { ...init, redirect: "error" });
  };
}
