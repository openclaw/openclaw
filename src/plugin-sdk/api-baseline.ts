// API baseline helpers render public SDK exports for contract drift reports.
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript/unstable/ast";
import {
  SymbolFlags,
  type Checker,
  type Emitter,
  type Program,
  type Symbol as CompilerSymbol,
} from "typescript/unstable/sync";
import { CompilerInputSnapshot } from "../../scripts/lib/compiler-input-snapshot.mts";
import { emitNativeDeclarations } from "../../scripts/lib/native-declaration-emitter.mts";
import {
  createNativeTypeScriptProject,
  resolveInstalledNativeTypeScriptCompiler,
} from "../../scripts/lib/native-typescript.mts";
import {
  pluginSdkDocMetadata,
  type PluginSdkDocCategory,
  type PluginSdkDocEntrypoint,
} from "../../scripts/lib/plugin-sdk-doc-metadata.ts";
import { publicPluginSdkEntrypoints } from "../../scripts/lib/plugin-sdk-entries.mts";
import {
  createDeclarationClosureRenderer,
  type PluginSdkApiDeclarationSection,
} from "./api-baseline-declaration-closure.js";
import { printPluginSdkExportDeclaration } from "./api-baseline-declaration-print.js";
import { normalizePluginSdkApiSourcePath as relativePath } from "./api-baseline-normalization.js";

export {
  normalizePluginSdkApiDeclarationText,
  normalizePluginSdkApiSourcePath,
} from "./api-baseline-normalization.js";

/** Declaration kind recorded for each public SDK export in the API baseline. */
type PluginSdkApiExportKind =
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
type PluginSdkApiSourceLink = {
  /** Repo-relative source file path. */
  path: string;
};

/** One named export captured from a public SDK entrypoint. */
export type PluginSdkApiExport = {
  /** Hash of repo-owned declarations reachable from this export. */
  closureHash: string | null;
  /** References into the baseline's deduplicated declaration section pool. */
  closureSectionIds: number[] | null;
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
type PluginSdkApiModule = {
  /** Documentation category used to group SDK entrypoints when documented. */
  category: PluginSdkDocCategory | null;
  /** Canonical public SDK entrypoint. */
  entrypoint: string;
  /** Public exports discovered from the TypeScript program. */
  exports: PluginSdkApiExport[];
  /** Package specifier shown to plugin authors. */
  importSpecifier: string;
  /** Repo source for the SDK entrypoint file. */
  source: PluginSdkApiSourceLink;
};

/** Full SDK API surface payload. */
export type PluginSdkApiBaseline = {
  /** Deduplicated repo-owned declarations reachable from public exports. */
  declarationSections: PluginSdkApiDeclarationSection[];
  /** Public SDK modules included in the baseline. */
  modules: PluginSdkApiModule[];
};
type RenderedPluginSdkApiExport = Omit<PluginSdkApiExport, "closureSectionIds"> & {
  closureSections: PluginSdkApiDeclarationSection[] | null;
};
type RenderedPluginSdkApiModule = Omit<PluginSdkApiModule, "exports"> & {
  exports: RenderedPluginSdkApiExport[];
};
type DeclarationClosureRenderer = ReturnType<typeof createDeclarationClosureRenderer>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function resolveRepoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

async function createCompilerContext(repoRoot: string, entrypoints: readonly string[]) {
  const configPath = path.join(repoRoot, "tsconfig.json");
  const fileNames = entrypoints
    .map((entrypoint) => path.join(repoRoot, "src", "plugin-sdk", `${entrypoint}.ts`))
    .toSorted((left, right) =>
      compareText(relativePath(repoRoot, left), relativePath(repoRoot, right)),
    );
  const compilerOptions = {
    declaration: true,
    declarationMap: false,
    emitDeclarationOnly: true,
    noEmit: false,
    // Declaration diagnostics are checked explicitly; unrelated untyped external JS stays valid.
    noEmitOnError: false,
    removeComments: true,
    sourceMap: false,
  };
  const configFileName = path.join(repoRoot, ".openclaw-plugin-sdk-api.tsconfig.json");
  const config = JSON.stringify({
    extends: configPath,
    compilerOptions,
    files: fileNames,
    include: [],
  });
  const source = createNativeTypeScriptProject({
    cwd: repoRoot,
    configFileName,
    files: { [configFileName]: config },
  });
  let declarations: ReturnType<typeof createNativeTypeScriptProject> | undefined;
  try {
    const emitted = await emitNativeDeclarations({
      cwd: repoRoot,
      configFile: configPath,
      roots: fileNames,
      compilerOptions,
      diagnostics: "declarations",
    });
    // Keep each emitted module at its source location so package scope, path mappings, and
    // import attributes retain the compiler's original resolution conditions.
    declarations = createNativeTypeScriptProject({
      cwd: repoRoot,
      configFileName,
      files: {
        ...Object.fromEntries(
          [...emitted.declarations].map(([file, output]) => [file, output.code]),
        ),
        [configFileName]: config,
      },
    });
    return {
      checker: source.project.checker,
      inputs: [
        ...new Set([
          ...emitted.inputs,
          ...source.project.program.getSourceFileNames(),
          ...declarations.project.program.getSourceFileNames(),
        ]),
      ],
      declarationClosure: createDeclarationClosureRenderer({
        project: declarations.project,
        sourceProgram: source.project.program,
        emittedSources: new Set(emitted.declarations.keys()),
        repoRoot,
      }),
      printer: source.project.emitter,
      program: source.project.program,
      close() {
        declarations?.close();
        source.close();
      },
    };
  } catch (error) {
    declarations?.close();
    source.close();
    throw error;
  }
}

/** List canonical public SDK entrypoints included in the API baseline. */
export function listPluginSdkApiBaselineEntrypoints(): string[] {
  return [...publicPluginSdkEntrypoints];
}

function inferExportKind(
  symbol: CompilerSymbol,
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
          (variableStatement.declarationList.flags & ts.NodeFlags.Const) !== 0
        ) {
          return "const";
        }
        return "variable";
      }
      default:
        break;
    }
  }

  for (const [flag, kind] of [
    [SymbolFlags.Function, "function"],
    [SymbolFlags.Class, "class"],
    [SymbolFlags.Interface, "interface"],
    [SymbolFlags.TypeAlias, "type"],
    [SymbolFlags.ConstEnum | SymbolFlags.RegularEnum, "enum"],
    [SymbolFlags.Variable, "variable"],
    [SymbolFlags.NamespaceModule | SymbolFlags.ValueModule, "namespace"],
  ] as const) {
    if (symbol.flags & flag) {
      return kind;
    }
  }
  return "unknown";
}

