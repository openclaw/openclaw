import { randomUUID } from "node:crypto";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { NodePath } from "@babel/traverse";
import type { Identifier } from "@babel/types";
import { stringifyNonErrorCause } from "@openclaw/normalization-core/error-coercion";
import { isPathInside } from "../infra/path-guards.js";
import { createJiti } from "./jiti-factory.js";
import { useNodeModuleHooks, type BunPluginRuntime } from "./native-module-require.js";
import { markPluginSourceAcquisitionError } from "./plugin-instance-error.js";

const require = createRequire(import.meta.url);

export function createPluginSnapshotSourceReader(read: (filename: string) => Buffer) {
  const verifiedSources = new Map<string, string>();
  const asyncSources = new Map<string, boolean>();
  const transpilers = new Map<"ts" | "jsx" | "tsx", { transformSync(source: string): string }>();
  const sourceText = (filename: string, stripTypes = false) => {
    const verified = verifiedSources.get(filename);
    verifiedSources.delete(filename);
    const source = verified ?? read(filename).toString("utf8");
    const jsx =
      ["1", "true"].includes(process.env.JITI_JSX ?? "") && /\.[cm]?[jt]sx$/.test(filename);
    if (!process.versions.bun || !(jsx || (stripTypes && /\.[cm]?tsx?$/.test(filename)))) {
      return source;
    }
    const loader = /[jt]sx$/.test(filename) ? (filename.endsWith("jsx") ? "jsx" : "tsx") : "ts";
    let transpiler = transpilers.get(loader);
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
      transpilers.set(loader, transpiler);
    }
    // Bun otherwise initializes these CommonJS globals with synthetic path defaults.
    return transpiler.transformSync(stripTypes ? `${source}\nvar __filename,__dirname;` : source);
  };
  return {
    sourceText,
    shouldCompile: (filename: string, mode: PluginSourceLoadMode) =>
      (!process.versions.bun || mode === "async") && /(?:\.[cm]?tsx?|\.jsx)$/.test(filename),
    modeFor(
      filename: string,
      format: string,
      requested: PluginSourceLoadMode,
    ): PluginSourceLoadMode {
      if (format !== "commonjs" || !/(?:\.[cm]?tsx?|\.jsx)$/.test(filename)) {
        return format === "module" && requested === "async" ? "native" : requested;
      }
      let asynchronous = asyncSources.get(filename);
      if (asynchronous === undefined) {
        const source = sourceText(filename);
        verifiedSources.set(filename, source);
        const { parse }: typeof import("@babel/parser") = require("@babel/parser");
        const { default: traverse }: typeof import("@babel/traverse") = require("@babel/traverse");
        const ast = parse(source, {
          sourceType: "unambiguous",
          allowAwaitOutsideFunction: true,
          allowReturnOutsideFunction: true,
          plugins: [
            "decorators-legacy",
            ...(!filename.endsWith(".jsx") ? ["typescript" as const] : []),
            ...(filename.endsWith("x") ? ["jsx" as const] : []),
          ],
        });
        asynchronous = false;
        traverse(ast, {
          "AwaitExpression|ForOfStatement|VariableDeclaration"(reference) {
            const node = reference.node;
            if (
              !reference.getFunctionParent() &&
              (node.type === "AwaitExpression" ||
                (node.type === "ForOfStatement" && node.await) ||
                (node.type === "VariableDeclaration" && node.kind === "await using"))
            ) {
              asynchronous = true;
              reference.stop();
            }
          },
        });
        asyncSources.set(filename, asynchronous);
      }
      return asynchronous ? "async" : "native";
    },
    remember: (filename: string, source: string) => verifiedSources.set(filename, source),
    dispose() {
      verifiedSources.clear();
      asyncSources.clear();
      transpilers.clear();
    },
  };
}

export const PLUGIN_SOURCE_RESOLVE_PREFIX = "openclaw-plugin-source-resolve:";

export type PluginSourceLoadMode = "sync" | "async" | "native";
export type PluginSourceFile = {
  source: string;
  mode?: PluginSourceLoadMode;
  nativeFormat?: string | null;
  generated?: true;
};

export function loadPluginSnapshotCompiledModule(
  compilers: Iterable<Pick<ReturnType<typeof buildPluginTypeScriptSource>, "loadSource">>,
  module: { filename: string; suffix: string },
) {
  for (const compiler of compilers) {
    const contents = compiler.loadSource(
      module.filename,
      pathToFileURL(module.filename).href + module.suffix,
    );
    if (contents !== undefined) {
      return { contents, loader: "js" as const };
    }
  }
  return undefined;
}

