import Module from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { escapeRegExp } from "../shared/regexp.js";

export type VirtualModule = {
  filename: string;
  suffix: string;
  format: "module" | "commonjs" | "json" | "addon";
  facade?: string;
  generated?: true;
  trustedSource?: string;
  native?: true;
};
export type Runtime = {
  requireFor: (from: string) => NodeJS.Require;
  moduleFacade: typeof Module;
  registerModule: (filename: string, module: NodeJS.Module) => void;
  importFor: (
    filename: string,
  ) => (request: unknown, attributes?: ImportCallOptions) => Promise<unknown>;
  meta: (filename: string, suffix: string) => Record<string, unknown>;
  assertMember: (module: VirtualModule) => void;
  loadNode: (module: VirtualModule) => string;
  loadBun: (
    module: VirtualModule,
  ) =>
    | { contents: string; loader: "js" | "tsx" }
    | { exports: Record<string, unknown>; loader: "object" };
  importModule: (filename: string) => Promise<unknown>;
  requireModule: (filename: string) => unknown;
  evaluateSource: (
    source: string,
    options: { filename: string; format: "commonjs" | "module" },
  ) => unknown;
  dispose: () => void;
  intercept: (
    specifier: string,
    parent: string | undefined,
    requiring: boolean,
  ) => string | undefined;
  loadNative: (filename: string) => unknown;
};
type HookState = {
  instances: Map<string, Runtime>;
  paths: Map<string, { runtime: Runtime; module: VirtualModule }>;
  installed: boolean;
};
export const registrySymbol = Symbol.for("openclaw.pluginSharedSnapshotLoaders");
export const state = resolveGlobalSingleton<HookState>(registrySymbol, () => ({
  instances: new Map(),
  paths: new Map(),
  installed: false,
}));
type BunRuntime = {
  main: string;
  plugin: (plugin: {
    name: string;
    setup: (builder: {
      onResolve: (
        options: { filter: RegExp; namespace: "file" },
        callback: (args: {
          path: string;
          importer?: string;
          kind?: string;
        }) => { path: string; namespace: "file" } | undefined,
      ) => void;
      onLoad: (
        options: { filter: RegExp; namespace: "file" },
        callback: (args: {
          path: string;
        }) =>
          | { contents: string; loader: "js" | "tsx" }
          | { exports: Record<string, unknown>; loader: "object" }
          | undefined,
      ) => void;
    }) => void;
  }) => void;
};

export function pathOf(url: string) {
  return url.startsWith("file:") ? fileURLToPath(url) : url;
}

function validateImportAttributes(
  format: string,
  context: {
    conditions: readonly string[];
    importAttributes?: Record<string, string | undefined>;
  },
) {
  if (!context.conditions.includes("import")) {
    return;
  }
  const attributes = context.importAttributes ?? {};
  for (const [key, value] of Object.entries(attributes)) {
    if (key !== "type" || value !== "json") {
      throw Object.assign(new TypeError(`Unsupported import attribute ${key}: ${value}`), {
        code: "ERR_IMPORT_ATTRIBUTE_UNSUPPORTED",
      });
    }
  }
  if (format === "json" && attributes.type !== "json") {
    throw Object.assign(new TypeError('JSON module requires import attribute "type: json"'), {
      code: "ERR_IMPORT_ATTRIBUTE_MISSING",
    });
  }
  if (format !== "json" && attributes.type === "json") {
    throw Object.assign(new TypeError("Import attribute type is incompatible with this module"), {
      code: "ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE",
    });
  }
}

export function installHooks() {
  if (state.installed) {
    return;
  }
  // SAFETY: Bun defines this optional runtime global and plugin-hook API; Node leaves it absent.
  const bun = (globalThis as typeof globalThis & { Bun?: BunRuntime }).Bun;
  if (bun) {
    bun.plugin({
      name: "openclaw-shared-plugin-snapshot",
      setup(builder) {
        const filter = /[\\/]\.openclaw-snapshot-instance-[^\\/]+[\\/]/;
        builder.onResolve({ filter, namespace: "file" }, ({ path: request }) => {
          const filename = pathOf(request);
          return state.paths.has(filename) ? { path: filename, namespace: "file" } : undefined;
        });
        builder.onResolve(
          { filter: new RegExp(`^(?!${escapeRegExp(bun.main)}(?![\\s\\S]))`), namespace: "file" },
          ({ path: request, importer, kind }) => {
            for (const runtime of state.instances.values()) {
              const selected = runtime.intercept(
                request,
                importer,
                kind === "require-call" || kind === "require-resolve",
              );
              if (selected) {
                return { path: pathOf(selected), namespace: "file" };
              }
            }
            return undefined;
          },
        );
        builder.onLoad({ filter, namespace: "file" }, ({ path: request }) => {
          const owned = state.paths.get(pathOf(request));
          return owned?.runtime.loadBun(owned.module);
        });
      },
    });
  } else {
    Module.registerHooks({
      resolve(specifier, context, nextResolve) {
        const owned = state.paths.get(pathOf(specifier));
        if (!owned) {
          for (const runtime of state.instances.values()) {
            const selected = runtime.intercept(
              specifier,
              context.parentURL,
              context.conditions.includes("require"),
            );
            if (selected) {
              const intercepted = state.paths.get(pathOf(selected));
              if (intercepted) {
                runtime.assertMember(intercepted.module);
                validateImportAttributes(intercepted.module.format, context);
                return {
                  url: selected,
                  format: intercepted.module.native ? "commonjs" : intercepted.module.format,
                  shortCircuit: true,
                };
              }
            }
          }
          return nextResolve(specifier, context);
        }
        owned.runtime.assertMember(owned.module);
        validateImportAttributes(owned.module.format, context);
        return {
          url: specifier.startsWith("file:") ? specifier : pathToFileURL(specifier).href,
          format: owned.module.native ? "commonjs" : owned.module.format,
          shortCircuit: true,
        };
      },
      load(url, context, nextLoad) {
        const owned = state.paths.get(pathOf(url));
        if (!owned) {
          return nextLoad(url, context);
        }
        return {
          source: owned.runtime.loadNode(owned.module),
          format: owned.module.native ? "commonjs" : owned.module.format,
          shortCircuit: true,
        };
      },
    });
  }
  state.installed = true;
}
