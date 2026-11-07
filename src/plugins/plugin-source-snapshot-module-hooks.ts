import Module, { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { escapeRegExp } from "../shared/regexp.js";
import type { PluginSnapshotDispatch } from "./plugin-source-snapshot-dispatch.js";

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
  dispatch: PluginSnapshotDispatch;
  compileCommonJs: (module: NodeJS.Module, filename: string, source: string) => unknown;
  requireFor: (from: string) => NodeJS.Require;
  resolveFrom: (from: string, specifier: string, requiring: boolean) => string;
  moduleFacade: typeof Module;
  registerModule: (filename: string, module: NodeJS.Module, suffix?: string) => void;
  importFor: (
    filename: string,
    compiled?: boolean,
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

export function createPluginSnapshotHookResolver<T extends { url: string; external?: true }>(
  modulePath: (filename: string) => string,
  resolve: (from: string, request: string, requiring: boolean, paths?: string[]) => T,
) {
  const externalRequests = new Map<string, string>();
  const key = (from: string, requiring: boolean, url: string) =>
    `${modulePath(from)}\0${requiring}\0${url}`;
  const tracked: typeof resolve = (from, request, requiring, paths) => {
    assertPluginSnapshotSourceRequest(request);
    const result = resolve(from, request, requiring, paths);
    if (result.external && !isBuiltin(result.url)) {
      externalRequests.set(key(from, requiring, result.url), request);
    }
    return result;
  };
  return Object.assign(tracked, {
    // Only native rewritten edges recover an alias, then revalidate it through the source resolver.
    fromHook: (from: string, request: string, requiring: boolean) =>
      tracked(from, externalRequests.get(key(from, requiring, request)) ?? request, requiring),
    dispose: () => externalRequests.clear(),
  });
}

export function registerPluginSnapshotVirtualModule(
  runtime: Runtime,
  ownPaths: Set<string>,
  filename: string,
  module: VirtualModule,
  canonicalPath: (filename: string) => string,
) {
  const url = filename.startsWith("file:") ? filename : pathToFileURL(filename).href;
  const keys = [filename];
  if (filename.startsWith("file:") && process.versions.bun) {
    const canonical = new URL(url);
    canonical.pathname = pathToFileURL(canonicalPath(fileURLToPath(url))).pathname;
    keys.push(
      url,
      fileURLToPath(url) + canonical.search + canonical.hash,
      canonical.href,
      fileURLToPath(canonical) + canonical.search + canonical.hash,
    );
  }
  for (const key of keys) {
    state.paths.set(key, { runtime, module });
    ownPaths.add(key);
  }
  return url;
}

export function createPluginSnapshotInteropTarget(
  directory: string,
  targets: Map<string, string>,
  addVirtual: (filename: string, module: VirtualModule) => string,
) {
  return (url: string) => {
    const key = `interop\0${url}`;
    const prior = targets.get(key);
    if (prior) {
      return prior;
    }
    const filename = path.join(directory, `interop-${targets.size}.mjs`);
    const source = JSON.stringify(url);
    const value = addVirtual(filename, {
      filename,
      suffix: "",
      format: "module",
      generated: true,
      // Typed callers retain Jiti default interop over the same verified CommonJS instance.
      trustedSource: `import * as namespace from ${source}; export * from ${source}; const value=Object.hasOwn(namespace,"openclaw:async-commonjs")?namespace["openclaw:async-commonjs"]:namespace.default; export default value?.__esModule ? value.default : value;`,
    });
    targets.set(key, value);
    return value;
  };
}

export function createPluginSnapshotBuiltinTarget(
  directory: string,
  rootDir: string,
  ownPaths: Set<string>,
  addVirtual: (filename: string, module: VirtualModule) => string,
) {
  return (request: string) => {
    const filename = path.join(directory, `builtin-${request.replace(/[^a-z\d]/gi, "-")}.mjs`);
    if (!ownPaths.has(filename)) {
      addVirtual(filename, {
        filename: rootDir,
        suffix: "",
        format: "module",
        facade: request,
      });
    }
    return pathToFileURL(filename).href;
  };
}

export function createPluginSnapshotBuiltinSource(
  request: string,
  access: string,
  rootDir: string,
  hostRequire: NodeJS.Require,
) {
  return `const M=${access}.requireFor(${JSON.stringify(path.join(rootDir, "index.cjs"))})(${JSON.stringify(request)}); export default M; ${Object.keys(
    hostRequire(request),
  )
    .filter((key) => /^[a-z_$][\w$]*$/iu.test(key))
    .map((key, index) => `const e${index}=M[${JSON.stringify(key)}];export {e${index} as ${key}};`)
    .join("\n")}`;
}

export function createPluginSnapshotModuleFacade(
  requireFor: (from: string) => NodeJS.Require,
  cache: NodeJS.Dict<NodeJS.Module>,
  rootDir: string,
): typeof Module {
  const scopedCreateRequire = (anchor: string | URL) => {
    createRequire(anchor);
    return requireFor(anchor instanceof URL ? fileURLToPath(anchor) : pathOf(anchor));
  };
  const modulePrototype = new Proxy(Module.prototype, {
    get(original, key, receiver) {
      if (key === "constructor") {
        return moduleFacade;
      }
      if (key === "require") {
        return function (this: NodeJS.Module, request: string) {
          return requireFor(this.filename || path.join(rootDir, "index.cjs"))(request);
        };
      }
      return Reflect.get(original, key, receiver);
    },
  });
  const moduleFacade: typeof Module = new Proxy(Module, {
    get(original, key, receiver) {
      if (key === "createRequire") {
        return scopedCreateRequire;
      }
      if (key === "Module") {
        return moduleFacade;
      }
      if (key === "prototype") {
        return modulePrototype;
      }
      if (key === "_cache") {
        return cache;
      }
      if (key === "_load") {
        return (request: string, parent?: NodeJS.Module) =>
          requireFor(parent?.filename || path.join(rootDir, "index.cjs"))(request);
      }
      if (key === "_resolveFilename") {
        return (
          request: string,
          parent?: NodeJS.Module,
          _isMain?: boolean,
          resolveOptions?: { paths?: string[] },
        ) =>
          requireFor(parent?.filename || path.join(rootDir, "index.cjs")).resolve(
            request,
            resolveOptions,
          );
      }
      return Reflect.get(original, key, receiver);
    },
  });
  return moduleFacade;
}

export function createPluginSnapshotNativeImporter(
  directory: string,
  addVirtual: (filename: string, module: VirtualModule) => string,
  require: NodeJS.Require,
) {
  // Bun exposes ESM namespaces to require; Node must also work when require(ESM) is disabled.
  const esm = Boolean(process.versions.bun);
  const filename = path.join(directory, esm ? "native-import.mjs" : "native-import.cjs");
  const url = addVirtual(filename, {
    filename,
    suffix: "",
    format: esm ? "module" : "commonjs",
    generated: true,
    trustedSource: `${esm ? "export const load" : "exports.load"} = (specifier, options) => import(specifier, options);`,
  });
  return (specifier: string, attributes?: ImportCallOptions): Promise<unknown> => {
    const importer: {
      load: (specifier: string, attributes?: ImportCallOptions) => Promise<unknown>;
    } = require(url);
    return importer.load(specifier, attributes);
  };
}

export function withPluginSnapshotJsonAttribute(
  attributes?: ImportCallOptions,
): ImportCallOptions | undefined {
  if (attributes !== undefined && (attributes === null || typeof attributes !== "object")) {
    return attributes;
  }
  const supplied = attributes?.with;
  if (
    supplied !== undefined &&
    (supplied === null || typeof supplied !== "object" || Object.hasOwn(supplied, "type"))
  ) {
    return attributes;
  }
  return { ...attributes, with: { ...supplied, type: "json" } };
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

function ownedModule(request: string) {
  const exact = state.paths.get(request);
  if (exact) {
    return exact;
  }
  if (request.startsWith("file:")) {
    try {
      const url = new URL(request);
      if ((url.search || url.hash) && isInternalLocator(request)) {
        return undefined;
      }
    } catch {
      return undefined;
    }
  }
  return state.paths.get(pathOf(request));
}

const internalLocatorCandidate = /[?%\t\n\r\f\v]|\.openclaw-snapshot-instance-/iu;

export function assertPluginSnapshotSourceRequest(request: string) {
  if (
    request.includes("?") &&
    new URL(request, "file:///").searchParams.has("__openclaw_instance")
  ) {
    throw new Error("Plugin snapshot execution query is reserved");
  }
}

function isInternalLocator(request: string): boolean {
  if (!internalLocatorCandidate.test(request)) {
    return false;
  }
  let filename = request;
  const query = request.slice(request.indexOf("?") + 1).split("#", 1)[0];
  let tagged = request.includes("?") && new URLSearchParams(query).has("__openclaw_instance");
  try {
    const url = new URL(request, "file:///");
    if (url.protocol === "file:") {
      tagged ||= url.searchParams.has("__openclaw_instance");
      filename = fileURLToPath(url);
    }
  } catch {
    // A malformed internal locator still belongs to the closed namespace.
  }
  return tagged || /(?:^|[\\/])\.openclaw-snapshot-instance-[^\\/]+(?:[\\/]|$)/iu.test(filename);
}

function rejectUnownedInternal(request: string | undefined) {
  if (request && isInternalLocator(request)) {
    throw new Error("Plugin snapshot module URL is unregistered or disposed");
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
        const filter = /(?:[\\/]\.openclaw-snapshot-instance-[^\\/]+[\\/]|[?%])/i;
        builder.onResolve({ filter, namespace: "file" }, ({ path: request }) => {
          const filename = state.paths.has(request) ? request : pathOf(request);
          if (ownedModule(request)) {
            return { path: filename, namespace: "file" };
          }
          rejectUnownedInternal(request);
          return undefined;
        });
        builder.onResolve(
          { filter: new RegExp(`^(?!${escapeRegExp(bun.main)}(?![\\s\\S]))`), namespace: "file" },
          ({ path: request, importer, kind }) => {
            if (!ownedModule(request)) {
              rejectUnownedInternal(request);
            }
            if (importer && !ownedModule(importer)) {
              rejectUnownedInternal(importer);
            }
            for (const runtime of state.instances.values()) {
              const selected = runtime.intercept(
                request,
                importer,
                kind === "require-call" || kind === "require-resolve",
              );
              if (selected) {
                if (!ownedModule(selected)) {
                  rejectUnownedInternal(selected);
                }
                const url = new URL(selected);
                return { path: pathOf(selected) + url.search + url.hash, namespace: "file" };
              }
            }
            return undefined;
          },
        );
        // Bun has no undefined onLoad fallback; ordinary host query URLs must stay native.
        const loadFilter =
          /(?:[\\/]\.openclaw-snapshot-instance-[^\\/]+[\\/]|[?&]__openclaw_instance=)/i;
        builder.onLoad({ filter: loadFilter, namespace: "file" }, ({ path: request }) => {
          const owned = ownedModule(request);
          if (!owned) {
            rejectUnownedInternal(request);
          }
          return owned?.runtime.loadBun(owned.module);
        });
      },
    });
  } else {
    Module.registerHooks({
      resolve(specifier, context, nextResolve) {
        const owned = ownedModule(specifier);
        if (!owned) {
          rejectUnownedInternal(specifier);
          const parent = context.parentURL ? ownedModule(context.parentURL) : undefined;
          if (!parent) {
            rejectUnownedInternal(context.parentURL);
          }
          const requiring = context.conditions.includes("require");
          for (const runtime of parent ? [parent.runtime] : state.instances.values()) {
            // Node scans CJS re-exports before the source-bound require prelude executes.
            const selected =
              parent && !parent.module.generated && !parent.module.facade && !isBuiltin(specifier)
                ? runtime.resolveFrom(parent.module.filename, specifier, requiring)
                : runtime.intercept(specifier, context.parentURL, requiring);
            if (selected) {
              const intercepted = ownedModule(selected);
              if (intercepted) {
                runtime.assertMember(intercepted.module);
                validateImportAttributes(intercepted.module.format, context);
                return {
                  url: selected,
                  format: intercepted.module.native ? "commonjs" : intercepted.module.format,
                  shortCircuit: true,
                };
              }
              rejectUnownedInternal(selected);
              const resolved = nextResolve(requiring ? pathOf(selected) : selected, context);
              return requiring && resolved.format == null && pathOf(resolved.url).endsWith(".cjs")
                ? { ...resolved, format: "commonjs" }
                : resolved;
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
        const owned = ownedModule(url);
        if (!owned) {
          rejectUnownedInternal(url);
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
