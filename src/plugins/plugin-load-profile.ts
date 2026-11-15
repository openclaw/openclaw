// Scrapers require phase, plugin, elapsedMs, ordered extras, then source.
import { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";

export function shouldProfilePluginLoader(): boolean {
  return isDiagnosticFlagEnabled("plugin.load-profile");
}

type PluginLoadProfileExtras = ReadonlyArray<readonly [string, number | string]>;

type PluginLoadProfileScope = {
  pluginId?: string;
  source: string;
};

type PluginLoadProfiler = <T>(phase: string, run: () => T, extras?: PluginLoadProfileExtras) => T;

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

/** Profile only when enabled, including failed calls. */
export function withProfile<T>(
  scope: PluginLoadProfileScope,
  phase: string,
  run: () => T,
  extras?: PluginLoadProfileExtras,
): T {
  if (!shouldProfilePluginLoader()) {
    return run();
  }
  const startMs = performance.now();
  try {
    return run();
  } finally {
    const elapsedMs = performance.now() - startMs;
    console.error(
      formatPluginLoadProfileLine({
        phase,
        pluginId: scope.pluginId,
        source: scope.source,
        elapsedMs,
        extras,
      }),
    );
  }
}

export function createProfiler(scope: PluginLoadProfileScope): PluginLoadProfiler {
  return (phase, run, extras) => withProfile(scope, phase, run, extras);
}
