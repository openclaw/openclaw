// API baseline helpers hash public SDK exports for contract drift checks.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import {
  pluginSdkDocMetadata,
  resolvePluginSdkDocImportSpecifier,
  type PluginSdkDocCategory,
  type PluginSdkDocEntrypoint,
} from "../../scripts/lib/plugin-sdk-doc-metadata.ts";
import { publicPluginSdkEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mjs";

/** Declaration kind recorded for each public SDK export in the API baseline. */
export type PluginSdkApiExportKind =
  | "class"
  | "const"
  | "enum"
  | "function"
  | "interface"
  | "namespace"
  | "type"
  | "unknown"
  | "variable";

/** Repo source location for a public SDK declaration or module. */
export type PluginSdkApiSourceLink = {
  /** One-based source line for docs and review links. */
  line: number;
  /** Repo-relative source file path. */
  path: string;
};

/** Parsed @deprecated metadata for a public SDK surface. */
export type PluginSdkApiDeprecation = {
  /** Human-readable migration guidance from the @deprecated JSDoc tag. */
  message: string | null;
};

/** Kind of nested public declaration member marked deprecated. */
export type PluginSdkApiDeprecatedMemberKind = "method" | "parameter" | "property";

/** One deprecated nested member from an exported SDK declaration. */
export type PluginSdkApiDeprecatedMember = {
  /** Parsed @deprecated JSDoc metadata for the member. */
  deprecated: PluginSdkApiDeprecation;
  /** Member kind used by downstream inspection tools. */
  kind: PluginSdkApiDeprecatedMemberKind;
  /** Dot-delimited member path relative to the exported declaration. */
  name: string;
  /** Repo source for the deprecated member. */
  source: PluginSdkApiSourceLink;
};

/** One named export captured from a public SDK entrypoint. */
export type PluginSdkApiExport = {
  /** Parsed @deprecated metadata for the exported symbol, when present. */
  deprecated: PluginSdkApiDeprecation | null;
  /** Deprecated nested members from the exported declaration. */
  deprecatedMembers: PluginSdkApiDeprecatedMember[];
  /** Normalized TypeScript declaration text, or null when TypeScript cannot print it. */
  declaration: string | null;
  /** Exported symbol name as plugin authors import it. */
  exportName: string;
  /** Coarse declaration kind used by docs and drift reports. */
  kind: PluginSdkApiExportKind;
  /** Source location for the exported declaration when available. */
  source: PluginSdkApiSourceLink | null;
};

/** API baseline record for one public SDK module/subpath. */
export type PluginSdkApiModule = {
  /** Documentation category used to group SDK entrypoints. */
  category: PluginSdkDocCategory;
  /** Parsed @deprecated metadata for the SDK module/subpath, when present. */
  deprecated: PluginSdkApiDeprecation | null;
  /** Entry point metadata from the SDK docs registry. */
  entrypoint: PluginSdkDocEntrypoint;
  /** Public exports discovered from the TypeScript program. */
  exports: PluginSdkApiExport[];
  /** Package specifier shown to plugin authors. */
  importSpecifier: string;
  /** Repo source for the SDK entrypoint file. */
  source: PluginSdkApiSourceLink;
};

/** Full generated SDK API baseline payload. */
export type PluginSdkApiBaseline = {
  /** Generator identifier used to reject hand-authored baseline files. */
  generatedBy: "scripts/generate-plugin-sdk-api-baseline.ts";
  /** Public SDK modules included in the baseline. */
  modules: PluginSdkApiModule[];
};

/** Rendered baseline variants written to JSON and statefile outputs. */
export type PluginSdkApiBaselineRender = {
  /** Structured baseline data before serialization. */
  baseline: PluginSdkApiBaseline;
  /** Pretty JSON artifact for humans and docs tooling. */
  json: string;
  /** Line-delimited export records used by lightweight contract checks. */
  jsonl: string;
};

/** Result returned when writing SDK API baseline artifacts. */
export type PluginSdkApiBaselineWriteResult = {
  /** True when any generated artifact content differs from disk. */
  changed: boolean;
  /** True when changed artifacts were actually written. */
  wrote: boolean;
  /** JSON baseline artifact path. */
  jsonPath: string;
  /** JSONL statefile artifact path. */
  statefilePath: string;
  /** SHA-256 hash artifact path. */
  hashPath: string;
};

const GENERATED_BY = "scripts/generate-plugin-sdk-api-baseline.ts" as const;
const DEFAULT_JSON_OUTPUT = "docs/.generated/plugin-sdk-api-baseline.json";
const DEFAULT_STATEFILE_OUTPUT = "docs/.generated/plugin-sdk-api-baseline.jsonl";
const DEFAULT_HASH_OUTPUT = "docs/.generated/plugin-sdk-api-baseline.sha256";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

/** Normalize compiler source paths into stable repo-relative or node_modules-relative paths. */
export function normalizePluginSdkApiSourcePath(repoRoot: string, filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  const relative = path.relative(repoRoot, resolvedPath);
  const relativePosix = relative.split(path.sep).join(path.posix.sep);
  if (
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    !relativePosix.startsWith("node_modules/")
  ) {
    return relativePosix;
  }

  const pathParts = resolvedPath.split(/[\\/]+/);
  const nodeModulesIndex = pathParts.lastIndexOf("node_modules");
  if (nodeModulesIndex >= 0 && nodeModulesIndex < pathParts.length - 1) {
    return ["node_modules", ...pathParts.slice(nodeModulesIndex + 1)].join(path.posix.sep);
  }

  return relativePosix;
}

function relativePath(repoRoot: string, filePath: string): string {
  return normalizePluginSdkApiSourcePath(repoRoot, filePath);
}

function isAbsoluteImportPath(value: string): boolean {
  return path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeDeclarationImportSpecifier(repoRoot: string, value: string): string {
  if (!isAbsoluteImportPath(value)) {
    return value;
  }

  const resolvedPath = path.resolve(value);
  const relative = path.relative(repoRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return value;
  }
  return relative.split(path.sep).join(path.posix.sep);
}

/** Strip machine-local absolute paths from declaration text before hashing baseline output. */
export function normalizePluginSdkApiDeclarationText(repoRoot: string, value: string): string {
  return value.replaceAll(
    /import\("([^"]+)"((?:\s*,[^)]*)?)\)/g,
    (match, specifier: string, suffix: string) => {
      const normalized = normalizeDeclarationImportSpecifier(repoRoot, specifier);
      return normalized === specifier ? match : `import("${normalized}"${suffix})`;
    },
  );
}

function createCompilerContext(repoRoot: string) {
  const configPath = ts.findConfigFile(
    repoRoot,
    (filePath) => ts.sys.fileExists(filePath),
    "tsconfig.json",
  );
  assert(configPath, "Could not find tsconfig.json");
  const configFile = ts.readConfigFile(configPath, (filePath) => ts.sys.readFile(filePath));
  if (configFile.error) {
    throw new Error(ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n"));
  }
  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, repoRoot);
  const fileNames = parsedConfig.fileNames.toSorted((left, right) =>
    compareText(
      relativePath(repoRoot, path.resolve(left)),
      relativePath(repoRoot, path.resolve(right)),
    ),
  );
  const program = ts.createProgram(fileNames, parsedConfig.options);
  return {
    checker: program.getTypeChecker(),
    printer: ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }),
    program,
  };
}

