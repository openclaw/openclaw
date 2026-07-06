/**
 * Production wiring for auto-fallback re-promotion ("fall back up").
 *
 * `resolveRunAfterAutoFallbackPrimaryProbeRecheck` accepts an injected
 * `resolveRepromotionTarget` closure so its unit tests can supply a synthetic
 * chain/availability check. This module builds the real closure from live
 * config + auth-profile cooldown state so a session that auto-pinned to a low
 * fallback tier climbs back to the highest available tier once a middle tier
 * recovers, instead of sticking on the bottom of the chain.
 */
import {
  resolveAutoFallbackRepromotionTarget,
  type AutoFallbackModelRef,
} from "../../agents/agent-scope.js";
import {
  ensureAuthProfileStore,
  isProfileInCooldown,
  resolveAuthProfileOrder,
} from "../../agents/model-fallback-auth.runtime.js";
import { parseModelRef } from "../../agents/model-selection-normalize.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.js";

type AuthProfileStore = ReturnType<typeof ensureAuthProfileStore>;

export type AutoFallbackRepromotionResolver = (
  current: AutoFallbackModelRef,
) => AutoFallbackModelRef | undefined;

/**
 * Ordered auto-fallback chain (primary first, then configured fallbacks) as
 * normalized provider/model refs. Mirrors the ordering used by the fallback
 * walk: `agents.defaults.model` primary followed by its `fallbacks` list.
 */
export function buildAutoFallbackChain(params: {
  cfg?: OpenClawConfig;
  defaultProvider: string;
}): AutoFallbackModelRef[] {
  const model = params.cfg?.agents?.defaults?.model;
  const raws = [resolveAgentModelPrimaryValue(model), ...resolveAgentModelFallbackValues(model)];
  const chain: AutoFallbackModelRef[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    if (!raw) {
      continue;
    }
    const ref = parseModelRef(raw, params.defaultProvider);
    if (!ref) {
      continue;
    }
    const key = `${ref.provider}/${ref.model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    chain.push({ provider: ref.provider, model: ref.model });
  }
  return chain;
}

/**
 * A ref is available when at least one of its provider's auth profiles is not in
 * a (model-scoped) cooldown. Providers that track no auth profiles (e.g. CLI
 * providers) resolve to an empty order; treat those as available so the climb is
 * not permanently blocked — the downstream selection walk re-validates on attempt.
 */
function isModelAvailable(params: {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  ref: AutoFallbackModelRef;
}): boolean {
  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
    store: params.store,
    provider: params.ref.provider,
  });
  if (order.length === 0) {
    return true;
  }
  return order.some(
    (profileId) => !isProfileInCooldown(params.store, profileId, undefined, params.ref.model),
  );
}

/**
 * Pure re-promotion decision against an explicit auth-profile store. Exposed so
 * the config-chain + cooldown-availability wiring can be tested without touching
 * the on-disk store; production callers use `buildAutoFallbackRepromotionResolver`.
 */
export function selectAutoFallbackRepromotionTarget(params: {
  cfg?: OpenClawConfig;
  defaultProvider: string;
  current: AutoFallbackModelRef;
  store: AuthProfileStore;
}): AutoFallbackModelRef | undefined {
  const chain = buildAutoFallbackChain({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  if (chain.length === 0) {
    return undefined;
  }
  return resolveAutoFallbackRepromotionTarget({
    chain,
    current: params.current,
    isAvailable: (ref) => isModelAvailable({ cfg: params.cfg, store: params.store, ref }),
  });
}

/**
 * Build the closure passed to `resolveRunAfterAutoFallbackPrimaryProbeRecheck`.
 * The auth-profile store is loaded lazily on the first candidate check and reused
 * across the rest of that recheck so a single turn reads it once.
 */
export function buildAutoFallbackRepromotionResolver(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  defaultProvider: string;
}): AutoFallbackRepromotionResolver {
  const chain = buildAutoFallbackChain({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  if (chain.length === 0) {
    return () => undefined;
  }
  let store: AuthProfileStore | undefined;
  return (current) => {
    store ??= ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
    return selectAutoFallbackRepromotionTarget({
      cfg: params.cfg,
      defaultProvider: params.defaultProvider,
      current,
      store,
    });
  };
}
