/**
 * Memoize a tool-factory result by a stable subset of its options.
 *
 * The built-in tool factories used inside `createOpenClawTools` (image, pdf,
 * video, music, web-search, web-fetch) each spend hundreds of milliseconds
 * resolving plugin manifests, provider auth, and capability metadata. They
 * are called once per agent turn; the `WeakMap<OpenClawConfig, ...>` cache
 * inside `media-understanding/defaults.ts` only helps within a single turn
 * and does not amortize across turns.
 *
 * For the same agent + workspace + config + sandbox, these factories
 * produce the same tool descriptors, so we cache the result by:
 *
 *     cfgRef -> WeakMap<depsRef, Map<scalarsKey, result>>
 *
 * - The outer key is the `OpenClawConfig` object reference. When the config
 *   is replaced (config reload), the entire inner `WeakMap` is GC'd with it.
 * - The middle key is an optional `deps` object reference for module-level
 *   state that the factory closes over but is not part of `options` (e.g.
 *   the active runtime web-tools metadata snapshot). When that reference is
 *   replaced, the leaf `Map` for the previous deps is GC'd with it.
 * - The inner key is a JSON-encoded tuple of stable scalar inputs.
 *
 * Callers that pass no `cfg` and no `deps` share single sentinel buckets,
 * which can persist for the process lifetime — but that is a single fixed
 * bucket, not unbounded growth.
 */

const NULL_CFG_KEY: object = Object.freeze({ __memo_null_cfg__: true });
const DEFAULT_DEPS_KEY: object = Object.freeze({ __memo_default_deps__: true });

const root = new WeakMap<object, WeakMap<object, Map<string, unknown>>>();

function asKey(value: unknown, fallback: object): object {
  return value && typeof value === "object" ? (value as object) : fallback;
}

export function memoizeToolFactory<R>(params: {
  label: string;
  cfg: unknown;
  /** Optional object reference whose identity also affects factory output. */
  deps?: unknown;
  scalars: ReadonlyArray<string | number | boolean | null | undefined>;
  factory: () => R;
}): R {
  const cfgKey = asKey(params.cfg, NULL_CFG_KEY);
  let depsMap = root.get(cfgKey);
  if (!depsMap) {
    depsMap = new WeakMap();
    root.set(cfgKey, depsMap);
  }
  const depsKey = asKey(params.deps, DEFAULT_DEPS_KEY);
  let leaf = depsMap.get(depsKey);
  if (!leaf) {
    leaf = new Map();
    depsMap.set(depsKey, leaf);
  }
  const key = params.label + "|" + JSON.stringify(params.scalars);
  if (leaf.has(key)) {
    return leaf.get(key) as R;
  }
  const result = params.factory();
  leaf.set(key, result);
  return result;
}