function buildSourceLink(
  repoRoot: string,
  program: ts.Program,
  filePath: string,
  start: number,
): PluginSdkApiSourceLink {
  const sourceFile = program.getSourceFile(filePath);
  assert(sourceFile, `Unable to read source file for ${relativePath(repoRoot, filePath)}`);
  const line = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
  return {
    line,
    path: relativePath(repoRoot, filePath),
  };
}

/** Build repo-relative source evidence for a nested declaration. */
function buildDeclarationSourceLink(
  repoRoot: string,
  declaration: ts.Declaration,
): PluginSdkApiSourceLink {
  const sourceFile = declaration.getSourceFile();
  const line = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1;
  return {
    line,
    path: relativePath(repoRoot, sourceFile.fileName),
  };
}

/** Normalize JSDoc text for stable machine-readable baseline output. */
function normalizeJSDocText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Convert TypeScript symbol-display JSDoc text into baseline text. */
function normalizeJSDocTagInfoText(text: ts.SymbolDisplayPart[] | undefined): string | null {
  const message = normalizeJSDocText((text ?? []).map((part) => part.text).join(""));
  return message.length > 0 ? message : null;
}

/** Convert AST JSDoc tag comments into baseline text. */
function normalizeJSDocTagComment(
  comment: string | ts.NodeArray<ts.JSDocComment> | undefined,
): string | null {
  if (typeof comment === "string") {
    const message = normalizeJSDocText(comment);
    return message.length > 0 ? message : null;
  }
  if (!comment) {
    return null;
  }
  const message = normalizeJSDocText(
    [...comment]
      .map((part) => part.getText())
      .join(" ")
      .replaceAll(/^\s*\/\*\*?/g, "")
      .replaceAll(/\*\/\s*$/g, ""),
  );
  return message.length > 0 ? message : null;
}

