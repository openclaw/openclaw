/**
 * Memoize a tool-factory result by the full set of inputs that affect its
 * output — including any object references captured by the factory closure.
 *
 * The built-in tool factories used inside `createOpenClawTools` (image, pdf,
 * video, music, web-search, web-fetch) each spend hundreds of milliseconds
 * resolving plugin manifests, provider auth, and capability metadata. They
 * are called once per agent turn; the existing per-`OpenClawConfig` caches
 * inside `media-understanding/defaults.ts` only help within a single turn
 * and do not amortize across turns.
 *
 * For the same set of factory inputs the resulting tool descriptor is
 * deterministic, so we cache it for the gateway-process lifetime.
 *
 * ### Cache shape
 *
 * The cache is a chain of `WeakMap`s keyed on the caller-supplied `refs`
 * array, terminating in a leaf `Map<scalarsKey, R>` keyed on a JSON-encoded
 * tuple of stable scalars:
 *
 *     refs[0] -> WeakMap<refs[1], ... WeakMap<refs[n], Map<scalarsKey, R>>>
 *
 * Whenever any object in `refs` is no longer referenced elsewhere, the
 * corresponding sub-tree is collected by GC. In practice this means:
 *
 * - Replacing the active `OpenClawConfig` (config reload) drops the entire
 *   cache subtree for the previous config.
 * - Calling `setActiveRuntimeWebToolsMetadata` / `clearActiveRuntimeWebToolsMetadata`
 *   on the runtime web-tools registry leaves the previous `runtimeWebTools`
 *   object's leaf `Map` collectable.
 * - Swapping the `sandbox` object (e.g. the agent harness rebuilding the
 *   sandbox bridge for a new run) bypasses the cache entry that closed over
 *   the old bridge.
 *
 * ### Sentinels
 *
 * `null` / `undefined` refs share a single frozen sentinel object per slot,
 * so callers can pass `undefined` for "no relevant ref at this position"
 * without breaking the chain. The single sentinel-anchored sub-tree may
 * persist for the process lifetime, but it is bounded — it is one bucket,
 * not unbounded growth across many distinct configs.
 */

const NULL_REF: object = Object.freeze({ __memo_null_ref__: true });

let root: WeakMap<object, unknown> = new WeakMap();

function asRef(value: unknown): object {
  return value && typeof value === "object" ? (value as object) : NULL_REF;
}

function getOrCreateChild<V>(parent: WeakMap<object, unknown>, key: object, factory: () => V): V {
  const existing = parent.get(key) as V | undefined;
  if (existing !== undefined) {
    return existing;
  }
  const created = factory();
  parent.set(key, created);
  return created;
}

export function memoizeToolFactory<R>(params: {
  label: string;
  /**
   * Object references whose identity affects factory output. Each becomes
   * a WeakMap key in a chain so the entire downstream cache is GC'd when any
   * level's referent becomes unreachable. `null` / `undefined` are allowed
   * and bucket via a shared sentinel.
   */
  refs: ReadonlyArray<unknown>;
  /** Stable scalar values that also affect factory output. */
  scalars: ReadonlyArray<string | number | boolean | null | undefined>;
  factory: () => R;
}): R {
  let level: WeakMap<object, unknown> = root;
  if (params.refs.length === 0) {
    // Even with zero refs we anchor on a sentinel so cache always lives behind
    // a WeakMap (allows future invalidation patterns without changing shape).
    const leaf = getOrCreateChild(level, NULL_REF, () => new Map<string, unknown>()) as Map<
      string,
      unknown
    >;
    return readOrCompute(leaf, params.label, params.scalars, params.factory);
  }

  const last = params.refs.length - 1;
  for (let i = 0; i < last; i++) {
    const next = getOrCreateChild(
      level,
      asRef(params.refs[i]),
      () => new WeakMap<object, unknown>(),
    );
    level = next as WeakMap<object, unknown>;
  }
  const leaf = getOrCreateChild(
    level,
    asRef(params.refs[last]),
    () => new Map<string, unknown>(),
  ) as Map<string, unknown>;
  return readOrCompute(leaf, params.label, params.scalars, params.factory);
}

function readOrCompute<R>(
  leaf: Map<string, unknown>,
  label: string,
  scalars: ReadonlyArray<string | number | boolean | null | undefined>,
  factory: () => R,
): R {
  const key = label + "|" + JSON.stringify(scalars);
  if (leaf.has(key)) {
    return leaf.get(key) as R;
  }
  const result = factory();
  leaf.set(key, result);
  return result;
}

/**
 * Test-only: replace the entire memo cache with a fresh `WeakMap`. Exported
 * so unit tests can run back-to-back assertions without leaking state from
 * earlier tests. NOT used in production code paths.
 */
export function __resetMemoToolFactoryCacheForTesting(): void {
  root = new WeakMap();
}
