/**
 * Shared probe primitives for plugin-load profiling.
 *
 * All plugin-load probes — across `src/plugins/loader.ts`,
 * `src/plugins/source-loader.ts`, and `src/plugin-sdk/channel-entry-contract.ts`
 * — emit a single line per measurement to stderr in the form:
 *
 *     [plugin-load-profile] phase=<X> plugin=<Y> elapsedMs=<N> [extras…] source=<S>
 *
 * The same `OPENCLAW_PLUGIN_LOAD_PROFILE=1` env flag activates all probes.
 *
 * Tooling that scrapes these lines (e.g. PERF-STARTUP-PLAN.md profiling
 * methodology) depends on the field order being:
 *
 *   1. `phase=`
 *   2. `plugin=`
 *   3. `elapsedMs=`
 *   4. any caller-supplied extras (in declaration order)
 *   5. `source=` last
 *
 * Keep this contract stable — downstream parsers rely on it.
 */

export function shouldProfilePluginLoader(): boolean {
  return process.env.OPENCLAW_PLUGIN_LOAD_PROFILE === "1";
}

/**
 * An ordered list of `[key, value]` pairs appended between `elapsedMs=` and
 * `source=` on the emitted log line. Ordered tuples (not a record) so that
 * scrapers see a deterministic field order regardless of object iteration
 * quirks.
 */
export type PluginLoadProfileExtras = ReadonlyArray<readonly [string, number | string]>;

/**
 * Render a `[plugin-load-profile]` line. Exported so that callers needing
 * custom timing splits (e.g. dual-timer probes) can build their own start/stop
 * logic and still emit a line in the canonical format.
 */
export function formatPluginLoadProfileLine(params: {
  phase: string;
  pluginId?: string;
  source: string;
  elapsedMs: number;
  extras?: PluginLoadProfileExtras;
}): string {
  const extras = (params.extras ?? [])
    .map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(1) : v}`)
    .join(" ");
  const extrasFragment = extras ? ` ${extras}` : "";
  return (
    `[plugin-load-profile] phase=${params.phase} plugin=${params.pluginId ?? "(core)"}` +
    ` elapsedMs=${params.elapsedMs.toFixed(1)}${extrasFragment} source=${params.source}`
  );
}

/**
 * Wrap a synchronous step with start/stop timing and a `[plugin-load-profile]`
 * log line. When the env flag is unset, calls `params.run()` directly with no
 * overhead. Errors propagate naturally; the log line is still emitted via
 * `try { … } finally { … }`.
 */
export function profilePluginLoaderSync<T>(params: {
  phase: string;
  pluginId?: string;
  source: string;
  run: () => T;
  /**
   * Optional extras to render between `elapsedMs=` and `source=`. Numeric
   * extras are formatted with one decimal place to match the `elapsedMs`
   * precision.
   */
  extras?: PluginLoadProfileExtras;
}): T {
  if (!shouldProfilePluginLoader()) {
    return params.run();
  }
  const startMs = performance.now();
  try {
    return params.run();
  } finally {
    const elapsedMs = performance.now() - startMs;
    console.error(
      formatPluginLoadProfileLine({
        phase: params.phase,
        pluginId: params.pluginId,
        source: params.source,
        elapsedMs,
        extras: params.extras,
      }),
    );
  }
}