/** Convert a leading JSDoc block into baseline deprecation metadata. */
function deprecationFromJSDocCommentText(commentText: string): PluginSdkApiDeprecation | null {
  const lines = commentText
    .replace(/^\/\*\*?/, "")
    .replace(/\*\/$/, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s?/, "").trim());
  const deprecatedLineIndex = lines.findIndex((line) => line.startsWith("@deprecated"));
  if (deprecatedLineIndex < 0) {
    return null;
  }
  const messageParts = [lines[deprecatedLineIndex]?.replace(/^@deprecated\b\s*/, "") ?? ""];
  for (const line of lines.slice(deprecatedLineIndex + 1)) {
    if (line.startsWith("@")) {
      break;
    }
    messageParts.push(line);
  }
  const message = normalizeJSDocText(messageParts.join(" "));
  return { message: message.length > 0 ? message : null };
}

/** Convert one TypeScript @deprecated symbol tag into baseline metadata. */
function deprecationFromJSDocTagInfo(
  tag: ts.JSDocTagInfo | undefined,
): PluginSdkApiDeprecation | null {
  if (!tag || tag.name !== "deprecated") {
    return null;
  }
  return { message: normalizeJSDocTagInfoText(tag.text) };
}

/** Read a file-leading @deprecated JSDoc block used for SDK subpath modules. */
function readPluginSdkApiLeadingCommentDeprecation(
  sourceFile: ts.SourceFile,
): PluginSdkApiDeprecation | null {
  const ranges = ts.getLeadingCommentRanges(sourceFile.text, 0) ?? [];
  for (const range of ranges) {
    if (range.kind !== ts.SyntaxKind.MultiLineCommentTrivia) {
      continue;
    }
    const deprecation = deprecationFromJSDocCommentText(
      sourceFile.text.slice(range.pos, range.end),
    );
    if (deprecation) {
      return deprecation;
    }
  }
  return null;
}

/** Read parsed @deprecated metadata from a TypeScript AST node. */
export function readPluginSdkApiDeprecationFromNode(node: ts.Node): PluginSdkApiDeprecation | null {
  const tag = ts.getJSDocTags(node).find((candidate) => candidate.tagName.text === "deprecated");
  if (!tag) {
    return null;
  }
  return { message: normalizeJSDocTagComment(tag.comment) };
}

/** Read module/subpath-level @deprecated metadata from a public SDK source file. */
export function readPluginSdkApiModuleDeprecationFromSourceFile(
  sourceFile: ts.SourceFile,
): PluginSdkApiDeprecation | null {
  const fileLeadingDeprecation = readPluginSdkApiLeadingCommentDeprecation(sourceFile);
  if (fileLeadingDeprecation) {
    return fileLeadingDeprecation;
  }
  const firstStatement = sourceFile.statements[0];
  if (!firstStatement || !ts.isExportDeclaration(firstStatement) || firstStatement.exportClause) {
    return null;
  }
  return readPluginSdkApiDeprecationFromNode(firstStatement);
}

/** Read parsed @deprecated metadata from a TypeScript symbol. */
function readPluginSdkApiDeprecationFromSymbol(symbol: ts.Symbol): PluginSdkApiDeprecation | null {
  return (
    symbol
      .getJsDocTags()
      .map(deprecationFromJSDocTagInfo)
      .find((deprecation): deprecation is PluginSdkApiDeprecation => deprecation !== null) ?? null
  );
}