function resolveSymbolAndDeclaration(
  checker: Checker,
  repoRoot: string,
  symbol: CompilerSymbol,
): {
  declaration: ts.Declaration | undefined;
  resolvedSymbol: CompilerSymbol;
} {
  const resolvedSymbol =
    symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
  const declarations = (
    resolvedSymbol.declarations.length ? resolvedSymbol.declarations : symbol.declarations
  )
    .map((handle) => handle.resolve())
    .filter(
      (node): node is ts.Declaration =>
        node !== undefined && node.kind !== ts.SyntaxKind.SourceFile,
    )
    .toSorted((left, right) => compareDeclarations(repoRoot, left, right));
  const declaration = declarations[0];
  return { declaration, resolvedSymbol };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDeclarations(
  repoRoot: string,
  left: ts.Declaration,
  right: ts.Declaration,
): number {
  return (
    compareText(
      relativePath(repoRoot, left.getSourceFile().fileName),
      relativePath(repoRoot, right.getSourceFile().fileName),
    ) ||
    left.getStart() - right.getStart() ||
    left.kind - right.kind
  );
}

function buildExportSurface(params: {
  checker: Checker;
  declarationClosure: DeclarationClosureRenderer;
  printer: Emitter;
  repoRoot: string;
  symbol: CompilerSymbol;
}): RenderedPluginSdkApiExport {
  const { checker, declarationClosure, printer, repoRoot, symbol } = params;
  const { declaration, resolvedSymbol } = resolveSymbolAndDeclaration(checker, repoRoot, symbol);
  const exportName = symbol.name;
  const declarationName =
    declaration &&
    (ts.isClassDeclaration(declaration) ||
      ts.isEnumDeclaration(declaration) ||
      ts.isFunctionDeclaration(declaration) ||
      ts.isInterfaceDeclaration(declaration) ||
      ts.isModuleDeclaration(declaration) ||
      ts.isTypeAliasDeclaration(declaration) ||
      ts.isVariableDeclaration(declaration))
      ? declaration.name
      : undefined;
  const closureName =
    declarationName && ts.isIdentifier(declarationName) ? declarationName.text : exportName;
  const declarationText = declaration
    ? printPluginSdkExportDeclaration(repoRoot, checker, printer, declaration, exportName)
    : null;
  const declarationSource = declaration?.getSourceFile();
  const closure =
    declarationSource && declarationText
      ? declarationClosure(declarationSource, closureName)
      : null;
  return {
    closureHash: closure?.hash ?? null,
    closureSections: closure?.sections ?? null,
    declaration: declarationText,
    exportName,
    kind: inferExportKind(resolvedSymbol, declaration),
    source: declarationSource ? { path: relativePath(repoRoot, declarationSource.fileName) } : null,
  };
}

const EXPORT_KIND_SORT_RANK: Record<PluginSdkApiExportKind, number> = {
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

function sortExports(left: RenderedPluginSdkApiExport, right: RenderedPluginSdkApiExport): number {
  return (
    EXPORT_KIND_SORT_RANK[left.kind] - EXPORT_KIND_SORT_RANK[right.kind] ||
    compareText(left.exportName, right.exportName)
  );
}

function buildModuleSurface(params: {
  checker: Checker;
  declarationClosure: DeclarationClosureRenderer;
  printer: Emitter;
  program: Program;
  repoRoot: string;
  entrypoint: string;
}): RenderedPluginSdkApiModule {
  const { checker, declarationClosure, printer, program, repoRoot, entrypoint } = params;
  const metadata = Object.hasOwn(pluginSdkDocMetadata, entrypoint)
    ? pluginSdkDocMetadata[entrypoint as PluginSdkDocEntrypoint]
    : undefined;
  const importSpecifier = `openclaw/plugin-sdk/${entrypoint}`;
  const moduleSourcePath = path.join(repoRoot, "src", "plugin-sdk", `${entrypoint}.ts`);
  const sourceFile = program.getSourceFile(moduleSourcePath);
  assert(sourceFile, `Missing source file for ${importSpecifier}`);

  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  assert(moduleSymbol, `Unable to resolve module symbol for ${importSpecifier}`);

  const exports = checker
    .getExportsOfModule(moduleSymbol)
    .filter((symbol) => symbol.name !== "__esModule")
    .map((symbol) =>
      buildExportSurface({
        checker,
        declarationClosure,
        printer,
        repoRoot,
        symbol,
      }),
    )
    .toSorted(sortExports);

  return {
    category: metadata?.category ?? null,
    entrypoint,
    exports,
    importSpecifier,
    source: { path: relativePath(repoRoot, moduleSourcePath) },
  };
}

/** Render a public SDK API surface without writing generated artifacts. */
export async function renderPluginSdkApiBaseline(params?: {
  repoRoot?: string;
  entrypoints?: readonly string[];
}): Promise<PluginSdkApiBaseline> {
  const repoRoot = params?.repoRoot ?? resolveRepoRoot();
  const entrypoints = params?.entrypoints ?? listPluginSdkApiBaselineEntrypoints();
  if (params?.entrypoints === undefined) {
    validateMetadata();
  }
  const configPath = path.join(repoRoot, "tsconfig.json");
  const { executable: binary } = resolveInstalledNativeTypeScriptCompiler();
  const snapshot = () =>
    new CompilerInputSnapshot(repoRoot, { toolchainFiles: [binary], generatorInputs: [] });
  const before = snapshot();
  before.signature(configPath, [], []);
  const startedAt = Date.now();
  const context = await createCompilerContext(repoRoot, entrypoints);
  const { checker, declarationClosure, printer, program } = context;
  try {
    const modules = [...entrypoints].toSorted(compareText).map((entrypoint) =>
      buildModuleSurface({
        checker,
        declarationClosure,
        printer,
        program,
        repoRoot,
        entrypoint,
      }),
    );

    const sectionsByContent = new Map<string, PluginSdkApiDeclarationSection>();
    for (const moduleSurface of modules) {
      for (const exportSurface of moduleSurface.exports) {
        for (const section of exportSurface.closureSections ?? []) {
          sectionsByContent.set(`${section.name}\0${section.text}`, section);
        }
      }
    }
    const declarationSections = [...sectionsByContent.values()].toSorted(
      (left, right) => compareText(left.name, right.name) || compareText(left.text, right.text),
    );
    const sectionIds = new Map(
      declarationSections.map((section, index) => [`${section.name}\0${section.text}`, index]),
    );
    const baseline = {
      declarationSections,
      modules: modules
        .map((moduleSurface) => ({
          category: moduleSurface.category,
          entrypoint: moduleSurface.entrypoint,
          exports: moduleSurface.exports.map((exportSurface) => ({
            closureHash: exportSurface.closureHash,
            closureSectionIds:
              exportSurface.closureSections?.map((section) => {
                const id = sectionIds.get(`${section.name}\0${section.text}`);
                assert(id !== undefined, "Missing Plugin SDK declaration section");
                return id;
              }) ?? null,
            declaration: exportSurface.declaration,
            exportName: exportSurface.exportName,
            kind: exportSurface.kind,
            source: exportSurface.source,
          })),
          importSpecifier: moduleSurface.importSpecifier,
          source: moduleSurface.source,
        }))
        .toSorted((left, right) => compareText(left.importSpecifier, right.importSpecifier)),
    };
    // Source symbols and emitted closure text must describe the same input generation.
    snapshot().seal(configPath, [], context.inputs, before, startedAt);
    return baseline;
  } finally {
    context.close();
  }
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
