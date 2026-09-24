import { randomUUID } from "node:crypto";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Binding, NodePath } from "@babel/traverse";
import type { Identifier } from "@babel/types";
import { stringifyNonErrorCause } from "@openclaw/normalization-core/error-coercion";
import { isPathInside } from "../infra/path-guards.js";
import { createJiti } from "./jiti-factory.js";

const require = createRequire(import.meta.url);

export const PLUGIN_SOURCE_RESOLVE_PREFIX = "openclaw-plugin-source-resolve:";

export type PluginSourceLoadMode = "sync" | "async" | "native";
export type PluginSourceFile = {
  source: string;
  mode?: PluginSourceLoadMode;
  nativeFormat?: string | null;
  generated?: true;
};

/** Compile captured source into a private namespace; native files stay with their capture owner. */
export function buildPluginTypeScriptSource(root: string) {
  const directory = fs.mkdtempSync(path.join(path.dirname(root), ".source-"));
  const outputs = new Map<string, string>();
  const formats = new Map<string, "module" | "commonjs">();
  const failures = new Map<string, unknown>();
  const helpers = new Map<string, PluginSourceFile>();
  const sources = new Map<string, PluginSourceFile>();
  const included = new Set<string>();
  let disposed = false;
  const jiti = createJiti(root, { fsCache: false, moduleCache: false, tsconfigPaths: false });
  const { jsx, transform } = jiti.options;
  if (!transform) {
    throw new Error("Jiti source transformer is unavailable");
  }
  const include = (source: string) => {
    if (!isPathInside(root, source) || included.has(source)) {
      return;
    }
    included.add(source);
    const parts = path.relative(root, source).split(path.sep);
    if (parts.includes("node_modules")) {
      return;
    }
    if (fs.lstatSync(source).isDirectory()) {
      for (const name of fs.readdirSync(source).toSorted()) {
        include(path.join(source, name));
      }
    } else if (
      (/\.[cm]?tsx?$/.test(source) || (jsx && source.endsWith(".jsx"))) &&
      !/\.d\.[cm]?ts$/.test(source)
    ) {
      // The namespace contains generated files only, including after package promotion.
      const emitted = path.join(directory, `module-${outputs.size}.js`);
      outputs.set(source, emitted);
      sources.set(emitted, { source });
      fs.writeFileSync(emitted, "", { flag: "wx", mode: 0o600 });
    }
  };
  const dispose = () => {
    disposed = true;
    fs.rmSync(directory, { recursive: true, force: true });
  };
  try {
    for (const name of fs.readdirSync(root).toSorted()) {
      include(path.join(root, name));
    }
    const compile = (input: string, destination: string, format: string | null | undefined) => {
      const { parse, parseExpression }: typeof import("@babel/parser") = require("@babel/parser");
      const { default: traverse }: typeof import("@babel/traverse") = require("@babel/traverse");
      const { default: generate }: typeof import("@babel/generator") = require("@babel/generator");
      const sourceText = fs.readFileSync(input, "utf8");
      const mode = sources.get(destination)?.mode;
      const nativeOptions = {
        sourcefile: input,
        loader: input.endsWith(".jsx") ? "jsx" : input.endsWith("x") ? "tsx" : "ts",
        target: "es2022",
        supported: { "import-attributes": true },
        platform: "node",
        jsx: jsx ? "transform" : "preserve",
        tsconfigRaw: {
          compilerOptions: { experimentalDecorators: true, useDefineForClassFields: true },
        },
      } satisfies import("esbuild").TransformOptions;
      let parsed: ReturnType<typeof parse>;
      try {
        parsed = parse(sourceText, {
          sourceFilename: input,
          sourceType: "unambiguous",
          allowAwaitOutsideFunction: true,
          allowReturnOutsideFunction: true,
          plugins: [
            ...(/\.[cm]?tsx?$/.test(input) ? ["typescript" as const] : []),
            "decorators-legacy",
            "importAssertions",
            ...(input.endsWith("x") ? ["jsx" as const] : []),
          ],
        });
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new SyntaxError(`${path.relative(root, input)}: ${error.message}`, {
            cause: error,
          });
        }
        throw error;
      }
      if (mode !== "sync" && mode !== "async") {
        // Babel scopes omit TypeScript value bindings, including merged namespaces and enums.
        const { transformSync }: typeof import("esbuild") = require("esbuild");
        parsed = parse(transformSync(sourceText, nativeOptions).code, {
          sourceFilename: input,
          sourceType: "unambiguous",
          allowAwaitOutsideFunction: true,
          allowReturnOutsideFunction: true,
          plugins: input.endsWith("x") ? ["jsx"] : [],
        });
      }
      const runtimeBinding = (binding: Binding | undefined) => {
        if (!binding) {
          return false;
        }
        const declaration = binding.path;
        if (
          declaration.isTSTypeAliasDeclaration() ||
          declaration.isTSInterfaceDeclaration() ||
          ("declare" in declaration.node && declaration.node.declare) ||
          (declaration.parentPath?.isVariableDeclaration() && declaration.parentPath.node.declare)
        ) {
          return false;
        }
        const imported = declaration.findParent((candidate) => candidate.isImportDeclaration());
        return !(
          (imported?.isImportDeclaration() && imported.node.importKind === "type") ||
          (declaration.isImportSpecifier() && declaration.node.importKind === "type") ||
          (declaration.isTSImportEqualsDeclaration() && declaration.node.importKind === "type")
        );
      };
      let usesCommonJs = false;
      let needsHelper = false;
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
          if (
            !reference.isIdentifier() ||
            reference.findParent(
              (candidate) => candidate.isTSType() || candidate.isTSTypeAnnotation(),
            )
          ) {
            return;
          }
          const name = reference.node.name;
          if (runtimeBinding(reference.scope.getBinding(name))) {
            return;
          }
          if (name === "module" || name === "exports") {
            usesCommonJs = true;
          }
          if (["require", "__filename", "__dirname"].includes(name)) {
            globals.push(reference);
            needsHelper ||= name === "require";
          }
        },
        TSExportAssignment() {
          usesCommonJs = true;
        },
        ImportDeclaration(declaration) {
          needsHelper ||= declaration.node.importKind !== "type";
        },
        TSImportEqualsDeclaration(declaration) {
          needsHelper ||=
            declaration.node.importKind !== "type" &&
            declaration.node.moduleReference.type === "TSExternalModuleReference";
        },
        ExportNamedDeclaration(declaration) {
          needsHelper ||=
            declaration.node.exportKind !== "type" && Boolean(declaration.node.source);
          explicitInterop ||=
            declaration.node.exportKind !== "type" &&
            declaration.node.specifiers.some(
              (specifier) =>
                (specifier.type !== "ExportSpecifier" || specifier.exportKind !== "type") &&
                (specifier.exported.type === "StringLiteral"
                  ? specifier.exported.value === "module.exports"
                  : specifier.exported.name === "module.exports"),
            );
        },
        ExportAllDeclaration(declaration) {
          needsHelper ||= declaration.node.exportKind !== "type";
          wildcardExports ||= declaration.node.exportKind !== "type";
        },
        CallExpression(call) {
          needsHelper ||= call.node.callee.type === "Import";
        },
        MemberExpression(member) {
          needsHelper ||=
            member.node.object.type === "MetaProperty" &&
            member.node.object.meta.name === "import" &&
            member.node.property.type === "Identifier" &&
            member.node.property.name === "resolve";
        },
      });
      const native = mode === "native";
      const nativeModule = native && (format === "module" || format === "module-typescript");
      const nativeCommonJs = native && (format === "commonjs" || format === "commonjs-typescript");
      const esm =
        nativeModule ||
        (!nativeCommonJs &&
          mode !== "sync" &&
          (/\.mtsx?$/.test(input) ||
            (!/\.ctsx?$/.test(input) && parsed.program.sourceType === "module" && !usesCommonJs)));
      formats.set(destination, esm ? "module" : "commonjs");
      const createImportHelper = () => {
        const helper = path.join(path.dirname(destination), `.import-meta-${randomUUID()}.mjs`);
        fs.writeFileSync(
          helper,
          `import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
const modules = createRequire(import.meta.url).cache;
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
export const importModule = async (specifier) => {
  const resolved = import.meta.resolve(specifier);
  const cached = modules[resolved];
  const imported = cached
    ? { "openclaw:async-commonjs": await cached.exports }
    : await import(specifier);
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
          { flag: "wx", mode: 0o600 },
        );
        helpers.set(helper, { source: input, generated: true, mode: "async" });
        return helper;
      };
      if (mode === "sync" || mode === "async") {
        const asynchronous = mode === "async";
        const result = transform({
          source: sourceText,
          filename: input,
          ts: /\.[cm]?tsx?$/.test(input),
          jsx,
          async: asynchronous,
          interopDefault: true,
        });
        const error: unknown = result.error;
        if (error) {
          throw new SyntaxError(
            (error instanceof Error ? error.message : stringifyNonErrorCause(error)).replaceAll(
              input,
              path.relative(root, input),
            ),
          );
        }
        const helper = asynchronous || needsHelper ? createImportHelper() : undefined;
        const output = parse(result.code, {
          sourceType: "script",
          allowAwaitOutsideFunction: true,
          allowReturnOutsideFunction: true,
        });
        const header =
          parse(`__filename = ${JSON.stringify(input)}; __dirname = ${JSON.stringify(path.dirname(input))};
          ${
            helper
              ? `require = require(${JSON.stringify(helper)}).bindRequire(require("node:module").createRequire(${JSON.stringify(pathToFileURL(input).href)}));
          const { importModule: jitiImport, resolve: jitiESMResolve } = require(${JSON.stringify(helper)});
          ${asynchronous ? "module.require = require;" : ""}`
              : ""
          }`);
        // Babel keeps directives separately, so the loader bindings follow "use strict".
        output.program.body.unshift(...header.program.body);
        const code = generate(output).code;
        const emitted = asynchronous
          ? `import Module, { createRequire } from "node:module";
const owner = new Module(${JSON.stringify(input)});
owner.filename = ${JSON.stringify(input)};
owner.paths = Module._nodeModulePaths(${JSON.stringify(path.dirname(input))});
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
        if (asynchronous) {
          formats.set(destination, "module");
        }
        fs.writeFileSync(destination, emitted, { mode: 0o600 });
        return;
      }
      let needsRequire = false;
      for (const reference of globals) {
        const name = reference.node.name;
        if (name === "require" && !esm) {
          continue;
        }
        const replacement =
          name === "require"
            ? parseExpression(loader)
            : parseExpression(JSON.stringify(name === "__filename" ? input : path.dirname(input)));
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
          const ${loader} = ${factory}(${JSON.stringify(pathToFileURL(input).href)});`
              : ""
          }
          import.meta.url = ${JSON.stringify(pathToFileURL(input).href)};
          import.meta.filename = ${JSON.stringify(input)};
          import.meta.dirname = ${JSON.stringify(path.dirname(input))};`,
          { sourceType: "module" },
        );
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
      const { transformSync }: typeof import("esbuild") = require("esbuild");
      const emitted = transformSync(generate(parsed).code, {
        ...nativeOptions,
        format: esm ? "esm" : "cjs",
      });
      fs.writeFileSync(destination, emitted.code, { mode: 0o600 });
    };
    // The capture owner resolves inputs; this hook only compiles and labels owned outputs.
    const hooks = Module.registerHooks({
      load(url, context, nextLoad) {
        const filename = url.startsWith("file:") ? fileURLToPath(url) : undefined;
        if (filename) {
          const entry = sources.get(filename);
          if (entry && !formats.has(filename) && !failures.has(filename)) {
            try {
              if (entry.mode && entry.mode !== "native") {
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
        return nextLoad(url, format ? { ...context, format } : context);
      },
    });
    return {
      directory,
      include: (additions: readonly string[]) => {
        if (disposed) {
          throw new Error("Plugin source view has been disposed");
        }
        additions.forEach(include);
      },
      resolve: (source: string, mode?: PluginSourceLoadMode, nativeFormat?: string | null) => {
        const filename = outputs.get(source);
        const entry = filename && sources.get(filename);
        // Resolution may inspect a source before executing it. Only compilation fixes its mode.
        if (entry && !formats.has(filename)) {
          entry.mode = mode ?? entry.mode ?? "native";
          entry.nativeFormat = nativeFormat ?? entry.nativeFormat;
        }
        return filename ?? source;
      },
      sourceForOutput: (file: string) =>
        sources.get(outputs.get(file) ?? file) ?? helpers.get(file),
      dispose: () => {
        hooks.deregister();
        dispose();
      },
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