/** Read @deprecated metadata from export-specifier declarations and their parent export. */
function readPluginSdkApiDeprecationFromExportDeclarations(
  symbol: ts.Symbol,
): PluginSdkApiDeprecation | null {
  for (const declaration of symbol.declarations ?? []) {
    const deprecated = readPluginSdkApiDeprecationFromNode(declaration);
    if (deprecated) {
      return deprecated;
    }
    if (ts.isExportSpecifier(declaration)) {
      const exportDeclaration = declaration.parent.parent;
      const exportDeprecated = readPluginSdkApiDeprecationFromNode(exportDeclaration);
      if (exportDeprecated) {
        return exportDeprecated;
      }
    }
  }
  return null;
}

/** Read export-level @deprecated metadata without losing alias re-export comments. */
export function readPluginSdkApiExportDeprecation(params: {
  declaration: ts.Declaration | undefined;
  resolvedSymbol: ts.Symbol;
  symbol: ts.Symbol;
}): PluginSdkApiDeprecation | null {
  const { declaration, resolvedSymbol, symbol } = params;
  return (
    readPluginSdkApiDeprecationFromSymbol(symbol) ??
    readPluginSdkApiDeprecationFromExportDeclarations(symbol) ??
    readPluginSdkApiDeprecationFromSymbol(resolvedSymbol) ??
    (declaration ? readPluginSdkApiDeprecationFromNode(declaration) : null)
  );
}

/** Read a simple identifier declaration name from a member-like AST node. */
function declarationName(node: ts.Node): string | null {
  const named = node as { name?: ts.Node };
  if (!named.name || !ts.isIdentifier(named.name)) {
    return null;
  }
  return named.name.text;
}

/** Classify the deprecated member kind for downstream inspectors. */
function deprecatedMemberKind(node: ts.Node): PluginSdkApiDeprecatedMemberKind | null {
  if (ts.isMethodSignature(node) || ts.isMethodDeclaration(node)) {
    return "method";
  }
  if (ts.isParameter(node)) {
    return "parameter";
  }
  if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
    return "property";
  }
  return null;
}

/** Recurse into type-literal declarations to find deprecated nested members. */
function collectTypeDeprecatedMembers(params: {
  activeTypes: Set<string>;
  checker?: ts.TypeChecker;
  members: PluginSdkApiDeprecatedMember[];
  node: ts.TypeNode | undefined;
  pathPrefix: string[];
  repoRoot: string;
}): void {
  const { activeTypes, checker, members, node, pathPrefix, repoRoot } = params;
  if (!node) {
    return;
  }
  if (ts.isTypeLiteralNode(node)) {
    collectNodeMembers({
      activeTypes,
      checker,
      members,
      nodes: node.members,
      pathPrefix,
      repoRoot,
    });
    return;
  }
  if (ts.isIntersectionTypeNode(node)) {
    for (const intersectionType of node.types) {
      collectTypeDeprecatedMembers({
        checker,
        members,
        node: intersectionType,
        pathPrefix,
        repoRoot,
        activeTypes,
      });
    }
    return;
  }
  if (checker && ts.isTypeReferenceNode(node)) {
    collectReferencedTypeDeprecatedMembers({
      activeTypes,
      checker,
      members,
      node,
      pathPrefix,
      repoRoot,
    });
  }
}

/** Return true when a declaration belongs to this repository rather than dependencies. */
function isRepoOwnedDeclaration(repoRoot: string, declaration: ts.Declaration): boolean {
  const sourcePath = relativePath(repoRoot, declaration.getSourceFile().fileName);
  return !sourcePath.startsWith("..") && !sourcePath.startsWith("node_modules/");
}

/** Resolve referenced type aliases/interfaces before collecting deprecated members. */
function collectReferencedTypeDeprecatedMembers(params: {
  activeTypes: Set<string>;
  checker: ts.TypeChecker;
  members: PluginSdkApiDeprecatedMember[];
  node: ts.TypeReferenceNode;
  pathPrefix: string[];
  repoRoot: string;
}): void {
  const { activeTypes, checker, members, node, pathPrefix, repoRoot } = params;
  const type = checker.getTypeAtLocation(node);
  const symbol = type.aliasSymbol ?? type.getSymbol() ?? checker.getSymbolAtLocation(node.typeName);
  const declarations = [...(symbol?.declarations ?? [])].sort((left, right) =>
    compareDeclarations(repoRoot, left, right),
  );

  for (const declaration of declarations) {
    if (!isRepoOwnedDeclaration(repoRoot, declaration)) {
      continue;
    }
    const visitKey = [declaration.getSourceFile().fileName, declaration.pos, declaration.end].join(
      ":",
    );
    if (activeTypes.has(visitKey)) {
      continue;
    }
    activeTypes.add(visitKey);

    if (ts.isTypeAliasDeclaration(declaration)) {
      collectTypeDeprecatedMembers({
        activeTypes,
        checker,
        members,
        node: declaration.type,
        pathPrefix,
        repoRoot,
      });
    }
    if (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
      collectNodeMembers({
        activeTypes,
        checker,
        members,
        nodes: declaration.members,
        pathPrefix,
        repoRoot,
      });
    }
    activeTypes.delete(visitKey);
  }
}

