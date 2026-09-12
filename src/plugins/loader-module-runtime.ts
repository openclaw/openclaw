import { toSafeImportPath } from "../shared/import-specifier.js";
import { VERSION } from "../version.js";
import { runPluginRegistration } from "./api-lifecycle.js";
import { isJavaScriptModulePath } from "./native-module-require.js";
import { getPluginCache, withPluginCache } from "./plugin-cache.js";
import { getPluginInstance, getPluginValueInstance } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { withProfile } from "./plugin-load-profile.js";
import {
  bindPluginInstanceModuleLoader,
  getCachedPluginModuleLoader,
} from "./plugin-module-loader-cache.js";
import { installOpenClawPluginSdkNativeResolver } from "./plugin-sdk-native-resolver.js";
import { getPluginRegistryInspectionResources } from "./registry-inspection-resources.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import { withPluginRegistrationContext } from "./runtime.js";
import { createRuntimeBase } from "./runtime/runtime-base.js";
import type {
  CreatePluginRuntimeOptions,
  PluginRuntimeFactory,
  PluginRuntime,
} from "./runtime/types.js";
import {
  type PluginRuntimeModuleResolution,
  type PluginSdkResolutionPreference,
  resolvePluginRuntimeModulePathWithDiagnostics,
} from "./sdk-alias.js";
import type { OpenClawPluginDefinition } from "./types.js";

// Preserve the existing enumeration order, appending surfaces added to the runtime contract.
// Scoped runtime proxies also ask for descriptors after their get trap returns.
const LAZY_RUNTIME_PROPERTIES = {
  version: true,
  gateway: true,
  config: true,
  agent: true,
  subagent: true,
  system: true,
  media: true,
  mediaUnderstanding: true,
  tts: true,
  channel: true,
  events: true,
  logging: true,
  state: true,
  modelAuth: true,
  imageGeneration: true,
  videoGeneration: true,
  musicGeneration: true,
  llm: true,
  hooks: true,
  nodes: true,
  sandbox: true,
  worktrees: true,
  webSearch: true,
  tasks: true,
  modelConfig: true,
} satisfies Record<keyof PluginRuntime, true>;

export function runPluginRegisterSyncInRegistry(
  register: NonNullable<OpenClawPluginDefinition["register"]>,
  api: Parameters<NonNullable<OpenClawPluginDefinition["register"]>>[0],
  registry: PluginRegistry,
  pluginId: string,
): void {
  const owner = getPluginValueInstance(api);
  const run = () =>
    withPluginRegistrationContext(
      registry,
      pluginId,
      () => {
        const inspection = getPluginRegistryInspectionResources(registry);
        const registerPlugin = () =>
          runPluginRegistration(register, api, "reject", (pending) => {
            inspection?.trackRegistration(pending);
          });
        if (inspection) {
          inspection.runRegistration(
            pluginId,
            registerPlugin,
            owner ? (cleanup) => owner.runCleanup(cleanup) : undefined,
          );
        } else {
          registerPlugin();
        }
      },
      {
        registerMemoryCapability: api.registerMemoryCapability,
        instance: owner,
      },
    );
  if (owner) {
    owner.run(run);
    owner.toolRegistrationComplete ||=
      api.registrationMode === "full" || api.registrationMode === "tool-discovery";
  } else {
    run();
  }
}

