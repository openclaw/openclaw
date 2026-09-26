import { isDeepStrictEqual } from "node:util";
import { serializeConfigResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

function withoutIdentityScopes({ gateway, ...config }: OpenClawConfig) {
  const { auth, ...gatewayConfig } = gateway ?? {};
  const { identityScopes: _identityScopes, ...authConfig } = auth ?? {};
  return { ...config, gateway: { ...gatewayConfig, auth: authConfig } };
}

export function isIdentityScopesOnlyConfigChange(
  previous: OpenClawConfig,
  next: OpenClawConfig,
): boolean {
  // Same-object publications may follow in-place edits; they still need a full refresh.
  return (
    previous !== next &&
    !isDeepStrictEqual(
      previous.gateway?.auth?.identityScopes,
      next.gateway?.auth?.identityScopes,
    ) &&
    isDeepStrictEqual(withoutIdentityScopes(previous), withoutIdentityScopes(next)) &&
    isDeepStrictEqual(
      serializeConfigResolutionFacts(previous),
      serializeConfigResolutionFacts(next),
    )
  );
}