/** Walk member-like AST nodes and collect deprecated declarations. */
function collectNodeMembers(params: {
  activeTypes: Set<string>;
  checker?: ts.TypeChecker;
  members: PluginSdkApiDeprecatedMember[];
  nodes: readonly ts.Node[];
  pathPrefix: string[];
  repoRoot: string;
}): void {
  const { activeTypes, checker, members, nodes, pathPrefix, repoRoot } = params;
  for (const node of nodes) {
    const name = declarationName(node);
    const memberPath = name ? [...pathPrefix, name] : pathPrefix;
    const deprecated = readPluginSdkApiDeprecationFromNode(node);
    const kind = deprecatedMemberKind(node);

    // Record direct member deprecations before recursing so output follows source order.
    if (name && deprecated && kind) {
      members.push({
        deprecated,
        kind,
        name: memberPath.join("."),
        source: buildDeclarationSourceLink(repoRoot, node as ts.Declaration),
      });
    }

    // Object-shaped properties can contain nested deprecated payload fields.
    if (ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) {
      collectTypeDeprecatedMembers({
        activeTypes,
        checker,
        members,
        node: node.type,
        pathPrefix: memberPath,
        repoRoot,
      });
    }

    // Function-like members can deprecate individual parameters.
    if (
      ts.isMethodSignature(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      collectNodeMembers({
        activeTypes,
        checker,
        members,
        nodes: node.parameters,
        pathPrefix: memberPath,
        repoRoot,
      });
    }

    // Object-literal parameters can contain nested deprecated option keys.
    if (ts.isParameter(node)) {
      collectTypeDeprecatedMembers({
        activeTypes,
        checker,
        members,
        node: node.type,
        pathPrefix: memberPath,
        repoRoot,
      });
    }
  }
}

/** Collect deprecated nested public members from one exported SDK declaration. */
export function collectPluginSdkApiDeprecatedMembers(
  repoRoot: string,
  declaration: ts.Declaration,
  checker?: ts.TypeChecker,
): PluginSdkApiDeprecatedMember[] {
  const members: PluginSdkApiDeprecatedMember[] = [];
  const activeTypes = new Set<string>();
  if (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration)) {
    collectNodeMembers({
      activeTypes,
      checker,
      members,
      nodes: declaration.members,
      pathPrefix: [],
      repoRoot,
    });
  }
  if (ts.isTypeAliasDeclaration(declaration)) {
    collectTypeDeprecatedMembers({
      activeTypes,
      checker,
      members,
      node: declaration.type,
      pathPrefix: [],
      repoRoot,
    });
  }
  if (ts.isFunctionDeclaration(declaration)) {
    collectNodeMembers({
      activeTypes,
      checker,
      members,
      nodes: declaration.parameters,
      pathPrefix: [],
      repoRoot,
    });
  }
  return members.sort(
    (left, right) =>
      compareText(left.source.path, right.source.path) ||
      left.source.line - right.source.line ||
      compareText(left.name, right.name),
  );
}