export function createPluginModuleLoader(options: {
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  tryNative?: boolean;
  loaderFilename?: string;
  installNativeSdkResolver?: boolean;
  expectedSourceDigests?: Readonly<Record<string, string>>;
}) {
  const cache = getPluginCache();
  const captured = {
    ...options,
    expectedSourceDigests: options.expectedSourceDigests
      ? { ...options.expectedSourceDigests }
      : undefined,
  };
  const createLoaderForModule = (modulePath: string) => {
    if (captured.installNativeSdkResolver !== false && captured.tryNative !== false) {
      installOpenClawPluginSdkNativeResolver({
        argv1: process.argv[1],
        moduleUrl: import.meta.url,
        pluginModulePath: modulePath,
        devSourceRoot: captured.devSourceRoot,
        pluginSdkResolution: captured.pluginSdkResolution,
      });
    }
    return getCachedPluginModuleLoader({
      modulePath,
      importerUrl: import.meta.url,
      loaderFilename: captured.loaderFilename ?? modulePath,
      devSourceRoot: captured.devSourceRoot,
      pluginSdkResolution: captured.pluginSdkResolution,
      ...(captured.tryNative !== undefined ? { tryNative: captured.tryNative } : {}),
    });
  };
  return (
    modulePath: string,
    owner?: {
      record: PluginRecord;
      rootDir: string;
      registry: PluginRegistry;
      standalone?: boolean;
    },
  ): unknown =>
    withPluginCache(cache, () => {
      if (!owner) {
        return createLoaderForModule(modulePath)(toSafeImportPath(modulePath));
      }
      let instance = getPluginInstance(owner.record);
      if (!instance) {
        instance = new PluginInstance(owner.record.id, owner);
        if (owner.record.origin === "bundled" && isJavaScriptModulePath(modulePath)) {
          if (captured.expectedSourceDigests?.[owner.record.id] !== undefined) {
            throw new Error(
              "Source digest validation is not applicable to core-bundled runtime modules",
            );
          }
          // Core-shipped JS chunks keep process identity; source plugins own a reloadable graph.
          const loadHostModule = createLoaderForModule(modulePath);
          instance.bindModuleLoader((source) =>
            withPluginCache(cache, () => loadHostModule(toSafeImportPath(source))),
          );
        } else {
          bindPluginInstanceModuleLoader({
            instance,
            origin: owner.record.origin,
            source: modulePath,
            rootDir: owner.rootDir,
            standalone: owner.standalone,
            expectedSourceDigest: captured.expectedSourceDigests?.[owner.record.id],
            devSourceRoot: captured.devSourceRoot,
            pluginSdkResolution: captured.pluginSdkResolution,
          });
        }
      }
      const expected = captured.expectedSourceDigests?.[owner.record.id];
      if (expected !== undefined && instance.sourceDigest !== expected) {
        throw new Error(`Plugin ${owner.record.id} captured source changed after installation`);
      }
      return instance.loadModule(modulePath);
    });
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

/** Lazily materializes the broad plugin runtime only when registration reads it. */
export function createLazyPluginRuntime(params: {
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
  runtimeOptions?: CreatePluginRuntimeOptions;
  loadPluginModule: ReturnType<typeof createPluginModuleLoader>;
}): PluginRuntime {
  const cache = getPluginCache();
  type RuntimeModule = {
    createPluginRuntime?: PluginRuntimeFactory;
  };
  let runtimeModule: RuntimeModule | undefined;
  const resolveRuntimeModule = (): RuntimeModule => {
    if (runtimeModule) {
      return runtimeModule;
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
    const resolvedPath = resolution.resolvedPath;
    runtimeModule = withPluginCache(cache, () =>
      withProfile(
        { source: resolvedPath },
        "runtime-module",
        () => params.loadPluginModule(resolvedPath) as RuntimeModule,
      ),
    );
    return runtimeModule;
  };

  const base = createRuntimeBase();
  let resolvedRuntime: PluginRuntime | null = null;
  const resolveRuntime = (): PluginRuntime => {
    resolvedRuntime ??= withPluginCache(cache, () => {
      const { createPluginRuntime } = resolveRuntimeModule();
      if (typeof createPluginRuntime !== "function") {
        throw new Error("Plugin runtime module missing createPluginRuntime export");
      }
      return createPluginRuntime(params.runtimeOptions, base);
    });
    return resolvedRuntime;
  };
  const getRuntimeProperty = (prop: PropertyKey, ...receiver: [] | [unknown]): unknown => {
    // Prepared metadata and host facades must not initialize broad runtime services.
    if (!resolvedRuntime) {
      if (
        prop === "gateway" ||
        prop === "hooks" ||
        prop === "nodes" ||
        prop === "subagent" ||
        prop === "modelAuth" ||
        prop === "modelConfig"
      ) {
        const value = params.runtimeOptions?.[prop];
        if (value !== undefined) {
          return value;
        }
      }
      if (prop === "version") {
        return VERSION;
      }
      if (prop === "config" || prop === "state" || prop === "system") {
        return base[prop];
      }
    }
    return receiver.length === 0
      ? Reflect.get(resolveRuntime(), prop)
      : Reflect.get(resolveRuntime(), prop, receiver[0]);
  };
  const resolveLazyRuntimeDescriptor = (prop: PropertyKey): PropertyDescriptor | undefined => {
    // Once loaded, assignment through the proxy must see the owner's real descriptor.
    if (resolvedRuntime || !Object.hasOwn(LAZY_RUNTIME_PROPERTIES, prop)) {
      return Reflect.getOwnPropertyDescriptor(resolveRuntime() as object, prop);
    }
    const descriptor: PropertyDescriptor = {
      configurable: true,
      enumerable: true,
      get() {
        return getRuntimeProperty(prop);
      },
    };
    // Policy facets match defineCachedValue's getter-only contract before loading too.
    if (prop !== "modelAuth" && prop !== "modelConfig") {
      descriptor.set = (value: unknown) => {
        Reflect.set(resolveRuntime() as object, prop, value);
      };
    }
    return descriptor;
  };
  return new Proxy({} as PluginRuntime, {
    get: (_target, prop, receiver) => getRuntimeProperty(prop, receiver),
    set(_target, prop, value, receiver) {
      return Reflect.set(resolveRuntime(), prop, value, receiver);
    },
    has(_target, prop) {
      return Object.hasOwn(LAZY_RUNTIME_PROPERTIES, prop) || Reflect.has(resolveRuntime(), prop);
    },
    ownKeys() {
      return Object.keys(LAZY_RUNTIME_PROPERTIES);
    },
    getOwnPropertyDescriptor(_target, prop) {
      return resolveLazyRuntimeDescriptor(prop);
    },
    defineProperty(_target, prop, attributes) {
      return Reflect.defineProperty(resolveRuntime() as object, prop, attributes);
    },
    deleteProperty(_target, prop) {
      return Reflect.deleteProperty(resolveRuntime() as object, prop);
    },
    getPrototypeOf() {
      return Reflect.getPrototypeOf(resolveRuntime() as object);
    },
  });
}

function kindIncludes(kind: unknown, target: string): boolean {
  return kind === target || (Array.isArray(kind) && kind.includes(target));
}

export function formatBundledChannelWrongLoaderError(kind: unknown): string | null {
  if (kindIncludes(kind, "bundled-channel-setup-entry")) {
    return "bundled channel setup entry requires setup-runtime loader";
  }
  if (kindIncludes(kind, "bundled-channel-entry")) {
    return "bundled channel entry requires setup-runtime loader";
  }
  return null;
}

export type PluginModuleLoader = ReturnType<typeof createPluginModuleLoader>;
