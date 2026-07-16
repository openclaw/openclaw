import { toSafeImportPath } from "../shared/import-specifier.js";
import { attachPluginApiFacades } from "./api-facades.js";
import { isLateCallablePluginApiMethod } from "./api-lifecycle.js";
import type { PluginLoadOptions } from "./loader-types.js";
import { withProfile } from "./plugin-load-profile.js";
import {
  createPluginModuleLoaderCache,
  getCachedPluginModuleLoader,
  type PluginModuleLoaderCache,
} from "./plugin-module-loader-cache.js";
import { installOpenClawPluginSdkNativeResolver } from "./plugin-sdk-native-resolver.js";
import type { PluginRuntime } from "./runtime/types.js";
import {
  buildPluginLoaderAliasMap,
  type PluginRuntimeModuleResolution,
  type PluginSdkResolutionPreference,
  resolvePluginRuntimeModulePathWithDiagnostics,
} from "./sdk-alias.js";
import type { OpenClawPluginApi, OpenClawPluginDefinition } from "./types.js";

export type PluginModuleLoader = (modulePath: string) => unknown;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function createGuardedPluginRegistrationApi(api: OpenClawPluginApi): {
  api: OpenClawPluginApi;
  close: () => void;
} {
  let closed = false;
  const guardedApi = attachPluginApiFacades(
    new Proxy(api, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") {
          return value;
        }
        if (typeof prop === "string" && isLateCallablePluginApiMethod(prop)) {
          return (...args: unknown[]) => Reflect.apply(value, target, args);
        }
        return (...args: unknown[]) => {
          const isLateCallableMethod =
            typeof prop === "string" && isLateCallablePluginApiMethod(prop);
          if (closed && !isLateCallableMethod) {
            return undefined;
          }
          return Reflect.apply(value, target, args);
        };
      },
    }),
  );
  return {
    api: guardedApi,
    close: () => {
      closed = true;
    },
  };
}

export function runPluginRegisterSync(
  register: NonNullable<OpenClawPluginDefinition["register"]>,
  api: Parameters<NonNullable<OpenClawPluginDefinition["register"]>>[0],
): void {
  const guarded = createGuardedPluginRegistrationApi(api);
  try {
    const result = register(guarded.api);
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(() => {});
      throw new Error("plugin register must be synchronous");
    }
  } finally {
    guarded.close();
  }
}