function inferExportKind(
  symbol: ts.Symbol,
  declaration: ts.Declaration | undefined,
): PluginSdkApiExportKind {
  if (declaration) {
    switch (declaration.kind) {
      case ts.SyntaxKind.ClassDeclaration:
        return "class";
      case ts.SyntaxKind.EnumDeclaration:
        return "enum";
      case ts.SyntaxKind.FunctionDeclaration:
        return "function";
      case ts.SyntaxKind.InterfaceDeclaration:
        return "interface";
      case ts.SyntaxKind.ModuleDeclaration:
        return "namespace";
      case ts.SyntaxKind.TypeAliasDeclaration:
        return "type";
      case ts.SyntaxKind.VariableDeclaration: {
        const variableStatement = declaration.parent?.parent;
        if (
          variableStatement &&
          ts.isVariableStatement(variableStatement) &&
          (ts.getCombinedNodeFlags(variableStatement.declarationList) & ts.NodeFlags.Const) !== 0
        ) {
          return "const";
        }
        return "variable";
      }
      default:
        break;
    }
  }

  if (symbol.flags & ts.SymbolFlags.Function) {
    return "function";
  }
  if (symbol.flags & ts.SymbolFlags.Class) {
    return "class";
  }
  if (symbol.flags & ts.SymbolFlags.Interface) {
    return "interface";
  }
  if (symbol.flags & ts.SymbolFlags.TypeAlias) {
    return "type";
  }
  if (symbol.flags & ts.SymbolFlags.ConstEnum || symbol.flags & ts.SymbolFlags.RegularEnum) {
    return "enum";
  }
  if (symbol.flags & ts.SymbolFlags.Variable) {
    return "variable";
  }
  if (symbol.flags & ts.SymbolFlags.NamespaceModule || symbol.flags & ts.SymbolFlags.ValueModule) {
    return "namespace";
  }
  return "unknown";
}

function resolveSymbolAndDeclaration(
  checker: ts.TypeChecker,
  repoRoot: string,
  symbol: ts.Symbol,
): {
  declaration: ts.Declaration | undefined;
  resolvedSymbol: ts.Symbol;
} {
  const resolvedSymbol =
    symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declarations = (
    resolvedSymbol.getDeclarations() ??
    symbol.getDeclarations() ??
    []
  ).toSorted((left, right) => compareDeclarations(repoRoot, left, right));
  const declaration = declarations.find((candidate) => candidate.kind !== ts.SyntaxKind.SourceFile);
  return { declaration, resolvedSymbol };
}

function printNode(
  repoRoot: string,
  checker: ts.TypeChecker,
  printer: ts.Printer,
  declaration: ts.Declaration,
): string | null {
  if (ts.isFunctionDeclaration(declaration)) {
    const signatures = checker.getTypeAtLocation(declaration).getCallSignatures();
    if (signatures.length === 0) {
      return `export function ${declaration.name?.text ?? "anonymous"}();`;
    }
    return normalizePluginSdkApiDeclarationText(
      repoRoot,
      signatures
        .map(
          (signature) =>
            `export function ${declaration.name?.text ?? "anonymous"}${checker.signatureToString(signature)};`,
        )
        .join("\n"),
    );
  }

  if (ts.isVariableDeclaration(declaration)) {
    const name = declaration.name.getText();
    const type = checker.getTypeAtLocation(declaration);
    const prefix =
      declaration.parent && (ts.getCombinedNodeFlags(declaration.parent) & ts.NodeFlags.Const) !== 0
        ? "const"
        : "let";
    return normalizePluginSdkApiDeclarationText(
      repoRoot,
      `export ${prefix} ${name}: ${checker.typeToString(type, declaration, ts.TypeFormatFlags.NoTruncation)};`,
    );
  }

  if (ts.isInterfaceDeclaration(declaration)) {
    return `export interface ${declaration.name.text}`;
  }

  if (ts.isClassDeclaration(declaration)) {
    return `export class ${declaration.name?.text ?? "AnonymousClass"}`;
  }

  if (ts.isEnumDeclaration(declaration)) {
    return `export enum ${declaration.name.text}`;
  }

  if (ts.isModuleDeclaration(declaration)) {
    return `export namespace ${declaration.name.getText()}`;
  }

  if (ts.isTypeAliasDeclaration(declaration)) {
    const type = checker.getTypeAtLocation(declaration);
    const rendered = normalizePluginSdkApiDeclarationText(
      repoRoot,
      `export type ${declaration.name.text} = ${checker.typeToString(
        type,
        declaration,
        ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.MultilineObjectLiterals,
      )};`,
    );
    if (rendered.length > 1200) {
      return `export type ${declaration.name.text} = /* see source */`;
    }
    return rendered;
  }

  const text = printer
    .printNode(ts.EmitHint.Unspecified, declaration, declaration.getSourceFile())
    .trim();
  if (!text) {
    return null;
  }
  const normalizedText = normalizePluginSdkApiDeclarationText(repoRoot, text);
  return normalizedText.length > 1200
    ? `${normalizedText.slice(0, 1175).trimEnd()}\n/* truncated; see source */`
    : normalizedText;
}

