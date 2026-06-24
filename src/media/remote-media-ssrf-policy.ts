import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";

type RemoteMediaSsrfPolicy = Pick<
  SsrFPolicy,
  "allowRfc2544BenchmarkRange" | "allowIpv6UniqueLocalRange"
>;

/**
 * Projects web_fetch SSRF compatibility flags onto remote media/provider reads.
 * Hostname restrictions are scoped to web_fetch URLs and must not constrain provider APIs or CDNs.
 */
export function projectRemoteMediaSsrfPolicy(
  cfg: OpenClawConfig | undefined,
): RemoteMediaSsrfPolicy | undefined {
  const policy = cfg?.tools?.web?.fetch?.ssrfPolicy;
  if (!policy) {
    return undefined;
  }
  const projected: RemoteMediaSsrfPolicy = {
    ...(policy.allowRfc2544BenchmarkRange !== undefined
      ? { allowRfc2544BenchmarkRange: policy.allowRfc2544BenchmarkRange }
      : {}),
    ...(policy.allowIpv6UniqueLocalRange !== undefined
      ? { allowIpv6UniqueLocalRange: policy.allowIpv6UniqueLocalRange }
      : {}),
  };
  return Object.keys(projected).length > 0 ? projected : undefined;
}
