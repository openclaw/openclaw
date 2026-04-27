/**
 * Memoize a tool-factory result by a stable subset of its options.
 *
 * The built-in tool factories used inside `createOpenClawTools` (image, pdf,
 * video, music, web-search, web-fetch) each spend hundreds of milliseconds
 * resolving plugin manifests, provider auth, and capability metadata. They are
 * called once per agent turn; the `WeakMap<OpenClawConfig, ...>` cache inside
 * `media-understanding/defaults.ts` only helps when the same `cfg` object is
 * re-used across calls within a single turn and does not amortize across turns.
 *
 * For the same agent + workspace + config + sandbox, these factories produce
 * the same tool descriptors, so we can safely cache the result for the
 * gateway-process lifetime and re-use it on every turn.
 *
 * Cache key strategy:
 *   - WeakMap keyed on the OpenClawConfig object reference (assigns a numeric
 *     id on first sight) so config replacement invalidates the cache without
 *     leaking memory.
 *   - Stable scalars (agentDir, workspaceDir, sandboxRoot, etc.) joined into
 *     a string suffix.
 */

const cfgIds = new WeakMap<object, number>();
let cfgIdNext = 0;
function cfgKey(cfg: unknown): string {
  if (!cfg || typeof cfg !== "object") return "none";
  let id = cfgIds.get(cfg as object);
  if (id === undefined) {
    id = ++cfgIdNext;
    cfgIds.set(cfg as object, id);
  }
  return String(id);
}

const factoryCache = new Map<string, unknown>();

export function memoizeToolFactory<R>(
  label: string,
  cfg: unknown,
  scalars: ReadonlyArray<string | number | boolean | null | undefined>,
  factory: () => R,
): R {
  const key = label + "|" + cfgKey(cfg) + "|" + JSON.stringify(scalars);
  if (factoryCache.has(key)) {
    return factoryCache.get(key) as R;
  }
  const result = factory();
  factoryCache.set(key, result);
  return result;
}