type MemorySourceBuild = {
  directory: string;
  readSource: (filename: string) => string;
  executionFilename: (filename: string) => string;
  transformOutput: (
    source: string,
    code: string,
    format: "module" | "commonjs",
    url: string,
  ) => string;
};

/** Compile captured source into a private namespace; native files stay with their capture owner. */
export function buildPluginTypeScriptSource(root: string, memory?: MemorySourceBuild) {
  if (!useNodeModuleHooks() && !memory) {
    throw new Error("Plugin source builds require Node module hooks");
  }
  const directory = memory?.directory ?? fs.mkdtempSync(path.join(path.dirname(root), ".source-"));
  const memoryOutputs = memory ? new Map<string, string>() : undefined;
  const executionUrls = new Map<string, { output: string; sourceUrl: string }>();
  const writeOutput = (filename: string, code: string) => {
    if (memoryOutputs) {
      memoryOutputs.set(filename, code);
    } else {
      fs.writeFileSync(filename, code, { flag: "wx", mode: 0o600 });
    }
  };
  const outputs = new Map<string, string>();
  const formats = new Map<string, "module" | "commonjs">();
  const failures = new Map<string, unknown>();
  const helpers = new Map<string, PluginSourceFile>();
  const sources = new Map<string, PluginSourceFile>();
  let disposed = false;
  const jiti = createJiti(root, { fsCache: false, moduleCache: false, tsconfigPaths: false });
  const { jsx, transform } = jiti.options;
  if (!transform) {
    throw new Error("Jiti source transformer is unavailable");
  }
  const dispose = () => {
    disposed = true;
    if (memoryOutputs) {
      memoryOutputs.clear();
    } else {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
  try {
    const compile = (input: string, destination: string, format: string | null | undefined) => {
      const { parse, parseExpression }: typeof import("@babel/parser") = require("@babel/parser");
      const { default: traverse }: typeof import("@babel/traverse") = require("@babel/traverse");
      const { default: generate }: typeof import("@babel/generator") = require("@babel/generator");
      const sourceText = memory ? memory.readSource(input) : fs.readFileSync(input, "utf8");
      const filename = memory?.executionFilename(input) ?? input;
      const mode = sources.get(destination)?.mode;
      const transformOptions = {
        sourcefile: filename,
        loader: input.endsWith(".jsx") ? "jsx" : input.endsWith("x") ? "tsx" : "ts",
        target: "es2022",
        supported: { "import-attributes": true },
        platform: "node",
        jsx: jsx ? "transform" : "preserve",
        tsconfigRaw: {
          compilerOptions: { experimentalDecorators: true, useDefineForClassFields: true },
        },
      } satisfies import("esbuild").TransformOptions;
      const createImportHelper = () => {
        const helper = path.join(path.dirname(destination), `.import-meta-${randomUUID()}.mjs`);
        writeOutput(
          helper,
          `import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const modules = createRequire(import.meta.url).cache;
const pendingImports = Symbol.for("openclaw.plugin.pendingImports");
export const bindRequire = (nativeRequire) => {
  // Only resolution can retry; evaluation below always runs once through Node.
  const select = (specifier, options) => {
    try {
      return { target: specifier, resolved: nativeRequire.resolve(specifier, options) };
    } catch (error) {
      if (!["MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_PACKAGE_IMPORT_NOT_DEFINED"].includes(error?.code)) throw error;
      const url = import.meta.resolve(specifier);
      const resolved = url.startsWith("file:") ? fileURLToPath(url) : url;
      return { target: resolved, resolved };
    }
  };
  const require = (specifier) => {
    const selected = select(specifier);
    const cached = modules[pathToFileURL(selected.resolved).href];
    return cached ? cached.exports : nativeRequire(selected.target);
  };
  const resolve = (specifier, options) => select(specifier, options).resolved;
  return Object.assign(require, nativeRequire, { resolve: Object.assign(resolve, nativeRequire.resolve) });
};
export const importModule = async (importer, specifier) => {
  const resolved = import.meta.resolve(specifier);
  const pending = importer[pendingImports] ??= new Set();
  pending.add(resolved);
  const cached = modules[resolved];
  const reachesImporter = (entry, seen = new Set()) => {
    if (!entry || seen.has(entry)) return false;
    if (entry === importer) return true;
    seen.add(entry);
    return [...(entry[pendingImports] ?? [])].some(url => reachesImporter(modules[url], seen));
  };
  let imported;
  try {
    // Partial exports break dependency cycles; concurrent callers must await initialization.
    imported = cached && (cached.loaded || reachesImporter(cached))
      ? { "openclaw:async-commonjs": await cached.exports }
      : await import(specifier);
  } finally {
    pending.delete(resolved);
  }
  if (new URL(resolved).pathname.endsWith(".json")) return imported.default;
  const namespace = Object.hasOwn(imported, "openclaw:async-commonjs")
    ? imported["openclaw:async-commonjs"] : imported;
  if (namespace === null || (typeof namespace !== "object" && typeof namespace !== "function")) return namespace;
  const fallback = namespace.default;
  const delegate = (typeof fallback === "object" || typeof fallback === "function") && !(fallback instanceof Promise);
  const values = new Map();
  return new Proxy(namespace, {
    get(target, key) {
      if (values.has(key)) return values.get(key);
      let value;
      if (key === "__esModule") value = true;
      else if (key === "default") {
        value = fallback == null ? namespace
          : typeof fallback?.default === "function" && namespace.__esModule ? fallback.default : fallback;
      } else if (key in target) value = target[key];
      else if (delegate) {
        value = fallback[key];
        if (typeof value === "function") value = value.bind(fallback);
      }
      values.set(key, value);
      return value;
    },
  });
};
export const resolve = (specifier, options) => {
  if (options === undefined) return import.meta.resolve(specifier);
  const query = ${JSON.stringify(PLUGIN_SOURCE_RESOLVE_PREFIX)} + encodeURIComponent(JSON.stringify([specifier, options]));
  return JSON.parse(decodeURIComponent(import.meta.resolve(query).slice("data:application/json,".length))).value;
};
`,
        );
        helpers.set(helper, { source: input, generated: true, mode: "async" });
        return helper;
      };
      if (mode === "sync" || mode === "async") {
        const asynchronous = mode === "async";
        const result = transform({
          source: sourceText,
          filename,
          ts: /\.[cm]?tsx?$/.test(input),
          jsx,
          async: asynchronous,
          interopDefault: true,
          ...(memory
            ? {
                babel: {
                  plugins: [
                    {
                      // The shared execution facade owns metadata, not Jiti's input path literals.
                      pre(file: { path: NodePath }) {
                        file.path.traverse({
                          MetaProperty(reference) {
                            if (
                              reference.node.meta.name === "import" &&
                              reference.node.property.name === "meta" &&
                              reference.parentPath.isMemberExpression()
                            ) {
                              reference.replaceWith({
                                type: "SequenceExpression",
                                expressions: [{ type: "NumericLiteral", value: 0 }, reference.node],
                              });
                              reference.skip();
                            }
                          },
                        });
                      },
                    },
                  ],
                },
              }
            : {}),
        });
        const error: unknown = result.error;
        if (error) {
          // Keep the existing source-relative syntax diagnostic, only on a failed Jiti transform.
          const { transformSync }: typeof import("esbuild") = require("esbuild");
          transformSync(sourceText, {
            ...transformOptions,
            sourcefile: path.relative(root, input),
          });
          throw markPluginSourceAcquisitionError(
            new SyntaxError(
              (error instanceof Error ? error.message : stringifyNonErrorCause(error)).replaceAll(
                filename,
                path.relative(root, input),
              ),
            ),
          );
        }
        const output = parse(result.code, {
          sourceType: memory ? "module" : "script",
          allowAwaitOutsideFunction: true,
          allowReturnOutsideFunction: true,
        });
        let needsHelper = asynchronous;
        if (!needsHelper) {
          // Jiti has erased types and lowered runtime bindings; never infer globals from TS syntax.
          traverse(output, {
            ReferencedIdentifier(reference) {
              if (!reference.isIdentifier()) {
                return;
              }
              const name = reference.node.name;
              if (
                ["require", "jitiImport", "jitiESMResolve"].includes(name) &&
                !reference.scope.getBinding(name)
              ) {
                needsHelper = true;
                reference.stop();
              }
            },
          });
        }
        const helper = needsHelper ? createImportHelper() : undefined;
        const header =
          parse(`__filename = ${JSON.stringify(filename)}; __dirname = ${JSON.stringify(path.dirname(filename))};
          ${
            helper
              ? `require = require(${JSON.stringify(helper)}).bindRequire(require("node:module").createRequire(${JSON.stringify(pathToFileURL(filename).href)}));
          const { resolve: jitiESMResolve } = require(${JSON.stringify(helper)});
          const jitiImport = require(${JSON.stringify(helper)}).importModule.bind(null, module);
          ${asynchronous ? "module.require = require;" : ""}`
              : ""
          }`);
        // Babel keeps directives separately, so the loader bindings follow "use strict".
        output.program.body.unshift(...header.program.body);
        const code = generate(output).code;
        const emitted = asynchronous
          ? `import Module, { createRequire } from "node:module";
const owner = new Module(${JSON.stringify(filename)});
owner.filename = ${JSON.stringify(filename)};
owner.paths = Module._nodeModulePaths(${JSON.stringify(path.dirname(filename))});
const require = createRequire(import.meta.url);
// Publish partial exports before awaiting dependencies; URL keys preserve import query identity.
require.cache[import.meta.url] = owner;
let value;
try {
  await (async function(exports, require, module, __filename, __dirname) {
${code}
  })(owner.exports, require, owner);
  value = await owner.exports;
  owner.loaded = true;
} catch (error) {
  delete require.cache[import.meta.url];
  throw error;
}
export { value as "openclaw:async-commonjs" };`
          : code;
        formats.set(destination, asynchronous ? "module" : "commonjs");
        if (memory) {
          writeOutput(destination, emitted);
        } else {
          fs.writeFileSync(destination, emitted, { mode: 0o600 });
        }
        return;
      }
      const { transformSync }: typeof import("esbuild") = require("esbuild");
      // Analyze runtime JavaScript so erased types, legacy syntax and value scopes share one owner.
      const analysis = transformSync(sourceText, {
        ...transformOptions,
        sourcefile: path.relative(root, input),
      }).code;
      let parsed: ReturnType<typeof parse>;
      try {
        parsed = parse(analysis, {
          sourceFilename: filename,
          sourceType: "unambiguous",
          allowAwaitOutsideFunction: true,
          allowReturnOutsideFunction: true,
          plugins: input.endsWith("x") ? ["jsx"] : [],
        });
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw markPluginSourceAcquisitionError(
            new SyntaxError(`${path.relative(root, input)}: ${error.message}`, {
              cause: error,
            }),
          );
        }
        throw error;
      }
      let usesCommonJs = false;
      let explicitInterop = false;
      let wildcardExports = false;
      let loader = "";
      let factory = "";
      let namespace = "";
      const globals: NodePath<Identifier>[] = [];
      traverse(parsed, {
        Program(program) {
          loader = program.scope.generateUidIdentifier("pluginRequire").name;
          factory = program.scope.generateUidIdentifier("createPluginRequire").name;
          namespace = program.scope.generateUidIdentifier("pluginNamespace").name;
        },
        ReferencedIdentifier(reference) {
          if (!reference.isIdentifier()) {
            return;
          }
          const name = reference.node.name;
          if (reference.scope.getBinding(name)) {
            return;
          }
          if (name === "module" || name === "exports") {
            usesCommonJs = true;
          }
          if (["require", "__filename", "__dirname"].includes(name)) {
            globals.push(reference);
          }
        },
        ExportNamedDeclaration(declaration) {
          explicitInterop ||= declaration.node.specifiers.some((specifier) =>
            specifier.exported.type === "StringLiteral"
              ? specifier.exported.value === "module.exports"
              : specifier.exported.name === "module.exports",
          );
        },
        ExportAllDeclaration() {
          wildcardExports = true;
        },
      });
      const native = mode === "native";
      const nativeModule = native && (format === "module" || format === "module-typescript");
      const nativeCommonJs = native && (format === "commonjs" || format === "commonjs-typescript");
      const esm =
        nativeModule ||
        (!nativeCommonJs &&
          (/\.mtsx?$/.test(input) ||
            (!/\.ctsx?$/.test(input) && parsed.program.sourceType === "module" && !usesCommonJs)));
      formats.set(destination, esm ? "module" : "commonjs");
      let needsRequire = false;
      for (const reference of globals) {
        const name = reference.node.name;
        if (name === "require" && !esm) {
          continue;
        }
        const replacement =
          name === "require"
            ? parseExpression(loader)
            : parseExpression(
                JSON.stringify(name === "__filename" ? filename : path.dirname(filename)),
              );
        needsRequire ||= name === "require";
        if (reference.parentPath.isObjectProperty() && reference.key === "value") {
          reference.parentPath.node.shorthand = false;
        }
        reference.replaceWith(replacement);
      }
      if (esm) {
        const header = parse(
          `
          ${
            needsRequire
              ? `import { createRequire as ${factory} } from "node:module";
          const ${loader} = ${factory}(${JSON.stringify(pathToFileURL(filename).href)});`
              : ""
          }
          import.meta.url = ${JSON.stringify(pathToFileURL(filename).href)};
          import.meta.filename = ${JSON.stringify(filename)};
          import.meta.dirname = ${JSON.stringify(path.dirname(filename))};`,
          { sourceType: "module" },
        );
        if (memory) {
          // Generated assignments must not overwrite the execution URL's query or fragment.
          header.program.body = header.program.body.filter(
            (statement) => statement.type !== "ExpressionStatement",
          );
        }
        parsed.program.body.unshift(...header.program.body);
        if (wildcardExports && !explicitInterop) {
          // A CJS wildcard must not replace this source module's require(ESM) namespace.
          parsed.program.body.push(
            ...parse(
              `import * as ${namespace} from ${JSON.stringify(pathToFileURL(destination).href)};
            export { ${namespace} as "module.exports" };`,
              { sourceType: "module" },
            ).program.body,
          );
        }
      }
      const emitted = transformSync(generate(parsed).code, {
        ...transformOptions,
        format: esm ? "esm" : "cjs",
      });
      if (memory) {
        writeOutput(destination, emitted.code);
      } else {
        fs.writeFileSync(destination, emitted.code, { mode: 0o600 });
      }
    };
    // The capture owner resolves inputs; this hook only compiles and labels owned outputs.
    const hooks = useNodeModuleHooks()
      ? Module.registerHooks({
          load(url, context, nextLoad) {
            const execution = executionUrls.get(url);
            const filename =
              execution?.output ?? (url.startsWith("file:") ? fileURLToPath(url) : undefined);
            if (filename) {
              const entry = sources.get(filename);
              if (entry && !formats.has(filename) && !failures.has(filename)) {
                try {
                  if (!memory && entry.mode && entry.mode !== "native") {
                    entry.mode = context.conditions.includes("require") ? "sync" : "async";
                  }
                  compile(entry.source, filename, entry.nativeFormat ?? context.format);
                } catch (error) {
                  failures.set(filename, error);
                }
              }
            }
            if (filename && failures.has(filename)) {
              throw failures.get(filename);
            }
            const format = filename && formats.get(filename);
            if (memory && filename && memoryOutputs?.has(filename)) {
              const entry = sources.get(filename) ?? helpers.get(filename);
              if (entry) {
                const outputFormat = format || "module";
                return {
                  format: outputFormat,
                  source: memory.transformOutput(
                    entry.source,
                    memoryOutputs.get(filename)!,
                    outputFormat,
                    execution?.sourceUrl ?? url,
                  ),
                  shortCircuit: true,
                };
              }
            }
            return nextLoad(url, format ? { ...context, format } : context);
          },
        })
      : undefined;
    return {
      directory,
      loadSource(source: string, url: string) {
        const filename = outputs.get(source) ?? source;
        const entry = sources.get(filename) ?? helpers.get(filename);
        if (!memory || !entry) {
          return undefined;
        }
        if (sources.has(filename) && !formats.has(filename) && !failures.has(filename)) {
          try {
            compile(entry.source, filename, entry.nativeFormat);
          } catch (error) {
            failures.set(filename, error);
          }
        }
        if (failures.has(filename)) {
          throw failures.get(filename);
        }
        const code = memoryOutputs?.get(filename);
        return code === undefined
          ? undefined
          : memory.transformOutput(entry.source, code, formats.get(filename) ?? "module", url);
      },
      resolve: (source: string, mode?: PluginSourceLoadMode, nativeFormat?: string | null) => {
        if (disposed) {
          throw new Error("Plugin source view has been disposed");
        }
        let filename = outputs.get(source);
        let entry = filename && sources.get(filename);
        if (
          !filename &&
          isPathInside(root, source) &&
          (memory || !path.relative(root, source).split(path.sep).includes("node_modules")) &&
          (/\.[cm]?tsx?$/.test(source) || (jsx && source.endsWith(".jsx"))) &&
          !/\.d\.[cm]?ts$/.test(source)
        ) {
          // Resolve-only callers need an existing stable path, but no compilation or root walk.
          filename = path.join(directory, `module-${outputs.size}.js`);
          writeOutput(filename, "");
          outputs.set(source, filename);
          entry = { source };
          sources.set(filename, entry);
        }
        // Resolution may inspect a source before executing it. Only compilation fixes its mode.
        if (filename && entry && !formats.has(filename)) {
          entry.mode = mode ?? entry.mode ?? "native";
          entry.nativeFormat = nativeFormat ?? entry.nativeFormat;
        }
        return filename ?? source;
      },
      bindExecutionUrl(output: string, url: string, sourceUrl: string) {
        executionUrls.set(url, { output, sourceUrl });
      },
      sourceForOutput: (file: string) =>
        sources.get(outputs.get(file) ?? file) ?? helpers.get(file),
      dispose: () => {
        hooks?.deregister();
        executionUrls.clear();
        dispose();
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
