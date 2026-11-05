import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isNativeEsmPackage } from "../infra/native-module-format.js";
import type { PluginSourceFile } from "./plugin-source-build.js";

const require = createRequire(import.meta.url);

/** Bun skips builtin node:module resolve hooks; bind only the frozen source's load sites. */
function bindPluginSnapshotBunSource(
  filename: string,
  source: string,
  facade: string,
  helpers: string,
): string {
  if (!/require|import\s*\(|["'](?:node:)?module["']/u.test(source)) {
    return source;
  }
  const { parse }: typeof import("@babel/parser") = require("@babel/parser");
  const { default: traverse }: typeof import("@babel/traverse") = require("@babel/traverse");
  const extension = path.extname(filename).toLowerCase();
  const tree = parse(source, {
    sourceType: "unambiguous",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
    createImportExpressions: true,
    plugins: [
      ...(/\.[cm]?tsx?$/u.test(extension) ? (["typescript"] as const) : []),
      ...(extension.endsWith("x") ? (["jsx"] as const) : []),
    ],
  });
  const edits: { start: number; end: number; replacement: string }[] = [];
  let helper = "";
  let boundRequire = "";
  let importMeta = "";
  let needsHelper = false;
  let needsRequire = false;
  let needsMeta = false;
  const replace = (node: { start?: number | null; end?: number | null }, replacement: string) => {
    if (node.start != null && node.end != null) {
      edits.push({ start: node.start, end: node.end, replacement });
    }
  };
  const moduleSpecifier = (node: { value: string; start?: number | null; end?: number | null }) => {
    if (node.value === "module" || node.value === "node:module") {
      replace(node, JSON.stringify(facade));
    }
  };
  traverse(tree, {
    Program(program) {
      helper = program.scope.generateUidIdentifier("openclawSnapshotModules").name;
      boundRequire = program.scope.generateUidIdentifier("openclawSnapshotRequire").name;
      importMeta = program.scope.generateUidIdentifier("openclawSnapshotMeta").name;
    },
    ImportDeclaration(imported) {
      moduleSpecifier(imported.node.source);
    },
    ExportNamedDeclaration(exported) {
      if (exported.node.source) {
        moduleSpecifier(exported.node.source);
      }
    },
    ExportAllDeclaration(exported) {
      moduleSpecifier(exported.node.source);
    },
    ImportExpression(imported) {
      const argument = imported.node.source;
      if (argument.start != null && argument.end != null) {
        needsHelper = true;
        edits.push({
          start: argument.start,
          end: argument.start,
          replacement: `${helper}.importSpecifier(`,
        });
        edits.push({ start: argument.end, end: argument.end, replacement: ")" });
      }
    },
    ReferencedIdentifier(reference) {
      const name = reference.node.name;
      if (reference.scope.getBinding(name)) {
        return;
      }
      let replacement: string;
      if (name === "require") {
        needsHelper = needsRequire = true;
        replacement = boundRequire;
      } else if (name === "__filename" || name === "__dirname") {
        replacement = JSON.stringify(name === "__filename" ? filename : path.dirname(filename));
      } else {
        return;
      }
      replace(
        reference.node,
        reference.parentPath.isObjectProperty() && reference.parentPath.node.shorthand
          ? `${name}: ${replacement}`
          : replacement,
      );
    },
    MetaProperty(meta) {
      if (meta.node.meta.name === "import") {
        needsHelper = needsRequire = needsMeta = true;
        replace(meta.node, importMeta);
      }
    },
    MemberExpression(member) {
      const { object, property, computed } = member.node;
      const requires = computed
        ? property.type === "StringLiteral" && property.value === "require"
        : property.type === "Identifier" && property.name === "require";
      if (
        requires &&
        ((object.type === "Identifier" &&
          object.name === "module" &&
          !member.scope.getBinding("module")) ||
          (object.type === "MetaProperty" && object.meta.name === "import"))
      ) {
        needsHelper = needsRequire = true;
        replace(member.node, boundRequire);
        member.skip();
      }
    },
  });
  let result = source;
  for (const edit of edits.toSorted(
    (left, right) => right.start - left.start || right.end - left.end,
  )) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end);
  }
  if (needsHelper) {
    const position = tree.program.directives.at(-1)?.end ?? tree.program.interpreter?.end ?? 0;
    const header =
      (tree.program.sourceType === "module"
        ? `\nimport * as ${helper} from ${JSON.stringify(helpers)};\n`
        : `\nconst ${helper} = require(${JSON.stringify(helpers)});\n`) +
      (needsRequire
        ? `const ${boundRequire} = ${helper}.createRequire(${JSON.stringify(filename)});\n`
        : "") +
      (needsMeta
        ? `const ${importMeta} = { __proto__: null, ...import.meta, url: ${JSON.stringify(pathToFileURL(filename).href)}, filename: ${JSON.stringify(filename)}, dirname: ${JSON.stringify(path.dirname(filename))}, path: ${JSON.stringify(filename)}, dir: ${JSON.stringify(path.dirname(filename))}, file: ${JSON.stringify(path.basename(filename))}, require: ${boundRequire}, resolve: (specifier, parent = ${JSON.stringify(filename)}) => ${helper}.resolveSpecifier(specifier, parent) };\n`
        : "");
    result = result.slice(0, position) + header + result.slice(position);
  }
  return result;
}

/** Derived native files preserve Bun's CJS/ESM classification, which onLoad loses. */
export function buildPluginSnapshotBunSource(root: string, facade: string, helpers: string) {
  const directory = fs.mkdtempSync(path.join(path.dirname(root), ".source-"));
  const outputs = new Map<string, string>();
  const sources = new Map<string, PluginSourceFile>();
  let disposed = false;
  return {
    directory,
    resolve(source: string) {
      if (disposed) {
        throw new Error("Plugin source view has been disposed");
      }
      const existing = outputs.get(source);
      if (existing) {
        return existing;
      }
      if (!/\.[cm]?[jt]sx?$/u.test(source)) {
        return source;
      }
      const text = fs.readFileSync(source, "utf8");
      const contents = bindPluginSnapshotBunSource(source, text, facade, helpers);
      if (contents === text) {
        outputs.set(source, source);
        return source;
      }
      const outputDirectory = path.join(directory, `module-${outputs.size}`);
      fs.mkdirSync(outputDirectory, { mode: 0o700 });
      // Native classification follows the input package; resolution still belongs to its capture.
      fs.writeFileSync(
        path.join(outputDirectory, "package.json"),
        JSON.stringify({ type: isNativeEsmPackage(source) ? "module" : "commonjs" }),
        { flag: "wx", mode: 0o600 },
      );
      const filename = path.join(outputDirectory, path.basename(source));
      fs.writeFileSync(filename, contents, { flag: "wx", mode: 0o600 });
      outputs.set(source, filename);
      sources.set(filename, { source });
      return filename;
    },
    sourceForOutput: (filename: string) => sources.get(filename),
    dispose() {
      disposed = true;
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
