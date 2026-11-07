import { randomUUID } from "node:crypto";
import Module, { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { NodePath } from "@babel/traverse";
import type { ImportDeclaration, ExportNamedDeclaration, ExportAllDeclaration } from "@babel/types";
import { isPathInside } from "../infra/path-guards.js";
import type { BunPluginRuntime } from "./native-module-require.js";
import { getPluginRuntimeConditions } from "./plugin-native-resolution.js";
import { PluginSnapshotDependencyError } from "./plugin-snapshot-dependency-error.js";
import { buildPluginTypeScriptSource, type PluginSourceLoadMode } from "./plugin-source-build.js";
import {
  installHooks,
  pathOf,
  registrySymbol,
  state,
  type Runtime,
  type VirtualModule,
} from "./plugin-source-snapshot-module-hooks.js";
import { resolvePluginSnapshotTsconfigPaths } from "./plugin-source-snapshot-options.js";
import { createPluginSnapshotRequireCache } from "./plugin-source-snapshot-require-cache.js";
import {
  createPluginSnapshotResolver,
  type PluginSnapshotResolutionSource,
  type PluginSnapshotResolvedModule,
} from "./plugin-source-snapshot-resolution.js";

const hostRequire = createRequire(import.meta.url);
type SnapshotReader = PluginSnapshotResolutionSource & {
  readVerifiedFile: (filename: string) => Buffer;
  assertMemberPath: (filename: string) => void;
  assertCurrent: () => void;
};
type Options = Parameters<typeof createPluginSnapshotResolver>[1] & {
  snapshot: SnapshotReader;
  /** The native admission owner verifies companions and admits this instance before evaluation. */
  loadNativeModule: (filename: string, verifiedBytes: Buffer) => unknown;
  /** Worker/fork facades remain under the generation's lifetime owner. */
  loadBuiltin?: (specifier: string) => unknown;
  /** Integrity failures from deferred imports must reach the installation owner too. */
  onInvalidSnapshot?: (error: unknown) => void;
  main?: boolean;
  mainFilename?: string;
  interceptSourcePaths?: boolean;
};
/** One evaluation namespace over shared files. Creation does not activate the snapshot reader. */
export function createPluginSharedSnapshotModuleLoader(options: Options) {
  const { snapshot } = options;
  const requireConditions = [...getPluginRuntimeConditions(true)];
  const importConditions = [...getPluginRuntimeConditions(false)];
  const resolver = createPluginSnapshotResolver(snapshot, {
    ...options,
    tsconfigPaths: options.tsconfigPaths ?? resolvePluginSnapshotTsconfigPaths(),
  });
  const id = randomUUID();
  const directory = path.join(snapshot.payloadRoot, `.openclaw-snapshot-instance-${id}`);
  const requireCache = createPluginSnapshotRequireCache({
    modulePath: resolver.modulePath,
    isMember: (filename) => snapshot.entries.has(resolver.canonicalPath(filename)),
    hostCache: hostRequire.cache,
    readJson: (filename) => JSON.parse(read(filename).toString("utf8")),
  });
  const { cache, entries: cacheEntries, jsonValue } = requireCache;
  const metas = new Map<string, Record<string, unknown>>();
  const targets = new Map<string, string>();
  const importers = new Map<
    string,
    (request: unknown, attributes?: ImportCallOptions) => Promise<unknown>
  >();
  const ownPaths = new Set<string>();
  const builtinOverrides = new Map<string, unknown>();
  const generated = new Map<string, string>();
  const detectedFormats = new Map<string, "module" | "commonjs">();
  const verifiedSources = new Map<string, string>();
  const jsxTranspilers = new Map<"jsx" | "tsx", { transformSync(source: string): string }>();
  const compilers = new Map<PluginSourceLoadMode, ReturnType<typeof buildPluginTypeScriptSource>>();
  let mainFilename = options.mainFilename && resolver.modulePath(options.mainFilename);
  let mainModule: NodeJS.Module | undefined;
  let disposed = false;
  const access = `globalThis[Symbol.for(${JSON.stringify(Symbol.keyFor(registrySymbol))})].instances.get(${JSON.stringify(id)})`;
  const verify = <T>(operation: () => T): T => {
    try {
      return operation();
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "PLUGIN_SOURCE_SNAPSHOT_INVALID"
      ) {
        options.onInvalidSnapshot?.(error);
      }
      throw error;
    }
  };
  const active = () => {
    if (disposed) {
      throw new Error("Plugin snapshot module loader has been disposed");
    }
    verify(() => snapshot.assertCurrent());
  };
  const read = (filename: string) => {
    active();
    const emitted = generated.get(filename);
    return emitted === undefined
      ? verify(() => snapshot.readVerifiedFile(filename))
      : Buffer.from(emitted);
  };
  const sourceText = (filename: string) => {
    const verified = verifiedSources.get(filename);
    verifiedSources.delete(filename);
    const source = verified ?? read(filename).toString("utf8");
    if (
      !process.versions.bun ||
      !["1", "true"].includes(process.env.JITI_JSX ?? "") ||
      !/\.[cm]?[jt]sx$/.test(filename)
    ) {
      return source;
    }
    const loader = filename.endsWith(".jsx") ? "jsx" : "tsx";
    let transpiler = jsxTranspilers.get(loader);
    if (!transpiler) {
      const bun: BunPluginRuntime = Reflect.get(globalThis, "Bun");
      transpiler = new bun.Transpiler({
        loader,
        tsconfig: {
          compilerOptions: {
            jsx: "react",
            jsxFactory: "React.createElement",
            jsxFragmentFactory: "React.Fragment",
          },
        },
      });
      jsxTranspilers.set(loader, transpiler);
    }
    return transpiler.transformSync(source);
  };
  const formatFor = (filename: string) => {
    const declared = resolver.format(filename);
    const bunTyped = process.versions.bun && /(?:\.[cm]?tsx?|\.jsx)$/.test(filename);
    if (declared !== "commonjs" || (!resolver.isAmbiguous(filename) && !bunTyped)) {
      return declared;
    }
    const prior = detectedFormats.get(filename);
    if (prior) {
      return prior;
    }
    const { parse }: typeof import("@babel/parser") = hostRequire("@babel/parser");
    const body = read(filename).toString("utf8");
    const parsed = parse(body, {
      sourceType: "unambiguous",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      plugins: resolver.syntaxPlugins(filename),
    });
    const format = parsed.program.sourceType === "module" ? "module" : "commonjs";
    detectedFormats.set(filename, format);
    verifiedSources.set(filename, body);
    return format;
  };
  const builtinOverride = (request: string) => {
    if (request === "node:module" || request === "module") {
      return moduleFacade;
    }
    if (!builtinOverrides.has(request)) {
      builtinOverrides.set(request, options.loadBuiltin?.(request));
    }
    return builtinOverrides.get(request);
  };
  const builtin = (request: string) => {
    return builtinOverride(request) ?? hostRequire(request);
  };
  const resolve = (
    from: string,
    request: string,
    requiring: boolean,
    paths?: string[],
  ): PluginSnapshotResolvedModule & { generated?: true } => {
    active();
    if (
      isPathInside(directory, pathOf(request)) &&
      Array.from(compilers.values()).some((compiler) => compiler.sourceForOutput(pathOf(request)))
    ) {
      return {
        filename: pathOf(request),
        canonical: pathOf(request),
        url: request.startsWith("file:") ? request : pathToFileURL(request).href,
        generated: true,
      };
    }
    return resolver.resolve(
      from,
      request,
      requiring ? requireConditions : importConditions,
      Boolean(requiring && process.versions.bun && /\.[cm]?tsx?$/.test(from)),
      paths,
    );
  };
  const addVirtual = (filename: string, module: VirtualModule) => {
    state.paths.set(filename, { runtime, module });
    ownPaths.add(filename);
    return pathToFileURL(filename).href;
  };
  const target = (
    selected: PluginSnapshotResolvedModule & { generated?: true },
    mode: PluginSourceLoadMode = "async",
  ) => {
    if (selected.external) {
      if (isBuiltin(selected.canonical) && builtinOverride(selected.canonical) !== undefined) {
        return targetFacade(selected.canonical);
      }
      return selected.url;
    }
    const suffix = new URL(selected.url).search + new URL(selected.url).hash;
    const format = selected.generated ? "module" : formatFor(selected.filename);
    if (selected.generated) {
      if (!ownPaths.has(selected.filename)) {
        addVirtual(selected.filename, {
          filename: selected.filename,
          suffix,
          format: "module",
          generated: true,
        });
      }
      return selected.url;
    }
    const compile = !process.versions.bun && /(?:\.[cm]?tsx?|\.jsx)$/.test(selected.filename);
    const key = `${resolver.modulePath(selected.filename)}\0${compile ? mode : ""}\0${format === "commonjs" && !process.versions.bun ? "" : suffix}`;
    const prior = targets.get(key);
    if (prior) {
      return prior + (format === "commonjs" && !process.versions.bun ? suffix : "");
    }
    let compiler = compile ? compilers.get(mode) : undefined;
    if (compile && !compiler) {
      compiler = buildPluginTypeScriptSource(snapshot.payloadRoot, {
        directory: path.join(directory, mode),
        readSource: sourceText,
        transformOutput: (filename, code, outputFormat, url) =>
          transform(
            code,
            filename,
            outputFormat === "commonjs",
            new URL(url).search + new URL(url).hash,
          ),
      });
      compilers.set(mode, compiler);
    }
    // Native JS imports keep named exports; Jiti views retain their existing interop.
    const compiled = compiler?.resolve(selected.filename, mode);
    const virtual =
      compiled && compiled !== selected.filename
        ? compiled
        : path.join(
            directory,
            `module-${targets.size}${format === "commonjs" ? ".cjs" : format === "json" ? ".json" : ".mjs"}`,
          );
    const value =
      addVirtual(virtual, {
        filename: selected.filename,
        suffix,
        format,
        ...(format === "addon" ? { native: true } : {}),
      }) + (compiled && compiled !== selected.filename ? suffix : "");
    targets.set(key, value);
    return value;
  };
  const targetFacade = (request: string) => {
    const filename = path.join(directory, `builtin-${request.replace(/[^a-z\d]/gi, "-")}.mjs`);
    if (!ownPaths.has(filename)) {
      addVirtual(filename, {
        filename: snapshot.rootDir,
        suffix: "",
        format: "module",
        facade: request,
      });
    }
    return pathToFileURL(filename).href;
  };
  const requireFor = (from: string): NodeJS.Require => {
    const native = createRequire(from);
    const load = (selected: PluginSnapshotResolvedModule & { generated?: true }) => {
      const url = target(selected, "sync");
      return requireCache.load(resolver.modulePath(selected.filename), pathOf(url), () =>
        hostRequire(url),
      );
    };
    const require = (request: string): unknown => {
      const selected = resolve(from, request, true);
      if (selected.external) {
        return isBuiltin(selected.canonical)
          ? builtin(selected.canonical)
          : hostRequire(selected.filename);
      }
      if (selected.generated) {
        return load(selected);
      }
      verify(() => snapshot.assertMemberPath(selected.filename));
      const pending = requireCache.injected(resolver.modulePath(selected.filename));
      if (pending) {
        return pending.exports;
      }
      const format = formatFor(selected.filename);
      if (format === "addon") {
        return verify(() => options.loadNativeModule(selected.filename, read(selected.filename)));
      }
      if (process.versions.bun && format === "commonjs") {
        return cjs(selected);
      }
      if (process.versions.bun && format === "json") {
        return requireCache.jsonModule(selected.filename, resolver.modulePath(selected.filename));
      }
      return load(selected);
    };
    const resolveRequest = Object.assign(
      (request: string, resolveOptions?: { paths?: string[] }) =>
        resolver.modulePath(resolve(from, request, true, resolveOptions?.paths).filename),
      native.resolve,
    );
    const scoped = Object.assign(require, native, { resolve: resolveRequest, cache });
    Object.defineProperty(scoped, "main", { get: () => mainModule });
    return scoped;
  };
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
          return requireFor(this.filename || path.join(snapshot.rootDir, "index.cjs"))(request);
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
          requireFor(parent?.filename || path.join(snapshot.rootDir, "index.cjs"))(request);
      }
      if (key === "_resolveFilename") {
        return (
          request: string,
          parent?: NodeJS.Module,
          _isMain?: boolean,
          resolveOptions?: { paths?: string[] },
        ) =>
          requireFor(parent?.filename || path.join(snapshot.rootDir, "index.cjs")).resolve(
            request,
            resolveOptions,
          );
      }
      return Reflect.get(original, key, receiver);
    },
  });
  const transform = (source: string, member: string, commonjs: boolean, suffix = "") => {
    const filename = resolver.modulePath(member);
    const { parse }: typeof import("@babel/parser") = hostRequire("@babel/parser");
    const { default: traverse }: typeof import("@babel/traverse") = hostRequire("@babel/traverse");
    const ast = parse(source, {
      sourceType: "unambiguous",
      createImportExpressions: true,
      allowReturnOutsideFunction: true,
      plugins: resolver.syntaxPlugins(filename),
    });
    const edits: Array<{ start: number; end: number; value: string }> = [];
    let bunRequire = false;
    const staticTarget = (
      declaration: NodePath<ImportDeclaration | ExportNamedDeclaration | ExportAllDeclaration>,
    ) => {
      const node = declaration.node.source;
      if (node?.start == null || node.end == null) {
        return;
      }
      edits.push({
        start: node.start,
        end: node.end,
        value: JSON.stringify(target(resolve(filename, node.value, false), "native")),
      });
    };
    traverse(ast, {
      "ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration": staticTarget,
      ReferencedIdentifier(identifier) {
        if (
          process.versions.bun &&
          identifier.node.name === "require" &&
          !identifier.scope.getBinding("require")
        ) {
          bunRequire = true;
        }
      },
      ImportExpression(expression) {
        if (expression.node.start == null) {
          return;
        }
        edits.push({
          start: expression.node.start,
          end: expression.node.start + 6,
          value: `${access}.importFor(${JSON.stringify(filename)})`,
        });
      },
      MetaProperty(meta) {
        if (meta.node.meta.name === "import" && meta.node.start != null && meta.node.end != null) {
          edits.push({
            start: meta.node.start,
            end: meta.node.end,
            value: `${access}.meta(${JSON.stringify(filename)},${JSON.stringify(suffix)})`,
          });
        }
      },
    });
    if (commonjs) {
      const position = ast.program.directives.at(-1)?.end ?? ast.program.interpreter?.end ?? 0;
      edits.push({
        start: position,
        end: position,
        value: `\nrequire=${access}.requireFor(${JSON.stringify(filename)}); module.require=require; Object.defineProperty(module,'constructor',{value:${access}.moduleFacade,writable:true,configurable:true}); __filename=${JSON.stringify(filename)}; __dirname=${JSON.stringify(path.dirname(filename))}; module.filename=__filename; module.id=__filename; module.path=__dirname; ${access}.registerModule(__filename,module);\n`,
      });
    } else if (bunRequire) {
      // Bun's implicit ESM require must retain the source anchor and the verified resolver.
      const position = ast.program.directives.at(-1)?.end ?? ast.program.interpreter?.end ?? 0;
      edits.push({
        start: position,
        end: position,
        value: `\nconst require=${access}.requireFor(${JSON.stringify(filename)});\n`,
      });
    }
    let output = source;
    for (const edit of edits.toSorted((a, b) => b.start - a.start || b.end - a.end)) {
      output = output.slice(0, edit.start) + edit.value + output.slice(edit.end);
    }
    return output;
  };
  const cjs = (selected: PluginSnapshotResolvedModule) => {
    const key = resolver.modulePath(selected.filename);
    const prior = cacheEntries[key];
    if (prior) {
      return prior.exports;
    }
    const module = new Module(key);
    module.filename = selected.filename;
    module.require = requireFor(selected.filename);
    cacheEntries[key] = module;
    try {
      const compile: (source: string, filename: string) => void = Reflect.get(
        module,
        "_compile",
      ).bind(module);
      compile(transform(sourceText(selected.filename), selected.filename, true), selected.filename);
      module.loaded = true;
      if (mainFilename === key) {
        module.id = ".";
        mainModule = module;
      }
      return module.exports;
    } catch (error) {
      delete cacheEntries[key];
      throw error;
    }
  };
  const runtime: Runtime = {
    requireFor,
    moduleFacade,
    loadNative(filename) {
      return verify(() => options.loadNativeModule(filename, read(filename)));
    },
    intercept(specifier, parent, requiring) {
      if (!options.interceptSourcePaths || isBuiltin(specifier)) {
        return undefined;
      }
      let candidate: URL;
      try {
        candidate = new URL(
          specifier,
          parent?.startsWith("file:")
            ? parent
            : pathToFileURL(parent || path.join(snapshot.rootDir, "index.cjs")),
        );
      } catch {
        return undefined;
      }
      if (candidate.protocol !== "file:") {
        return undefined;
      }
      const filename = fileURLToPath(candidate);
      if (!isPathInside(snapshot.payloadRoot, resolver.canonicalPath(filename))) {
        return undefined;
      }
      return target(
        resolve(
          parent ? pathOf(parent) : path.join(snapshot.rootDir, "index.cjs"),
          specifier,
          requiring,
        ),
        requiring ? "sync" : "native",
      );
    },
    registerModule(filename: string, module: NodeJS.Module) {
      cacheEntries[resolver.modulePath(filename)] = module;
      if (mainFilename === filename) {
        module.id = ".";
        mainModule = module;
      }
    },
    importFor(filename: string) {
      let importer = importers.get(filename);
      if (!importer) {
        importer = async (request: unknown, attributes?: ImportCallOptions) => {
          if (typeof request === "symbol") {
            throw new TypeError("Cannot convert a Symbol value to a string");
          }
          const value = await nativeImport(
            target(resolve(filename, String(request), false)),
            attributes,
          );
          return value &&
            typeof value === "object" &&
            Object.hasOwn(value, "openclaw:async-commonjs")
            ? Reflect.get(value, "openclaw:async-commonjs")
            : value;
        };
        importers.set(filename, importer);
      }
      return importer;
    },
    meta(filename: string, suffix: string) {
      const key = filename + suffix;
      let meta = metas.get(key);
      if (!meta) {
        meta = Object.assign(Object.create(null), {
          url: pathToFileURL(filename).href + suffix,
          filename,
          dirname: path.dirname(filename),
          main: mainFilename === filename,
          resolve: (request: string) => resolve(filename, request, false).url,
          ...(process.versions.bun
            ? {
                path: filename,
                dir: path.dirname(filename),
                file: path.basename(filename),
                require: requireFor(filename),
              }
            : {}),
        });
        metas.set(key, meta!);
      }
      return meta!;
    },
    assertMember(module: VirtualModule) {
      active();
      if (!module.facade && !module.generated) {
        verify(() => snapshot.assertMemberPath(module.filename));
      }
    },
    loadNode(module: VirtualModule) {
      active();
      if (module.trustedSource !== undefined) {
        return module.trustedSource;
      }
      if (module.facade) {
        return `const M=${access}.requireFor(${JSON.stringify(path.join(snapshot.rootDir, "index.cjs"))})(${JSON.stringify(module.facade)}); export default M; ${Object.keys(
          hostRequire(module.facade),
        )
          .filter((key) => /^[a-z_$][\w$]*$/iu.test(key))
          .map(
            (key, index) =>
              `const e${index}=M[${JSON.stringify(key)}];export {e${index} as ${key}};`,
          )
          .join("\n")}`;
      }
      if (module.native) {
        return `module.exports=${access}.loadNative(${JSON.stringify(module.filename)});`;
      }
      if (module.format === "addon") {
        throw new PluginSnapshotDependencyError(module.filename);
      }
      const source = sourceText(module.filename);
      return module.format === "json"
        ? source
        : transform(source, module.filename, module.format === "commonjs", module.suffix);
    },
    loadBun(
      module: VirtualModule,
    ):
      | { contents: string; loader: "js" | "tsx" }
      | { exports: Record<string, unknown>; loader: "object" } {
      active();
      if (module.native) {
        const value = runtime.loadNative(module.filename);
        return { exports: { ...Object(value), default: value }, loader: "object" };
      }
      if (module.format === "json") {
        return {
          exports: { default: jsonValue(module.filename, resolver.modulePath(module.filename)) },
          loader: "object",
        };
      }
      if (module.format === "commonjs") {
        const value: unknown = cjs({
          filename: module.filename,
          canonical: resolver.canonicalPath(module.filename),
          url: pathToFileURL(module.filename).href,
        });
        const exports =
          value && (typeof value === "object" || typeof value === "function") ? { ...value } : {};
        if (Reflect.get(Object(value), "__esModule")) {
          Reflect.deleteProperty(exports, "__esModule");
        } else {
          Object.assign(exports, { default: value });
        }
        return { exports, loader: "object" };
      }
      return {
        contents: runtime.loadNode(module),
        loader: /(?:\.[cm]?tsx?|\.jsx)$/.test(module.filename) ? "tsx" : "js",
      };
    },
    importModule(filename: string) {
      if (options.main) {
        mainFilename = resolver.modulePath(filename);
      }
      return runtime.importFor(filename)(pathToFileURL(filename).href);
    },
    requireModule(filename: string) {
      if (options.main) {
        mainFilename = resolver.modulePath(filename);
      }
      return requireFor(filename)(filename);
    },
    evaluateSource(source, { filename, format }) {
      if (options.main) {
        mainFilename = resolver.modulePath(filename);
      }
      generated.set(filename, source);
      const virtual = path.join(
        directory,
        `eval-${generated.size}${format === "module" ? ".mjs" : ".cjs"}`,
      );
      const url = addVirtual(virtual, { filename, suffix: "", format, generated: true });
      return format === "module"
        ? nativeImport(url)
        : process.versions.bun
          ? cjs({ filename, canonical: filename, url })
          : hostRequire(url);
    },
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      for (const filename of ownPaths) {
        state.paths.delete(filename);
        delete hostRequire.cache[filename];
      }
      ownPaths.clear();
      state.instances.delete(id);
      for (const compiler of compilers.values()) {
        compiler.dispose();
      }
      compilers.clear();
      requireCache.clear();
      metas.clear();
      importers.clear();
      targets.clear();
      generated.clear();
      verifiedSources.clear();
      jsxTranspilers.clear();
      detectedFormats.clear();
      builtinOverrides.clear();
    },
  };
  state.instances.set(id, runtime);
  installHooks();
  const importerPath = path.join(directory, "native-import.mjs");
  addVirtual(importerPath, {
    filename: importerPath,
    suffix: "",
    format: "module",
    generated: true,
    trustedSource: "export const load = (specifier, options) => import(specifier, options);",
  });
  const nativeImport = (specifier: string, attributes?: ImportCallOptions): Promise<unknown> => {
    const importer: {
      load: (specifier: string, attributes?: ImportCallOptions) => Promise<unknown>;
    } = hostRequire(pathToFileURL(importerPath).href);
    return importer.load(specifier, attributes);
  };
  return runtime;
}