function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function compareDeclarations(
  repoRoot: string,
  left: ts.Declaration,
  right: ts.Declaration,
): number {
  const byPath = compareText(
    relativePath(repoRoot, left.getSourceFile().fileName),
    relativePath(repoRoot, right.getSourceFile().fileName),
  );
  if (byPath !== 0) {
    return byPath;
  }

  const byStart = left.getStart() - right.getStart();
  if (byStart !== 0) {
    return byStart;
  }

  return left.kind - right.kind;
}

function buildExportSurface(params: {
  checker: ts.TypeChecker;
  printer: ts.Printer;
  program: ts.Program;
  repoRoot: string;
  symbol: ts.Symbol;
}): PluginSdkApiExport {
  const { checker, printer, program, repoRoot, symbol } = params;
  const { declaration, resolvedSymbol } = resolveSymbolAndDeclaration(checker, repoRoot, symbol);
  const deprecated = readPluginSdkApiExportDeprecation({ declaration, resolvedSymbol, symbol });
  return {
    deprecated,
    deprecatedMembers: declaration
      ? collectPluginSdkApiDeprecatedMembers(repoRoot, declaration, checker)
      : [],
    declaration: declaration ? printNode(repoRoot, checker, printer, declaration) : null,
    exportName: symbol.getName(),
    kind: inferExportKind(resolvedSymbol, declaration),
    source: declaration
      ? buildSourceLink(
          repoRoot,
          program,
          declaration.getSourceFile().fileName,
          declaration.getStart(),
        )
      : null,
  };
}

function sortExports(left: PluginSdkApiExport, right: PluginSdkApiExport): number {
  const kindRank: Record<PluginSdkApiExportKind, number> = {
    function: 0,
    const: 1,
    variable: 2,
    type: 3,
    interface: 4,
    class: 5,
    enum: 6,
    namespace: 7,
    unknown: 8,
  };

  const byKind = kindRank[left.kind] - kindRank[right.kind];
  if (byKind !== 0) {
    return byKind;
  }
  return compareText(left.exportName, right.exportName);
}

function buildModuleSurface(params: {
  checker: ts.TypeChecker;
  printer: ts.Printer;
  program: ts.Program;
  repoRoot: string;
  entrypoint: PluginSdkDocEntrypoint;
}): PluginSdkApiModule {
  const { checker, printer, program, repoRoot, entrypoint } = params;
  const metadata = pluginSdkDocMetadata[entrypoint];
  const importSpecifier = resolvePluginSdkDocImportSpecifier(entrypoint);
  const moduleSourcePath = path.join(repoRoot, "src", "plugin-sdk", `${entrypoint}.ts`);
  const sourceFile = program.getSourceFile(moduleSourcePath);
  assert(sourceFile, `Missing source file for ${importSpecifier}`);

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  assert(moduleSymbol, `Unable to resolve module symbol for ${importSpecifier}`);

  const exports = checker
    .getExportsOfModule(moduleSymbol)
    .filter((symbol) => symbol.getName() !== "__esModule")
    .map((symbol) =>
      buildExportSurface({
        checker,
        printer,
        program,
        repoRoot,
        symbol,
      }),
    )
    .toSorted(sortExports);

  return {
    category: metadata.category,
    deprecated: readPluginSdkApiModuleDeprecationFromSourceFile(sourceFile),
    entrypoint,
    exports,
    importSpecifier,
    source: buildSourceLink(repoRoot, program, moduleSourcePath, 0),
  };
}

function buildJsonlLines(baseline: PluginSdkApiBaseline): string[] {
  const lines: string[] = [];

  for (const moduleSurface of baseline.modules) {
    lines.push(
      JSON.stringify({
        category: moduleSurface.category,
        deprecated: moduleSurface.deprecated,
        entrypoint: moduleSurface.entrypoint,
        importSpecifier: moduleSurface.importSpecifier,
        recordType: "module",
        sourceLine: moduleSurface.source.line,
        sourcePath: moduleSurface.source.path,
      }),
    );

    for (const exportSurface of moduleSurface.exports) {
      lines.push(
        JSON.stringify({
          deprecated: exportSurface.deprecated,
          deprecatedMembers: exportSurface.deprecatedMembers,
          declaration: exportSurface.declaration,
          entrypoint: moduleSurface.entrypoint,
          exportName: exportSurface.exportName,
          importSpecifier: moduleSurface.importSpecifier,
          kind: exportSurface.kind,
          recordType: "export",
          sourceLine: exportSurface.source?.line ?? null,
          sourcePath: exportSurface.source?.path ?? null,
        }),
      );
    }
  }

  return lines;
}

