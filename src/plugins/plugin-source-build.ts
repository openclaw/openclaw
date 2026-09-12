import { randomUUID } from "node:crypto";
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stringifyNonErrorCause } from "@openclaw/normalization-core/error-coercion";
import type * as TypeScript from "typescript";
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
  const ts: typeof TypeScript = require("typescript");
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
    const options: TypeScript.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      experimentalDecorators: true,
      esModuleInterop: true,
      jsx: jsx ? ts.JsxEmit.React : ts.JsxEmit.Preserve,
      allowJs: true,
      noResolve: true,
      noLib: true,
      types: [],
      outDir: directory,
      rootDir: root,
    };
    const compile = (input: string, destination: string, format: string | null | undefined) => {
      // TypeScript uses slash-form filenames; native paths stay with filesystem operations.
      // Map Jiti's .mtsx/.ctsx extensions while retaining their explicit JSX grammar.
      const compilerInput = input.replaceAll("\\", "/").replace(/\.([cm])tsx$/, ".$1ts");
      const native = sources.get(destination)?.mode === "native";
      const nativeModule = native && (format === "module" || format === "module-typescript");
      const nativeCommonJs = native && (format === "commonjs" || format === "commonjs-typescript");
      const host = ts.createCompilerHost(options);
      host.getSourceFile = (filename, language) => {
        const text = host.readFile(filename === compilerInput ? input : filename);
        const source =
          text === undefined
            ? undefined
            : ts.createSourceFile(
                filename,
                text,
                typeof language === "number" ? language : language.languageVersion,
                true,
                input.endsWith("x")
                  ? input.endsWith(".jsx")
                    ? ts.ScriptKind.JSX
                    : ts.ScriptKind.TSX
                  : ts.ScriptKind.TS,
              );
        if (source && filename === compilerInput) {
          const esm =
            nativeModule ||
            (!nativeCommonJs &&
              sources.get(destination)?.mode !== "sync" &&
              (/\.mtsx?$/.test(input) || (!/\.ctsx?$/.test(input) && ts.isExternalModule(source))));
          source.impliedNodeFormat = esm ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS;
          formats.set(destination, esm ? "module" : "commonjs");
        }
        return source;
      };
      host.writeFile = (_filename, data, _bom, _error, emittedSources) => {
        const source = emittedSources?.[0];
        if (source?.fileName !== compilerInput) {
          throw new Error("Plugin compiler emitted a file without a source owner");
        }
        fs.writeFileSync(destination, data, { mode: 0o600 });
      };
      const program = ts.createProgram([compilerInput], options, host);
      const checker = program.getTypeChecker();
      const hasRuntimeBinding = (node: TypeScript.Identifier) => {
        const original = ts.getOriginalNode(node);
        const symbol = ts.isShorthandPropertyAssignment(original.parent)
          ? checker.getShorthandAssignmentValueSymbol(original.parent)
          : checker.getSymbolAtLocation(original);
        return (
          symbol?.declarations?.some(
            (declaration) =>
              !declaration.getSourceFile().isDeclarationFile &&
              !(ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) &&
              !(ts.isImportClause(declaration) && declaration.isTypeOnly) &&
              !(
                ts.isImportSpecifier(declaration) &&
                (declaration.isTypeOnly || declaration.parent.parent.isTypeOnly)
              ),
          ) ?? false
        );
      };
      const isNodeGlobal = (
        node: TypeScript.Node,
        names: readonly string[],
      ): node is TypeScript.Identifier =>
        ts.isIdentifier(node) &&
        names.includes(node.text) &&
        !hasRuntimeBinding(node) &&
        !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node);
      const usesCommonJs = (node: TypeScript.Node): boolean => {
        if (
          ts.isPartOfTypeNode(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isImportDeclaration(node) ||
          ts.isExportDeclaration(node) ||
          (ts.canHaveModifiers(node) &&
            ts
              .getModifiers(node)
              ?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword))
        ) {
          return false;
        }
        return (
          (ts.isExportAssignment(node) && node.isExportEquals === true) ||
          isNodeGlobal(node, ["module", "exports"]) ||
          ts.forEachChild(node, usesCommonJs) === true
        );
      };
      const programSource = program.getSourceFile(compilerInput);
      if (
        !nativeModule &&
        programSource &&
        !/\.mtsx?$/.test(input) &&
        usesCommonJs(programSource)
      ) {
        // Authored CommonJS exports retain their namespace and require conditions after type erasure.
        programSource.impliedNodeFormat = ts.ModuleKind.CommonJS;
        formats.set(destination, "commonjs");
      }
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
      const shims: TypeScript.TransformerFactory<TypeScript.SourceFile> = (context) => (source) => {
        if (source.fileName !== compilerInput) {
          return source;
        }
        const f = context.factory;
        const esm = formats.get(destination) === "module";
        const loader = f.createUniqueName("__pluginRequire");
        const factory = f.createUniqueName("__createPluginRequire");
        let needsRequire = false;
        const substitute = (name: string) => {
          if (name === "require") {
            needsRequire = esm;
            return esm ? loader : f.createIdentifier("require");
          }
          return f.createStringLiteral(name === "__filename" ? input : path.dirname(input));
        };
        const visit: TypeScript.Visitor = (node) => {
          if (
            ts.isShorthandPropertyAssignment(node) &&
            ["require", "__filename", "__dirname"].includes(node.name.text) &&
            !hasRuntimeBinding(node.name)
          ) {
            return f.createPropertyAssignment(node.name, substitute(node.name.text));
          }
          if (isNodeGlobal(node, ["require", "__filename", "__dirname"])) {
            return substitute(node.text);
          }
          return ts.visitEachChild(node, visit, context);
        };
        const transformed = ts.visitEachChild(source, visit, context);
        const statements: TypeScript.Statement[] = [...transformed.statements];
        const explicitInterop = statements.some(
          (statement) =>
            ts.isExportDeclaration(statement) &&
            statement.exportClause &&
            (ts.isNamedExports(statement.exportClause)
              ? statement.exportClause.elements.some((item) => item.name.text === "module.exports")
              : statement.exportClause.name.text === "module.exports"),
        );
        if (
          esm &&
          !explicitInterop &&
          statements.some(
            (statement) => ts.isExportDeclaration(statement) && !statement.exportClause,
          )
        ) {
          // Node's CJS wildcard namespace contains module.exports. Preserve this TS module's own
          // namespace for require(ESM), rather than letting a dependency replace its default export.
          const self = f.createUniqueName("__pluginNamespace");
          statements.push(
            f.createImportDeclaration(
              undefined,
              f.createImportClause(false, undefined, f.createNamespaceImport(self)),
              f.createStringLiteral(pathToFileURL(destination).href),
            ),
          );
          statements.push(
            f.createExportDeclaration(
              undefined,
              false,
              f.createNamedExports([
                f.createExportSpecifier(false, self, f.createStringLiteral("module.exports")),
              ]),
            ),
          );
        }
        if (esm) {
          statements.unshift(
            ...Object.entries({
              url: pathToFileURL(input).href,
              filename: input,
              dirname: path.dirname(input),
            }).map(([key, value]) =>
              f.createExpressionStatement(
                f.createAssignment(
                  f.createPropertyAccessExpression(
                    f.createMetaProperty(ts.SyntaxKind.ImportKeyword, f.createIdentifier("meta")),
                    key,
                  ),
                  f.createStringLiteral(value),
                ),
              ),
            ),
          );
        }
        if (!needsRequire) {
          return f.updateSourceFile(transformed, statements);
        }
        return f.updateSourceFile(transformed, [
          f.createImportDeclaration(
            undefined,
            f.createImportClause(
              false,
              undefined,
              f.createNamedImports([
                f.createImportSpecifier(false, f.createIdentifier("createRequire"), factory),
              ]),
            ),
            f.createStringLiteral("node:module"),
          ),
          f.createVariableStatement(
            undefined,
            f.createVariableDeclarationList(
              [
                f.createVariableDeclaration(
                  loader,
                  undefined,
                  undefined,
                  f.createCallExpression(factory, undefined, [
                    f.createStringLiteral(pathToFileURL(input).href),
                  ]),
                ),
              ],
              ts.NodeFlags.Const,
            ),
          ),
          ...statements,
        ]);
      };
      const diagnostics = [
        ...program.getSyntacticDiagnostics(),
        ...program.getOptionsDiagnostics(),
      ];
      if (!diagnostics.some((d) => d.category === ts.DiagnosticCategory.Error)) {
        const mode = sources.get(destination)?.mode;
        const asynchronous = mode === "async";
        if ((mode === "sync" || asynchronous) && programSource) {
          // Preserve Jiti's maintained source syntax and CJS bindings; Node still evaluates it.
          // Keep the TS suffix for JSX grammar, then rebase only generated metadata literals.
          const compilerFilename = destination + path.extname(input);
          const result = transform({
            source: programSource.text,
            filename: compilerFilename,
            ts: /\.[cm]?tsx?$/.test(input),
            jsx,
            async: asynchronous,
            interopDefault: true,
          });
          const error: unknown = result.error;
          if (error) {
            const relative = path.relative(root, input);
            throw new SyntaxError(
              (error instanceof Error ? error.message : stringifyNonErrorCause(error))
                .replaceAll(compilerFilename, relative)
                .replaceAll(compilerFilename.replaceAll("\\", "/"), relative),
            );
          }
          const needsHelper = (node: TypeScript.Node): boolean => {
            if (ts.isPartOfTypeNode(node) || ts.isInterfaceDeclaration(node)) {
              return false;
            }
            if (ts.isImportDeclaration(node)) {
              return !node.importClause?.isTypeOnly;
            }
            if (ts.isImportEqualsDeclaration(node)) {
              return !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference);
            }
            if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
              return !node.isTypeOnly;
            }
            return (
              isNodeGlobal(node, ["require"]) ||
              (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) ||
              (ts.isPropertyAccessExpression(node) &&
                node.name.text === "resolve" &&
                ts.isMetaProperty(node.expression) &&
                node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) ||
              ts.forEachChild(node, needsHelper) === true
            );
          };
          let helper: string | undefined;
          if (asynchronous || needsHelper(programSource)) {
            helper = createImportHelper();
          }
          const parsed = ts.createSourceFile(
            destination,
            result.code,
            ts.ScriptTarget.ES2022,
            true,
            ts.ScriptKind.JS,
          );
          const paths = new Map([
            [compilerFilename, input],
            [path.dirname(compilerFilename), path.dirname(input)],
            [pathToFileURL(compilerFilename).href, pathToFileURL(input).href],
          ]);
          const emitted = ts.transform(parsed, [
            (context) => (source) => {
              const visit: TypeScript.Visitor = (node) => {
                const replacement = ts.isStringLiteral(node) ? paths.get(node.text) : undefined;
                return replacement === undefined
                  ? ts.visitEachChild(node, visit, context)
                  : context.factory.createStringLiteral(replacement);
              };
              const normalized = ts.visitEachChild(source, visit, context);
              const header = ts.createSourceFile(
                destination,
                `__filename = ${JSON.stringify(input)}; __dirname = ${JSON.stringify(path.dirname(input))};
                 ${
                   helper
                     ? `require = require(${JSON.stringify(helper)}).bindRequire(require("node:module").createRequire(${JSON.stringify(pathToFileURL(input).href)}));
                 const { importModule: jitiImport, resolve: jitiESMResolve } = require(${JSON.stringify(helper)});
                 ${asynchronous ? "module.require = require;" : ""}`
                     : ""
                 }`,
                ts.ScriptTarget.ES2022,
                false,
                ts.ScriptKind.JS,
              );
              const statements = [...normalized.statements];
              const afterDirectives = statements.findIndex(
                (statement) =>
                  !ts.isExpressionStatement(statement) || !ts.isStringLiteral(statement.expression),
              );
              statements.splice(
                afterDirectives < 0 ? statements.length : afterDirectives,
                0,
                ...header.statements,
              );
              return context.factory.updateSourceFile(normalized, statements);
            },
          ]);
          try {
            for (const emittedFile of emitted.transformed) {
              const code = ts.createPrinter().printFile(emittedFile);
              const output = asynchronous
                ? `import Module, { createRequire } from "node:module";
const owner = new Module(${JSON.stringify(input)});
owner.filename = ${JSON.stringify(input)};
owner.paths = Module._nodeModulePaths(${JSON.stringify(path.dirname(input))});
const require = createRequire(import.meta.url);
// Expose partial exports before awaiting dependencies; URL keys preserve import query identity.
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
              fs.writeFileSync(destination, output, { mode: 0o600 });
            }
          } finally {
            emitted.dispose();
          }
        } else {
          diagnostics.push(
            ...program.emit(undefined, undefined, undefined, false, { after: [shims] }).diagnostics,
          );
        }
      }
      const errors = diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
      if (errors.length) {
        throw new SyntaxError(
          ts.formatDiagnostics(errors, { ...host, getCurrentDirectory: () => root }),
        );
      }
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
