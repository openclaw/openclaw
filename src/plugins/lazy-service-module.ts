import { isTruthyEnvValue } from "../infra/env.js";
import { toSafeImportPath } from "./safe-import-path.js";

type LazyServiceModule = Record<string, unknown>;

export type LazyPluginServiceHandle = {
  stop: () => Promise<void>;
};

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic service exports are typed by the caller.
function resolveExport<T>(mod: LazyServiceModule, names: string[]): T | null {
  for (const name of names) {
    const value = mod[name];
    if (typeof value === "function") {
      return value as T;
    }
  }
  return null;
}

/**
 * Default loader used when no custom `loadOverrideModule` is supplied.
 *
 * Routes the specifier through {@link toSafeImportPath} so absolute Windows
 * paths (e.g. `C:\\path\\to\\module.mjs`) are converted to `file://`
 * URLs before being handed to Node's ESM loader, which otherwise rejects them
 * with `ERR_UNSUPPORTED_ESM_URL_SCHEME`. The `importModule` parameter exists
 * for tests; production callers should leave it undefined.
 */
export async function defaultLoadOverrideModule(
  specifier: string,
  importModule: (s: string) => Promise<unknown> = (s) => import(s),
): Promise<LazyServiceModule> {
  return (await importModule(toSafeImportPath(specifier))) as LazyServiceModule;
}

export async function startLazyPluginServiceModule(params: {
  skipEnvVar?: string;
  overrideEnvVar?: string;
  validateOverrideSpecifier?: (specifier: string) => string;
  loadDefaultModule: () => Promise<LazyServiceModule>;
  loadOverrideModule?: (specifier: string) => Promise<LazyServiceModule>;
  startExportNames: string[];
  stopExportNames?: string[];
}): Promise<LazyPluginServiceHandle | null> {
  const skipEnvVar = params.skipEnvVar?.trim();
  if (skipEnvVar && isTruthyEnvValue(process.env[skipEnvVar])) {
    return null;
  }

  const overrideEnvVar = params.overrideEnvVar?.trim();
  const override = overrideEnvVar ? process.env[overrideEnvVar]?.trim() : undefined;
  const loadOverrideModule = params.loadOverrideModule ?? defaultLoadOverrideModule;
  const validatedOverride =
    override && params.validateOverrideSpecifier
      ? params.validateOverrideSpecifier(override)
      : override;
  const mod = validatedOverride
    ? await loadOverrideModule(validatedOverride)
    : await params.loadDefaultModule();
  const start = resolveExport<() => Promise<unknown>>(mod, params.startExportNames);
  if (!start) {
    return null;
  }
  const stop =
    params.stopExportNames && params.stopExportNames.length > 0
      ? resolveExport<() => Promise<void>>(mod, params.stopExportNames)
      : null;

  await start();
  return {
    stop: stop ?? (async () => {}),
  };
}