/** Render the current public SDK API baseline without writing generated artifacts. */
export async function renderPluginSdkApiBaseline(params?: {
  repoRoot?: string;
}): Promise<PluginSdkApiBaselineRender> {
  const repoRoot = params?.repoRoot ?? resolveRepoRoot();
  validateMetadata();
  const { checker, printer, program } = createCompilerContext(repoRoot);
  const modules = (Object.keys(pluginSdkDocMetadata) as PluginSdkDocEntrypoint[])
    .map((entrypoint) =>
      buildModuleSurface({
        checker,
        printer,
        program,
        repoRoot,
        entrypoint,
      }),
    )
    .toSorted((left, right) => compareText(left.importSpecifier, right.importSpecifier));

  const baseline: PluginSdkApiBaseline = {
    generatedBy: GENERATED_BY,
    modules,
  };

  return {
    baseline,
    json: `${JSON.stringify(baseline, null, 2)}\n`,
    jsonl: `${buildJsonlLines(baseline).join("\n")}\n`,
  };
}

async function loadCurrentFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Build the sha256 hash file content for plugin SDK API baseline artifacts. */
export function computePluginSdkApiBaselineHashFileContent(
  rendered: PluginSdkApiBaselineRender,
): string {
  const lines = [
    `${sha256(rendered.json)}  plugin-sdk-api-baseline.json`,
    `${sha256(rendered.jsonl)}  plugin-sdk-api-baseline.jsonl`,
  ];
  return `${lines.join("\n")}\n`;
}

function validateMetadata(): void {
  const canonicalEntrypoints = new Set<string>(publicPluginSdkEntrypoints);
  const metadataEntrypoints = new Set<string>(Object.keys(pluginSdkDocMetadata));

  for (const entrypoint of metadataEntrypoints) {
    assert(
      canonicalEntrypoints.has(entrypoint),
      `Metadata entrypoint ${entrypoint} is not exported in the Plugin SDK.`,
    );
  }
}

/** Write or check SDK API baseline artifacts used by docs and contract tests. */
export async function writePluginSdkApiBaselineStatefile(params?: {
  repoRoot?: string;
  check?: boolean;
  jsonPath?: string;
  statefilePath?: string;
  hashPath?: string;
}): Promise<PluginSdkApiBaselineWriteResult> {
  const repoRoot = params?.repoRoot ?? resolveRepoRoot();
  const jsonPath = path.resolve(repoRoot, params?.jsonPath ?? DEFAULT_JSON_OUTPUT);
  const statefilePath = path.resolve(repoRoot, params?.statefilePath ?? DEFAULT_STATEFILE_OUTPUT);
  const hashPath = path.resolve(repoRoot, params?.hashPath ?? DEFAULT_HASH_OUTPUT);
  const rendered = await renderPluginSdkApiBaseline({ repoRoot });

  const nextHashContent = computePluginSdkApiBaselineHashFileContent(rendered);
  const currentHashContent = await loadCurrentFile(hashPath);
  const changed = currentHashContent !== nextHashContent;

  if (params?.check) {
    return {
      changed,
      wrote: false,
      jsonPath,
      statefilePath,
      hashPath,
    };
  }

  // Write the hash file (tracked in git)
  await fs.mkdir(path.dirname(hashPath), { recursive: true });
  await fs.writeFile(hashPath, nextHashContent, "utf8");

  // Write full JSON/JSONL artifacts locally (gitignored, useful for inspection)
  await fs.mkdir(path.dirname(jsonPath), { recursive: true });
  await fs.writeFile(jsonPath, rendered.json, "utf8");
  await fs.writeFile(statefilePath, rendered.jsonl, "utf8");

  return {
    changed,
    wrote: true,
    jsonPath,
    statefilePath,
    hashPath,
  };
}
