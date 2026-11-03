import {
  getCanonicalGatewayContextResolver,
  getGatewayContextLifetime,
} from "../plugins/runtime/gateway-context-binding.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { LegacyGitHubOAuthService } from "./github-oauth-lifecycle-host.types.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

// Only a lookup projection lives here. The plugin's canonical record owns state and cleanup.
// The native SDK installer and source host getter share this exact-Gateway projection.
const legacyOAuthReaders = resolveGlobalSingleton(
  Symbol.for("openclaw.legacyGitHubOAuthReaders"),
  () => new WeakMap<AbortSignal, () => LegacyGitHubOAuthService | undefined>(),
);

export function bindLegacyGitHubOAuthReader(
  owner: AbortSignal,
  read: () => LegacyGitHubOAuthService | undefined,
  signal: AbortSignal,
): () => void {
  signal.throwIfAborted();
  if (legacyOAuthReaders.has(owner)) {
    throw new Error("A legacy GitHub account lookup is already installed for this Gateway.");
  }
  legacyOAuthReaders.set(owner, read);
  const uninstall = () => {
    if (legacyOAuthReaders.get(owner) === read) {
      legacyOAuthReaders.delete(owner);
    }
    signal.removeEventListener("abort", uninstall);
  };
  signal.addEventListener("abort", uninstall, { once: true });
  return uninstall;
}

export function readLegacyGitHubOAuthService(
  context: Pick<GatewayRequestContext, "resolveGatewayContext">,
): LegacyGitHubOAuthService | undefined {
  const resolver = context.resolveGatewayContext;
  const owner = resolver && getCanonicalGatewayContextResolver(resolver);
  if (!owner) {
    return undefined;
  }
  const lifetime = getGatewayContextLifetime(owner).signal;
  return lifetime.aborted ? undefined : legacyOAuthReaders.get(lifetime)?.();
}