export function createPluginModuleLoader(options: {
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): PluginModuleLoader {
  const moduleLoaders: PluginModuleLoaderCache = createPluginModuleLoaderCache();
  const createLoaderForModule = (modulePath: string) => {
    installOpenClawPluginSdkNativeResolver({
      argv1: process.argv[1],
      moduleUrl: import.meta.url,
      pluginModulePath: modulePath,
      devSourceRoot: options.devSourceRoot,
      pluginSdkResolution: options.pluginSdkResolution,
    });
    return getCachedPluginModuleLoader({
      cache: moduleLoaders,
      modulePath,
      importerUrl: import.meta.url,
      loaderFilename: modulePath,
      devSourceRoot: options.devSourceRoot,
      aliasMap: buildPluginLoaderAliasMap(
        modulePath,
        process.argv[1],
        import.meta.url,
        options.pluginSdkResolution,
        options.devSourceRoot,
      ),
      pluginSdkResolution: options.pluginSdkResolution,
    });
  };
  return (modulePath: string): unknown =>
    createLoaderForModule(modulePath)(toSafeImportPath(modulePath));
}

function formatPluginRuntimeModuleResolutionError(params: {
  resolution: PluginRuntimeModuleResolution;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): string {
  const { resolution } = params;
  const candidates = resolution.candidates.length > 0 ? resolution.candidates.join(", ") : "<none>";
  return [
    "Unable to resolve plugin runtime module",
    `loader=${resolution.modulePath ?? "<unresolved>"}`,
    `packageRoot=${resolution.packageRoot ?? "<none>"}`,
    `pluginSdkResolution=${params.pluginSdkResolution ?? "auto"}`,
    `candidates=${candidates}`,
    ...(resolution.error ? [`resolverError=${resolution.error}`] : []),
  ].join("; ");
}

const LAZY_RUNTIME_REFLECTION_KEYS = [
  "version",
  "gateway",
  "config",
  "agent",
  "subagent",
  "system",
  "media",
  "mediaUnderstanding",
  "tts",
  "stt",
  "channel",
  "events",
  "logging",
  "state",
  "modelAuth",
  "imageGeneration",
  "videoGeneration",
  "musicGeneration",
  "llm",
] as const satisfies readonly (keyof PluginRuntime)[];

export function createLazyPluginRuntime(params: {
  loadPluginModule: PluginModuleLoader;
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  runtimeOptions?: PluginLoadOptions["runtimeOptions"];
}): PluginRuntime {
  let createPluginRuntimeFactory:
    | ((options?: PluginLoadOptions["runtimeOptions"]) => PluginRuntime)
    | null = null;
  const resolveCreatePluginRuntime = () => {
    if (createPluginRuntimeFactory) {
      return createPluginRuntimeFactory;
    }
    const resolution = resolvePluginRuntimeModulePathWithDiagnostics({
      devSourceRoot: params.devSourceRoot,
      pluginSdkResolution: params.pluginSdkResolution,
    });
    if (!resolution.resolvedPath) {
      throw new Error(
        formatPluginRuntimeModuleResolutionError({
          resolution,
          pluginSdkResolution: params.pluginSdkResolution,
        }),
      );
    }
    const runtimeModule = withProfile({ source: resolution.resolvedPath }, "runtime-module", () =>
      params.loadPluginModule(resolution.resolvedPath as string),
    ) as {
      createPluginRuntime?: (options?: PluginLoadOptions["runtimeOptions"]) => PluginRuntime;
    };
    if (typeof runtimeModule.createPluginRuntime !== "function") {
      throw new Error("Plugin runtime module missing createPluginRuntime export");
    }
    createPluginRuntimeFactory = runtimeModule.createPluginRuntime;
    return createPluginRuntimeFactory;
  };

  let resolvedRuntime: PluginRuntime | null = null;
  const resolveRuntime = (): PluginRuntime => {
    resolvedRuntime ??= resolveCreatePluginRuntime()(params.runtimeOptions);
    return resolvedRuntime;
  };
  const reflectionKeys = new Set<PropertyKey>(LAZY_RUNTIME_REFLECTION_KEYS);
  const resolveDescriptor = (prop: PropertyKey): PropertyDescriptor | undefined => {
    if (!reflectionKeys.has(prop)) {
      return Reflect.getOwnPropertyDescriptor(resolveRuntime() as object, prop);
    }
    return {
      configurable: true,
      enumerable: true,
      get: () => Reflect.get(resolveRuntime() as object, prop),
      set: (value: unknown) => {
        Reflect.set(resolveRuntime() as object, prop, value);
      },
    };
  };
  return new Proxy({} as PluginRuntime, {
    get: (_target, prop, receiver) => Reflect.get(resolveRuntime(), prop, receiver),
    set: (_target, prop, value, receiver) => Reflect.set(resolveRuntime(), prop, value, receiver),
    has: (_target, prop) => reflectionKeys.has(prop) || Reflect.has(resolveRuntime(), prop),
    ownKeys: () => [...LAZY_RUNTIME_REFLECTION_KEYS],
    getOwnPropertyDescriptor: (_target, prop) => resolveDescriptor(prop),
    defineProperty: (_target, prop, attributes) =>
      Reflect.defineProperty(resolveRuntime() as object, prop, attributes),
    deleteProperty: (_target, prop) => Reflect.deleteProperty(resolveRuntime() as object, prop),
    getPrototypeOf: () => Reflect.getPrototypeOf(resolveRuntime() as object),
  });
}
