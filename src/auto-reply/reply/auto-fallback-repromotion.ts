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
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
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

export type AutoFallbackModelRef = {
  provider: string;
  model: string;
};

/**
 * Picks the highest-priority candidate ranked strictly above the current auto-fallback
 * selection that is currently available (not in cooldown). Returns undefined when nothing
 * better than the current selection is available, so the session stays put.
 *
 * Why this exists: making auth-profile cooldowns per-model removed the coarse side effect where
 * a primary rate-limit also suspended sibling models sharing that profile (e.g. gpt-5.5 limiting
 * also disabled gpt-5.3-codex-spark), which used to force the chain down to the next provider tier
 * and looked like "fallback upwards" working. With per-model scoping a session that pins to a low
 * tier never re-walks up on its own. This restores the climb explicitly: walk from the top of the
 * ordered chain and return the first available tier above `current`. A session stuck on spark while
 * gpt-5.5 is still rate-limited re-promotes to an available sonnet instead of sticking on spark, and
 * jumps straight back to gpt-5.5 once its window clears. Returning undefined above the current tier
 * is what prevents thrash: once landed on the best available tier, no strictly-better tier exists.
 */
export function resolveAutoFallbackRepromotionTarget(params: {
  chain: readonly AutoFallbackModelRef[];
  current: AutoFallbackModelRef;
  isAvailable: (ref: AutoFallbackModelRef) => boolean;
}): AutoFallbackModelRef | undefined {
  const normRef = (ref: AutoFallbackModelRef) => ({
    provider: normalizeOptionalString(ref.provider) ?? "",
    model: normalizeOptionalString(ref.model) ?? "",
  });
  const current = normRef(params.current);
  if (!current.provider || !current.model) {
    return undefined;
  }
  const sameRef = (
    a: { provider: string; model: string },
    b: { provider: string; model: string },
  ) => a.provider === b.provider && a.model === b.model;
  const currentIndex = params.chain.findIndex((ref) => sameRef(normRef(ref), current));
  // Current selection absent from the chain: treat the whole chain as ranked above it.
  const ceiling = currentIndex === -1 ? params.chain.length : currentIndex;
  for (let i = 0; i < ceiling; i += 1) {
    const candidate = normRef(params.chain[i]!);
    if (!candidate.provider || !candidate.model) {
      continue;
    }
    if (sameRef(candidate, current)) {
      continue;
    }
    if (params.isAvailable({ provider: candidate.provider, model: candidate.model })) {
      return { provider: candidate.provider, model: candidate.model };
    }
  }
  return undefined;
}

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
