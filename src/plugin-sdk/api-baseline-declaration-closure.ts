// Declaration closure rendering keeps compiler-owned dependencies in API baselines.
import { createHash } from "node:crypto";
import path from "node:path";
import * as ts from "typescript/unstable/ast";
import type { Program, Project } from "typescript/unstable/sync";
import { formatNativeTypeScriptDiagnostics } from "../../scripts/lib/native-typescript-diagnostics.mts";
import {
  normalizePluginSdkApiDeclarationText,
  normalizePluginSdkApiSourcePath,
} from "./api-baseline-normalization.js";

export type PluginSdkApiDeclarationSection = { name: string; text: string };
type DeclarationClosure = { hash: string; sections: PluginSdkApiDeclarationSection[] };

type DeclarationReference = { literal: ts.StringLiteralLikeNode; specifier: string };
type EmittedDeclaration = { declarationFile: ts.SourceFile; text: string };
type DeclarationSection = PluginSdkApiDeclarationSection;
type Dependency =
  | { kind: "external" }
  | { kind: "failure" }
  | { exportedName: string; kind: "repo"; sourceFile: ts.SourceFile };
type Reexport = { kind: "local"; name: string } | { dependency: Dependency; kind: "module" };
type DeclarationIndex = {
  declaration: EmittedDeclaration;
  declarations: Map<string, ts.Statement[]>;
  exportStars: Dependency[];
  globals: ts.ModuleDeclaration[];
  imports: Map<string, Dependency>;
  reexports: Map<string, Reexport>;
  sideEffects: Dependency[];
};
type Sections = Map<string, DeclarationSection>;
type Walk = { sections: Sections; tainted: boolean };
type WalkResult = Walk | null;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function addSection(sections: Sections, section: DeclarationSection): void {
  // Sections intentionally dedupe by {name, text}: same-name byte-identical nominal declarations
  // collapse across files because path-bearing identity would restore move churn. Silent
  // repointing between such twins is the accepted narrow escape window.
  sections.set(`${section.name}\0${section.text}`, section);
}

function appendSections(target: Sections, source: Sections): void {
  for (const [key, section] of source) {
    target.set(key, section);
  }
}

function appendWalk(target: Sections, walk: Walk): boolean {
  appendSections(target, walk.sections);
  return walk.tainted;
}

function collectDeclarationReferences(sourceFile: ts.SourceFile): DeclarationReference[] {
  const references = new Map<string, DeclarationReference>();
  const add = (literal: ts.StringLiteralLikeNode) => {
    references.set(`${literal.pos}\0${literal.text}`, { literal, specifier: literal.text });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLikeNode(node.moduleSpecifier)) {
      add(node.moduleSpecifier);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLikeNode(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteralLikeNode(node.moduleReference.expression)
    ) {
      add(node.moduleReference.expression);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLikeNode(node.argument.literal)
    ) {
      add(node.argument.literal);
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return [...references.values()].toSorted(
    (left, right) =>
      compareText(left.specifier, right.specifier) || left.literal.pos - right.literal.pos,
  );
}

function collectBindingNames(name: ts.BindingName, names: string[]): void {
  if (ts.isIdentifier(name)) {
    names.push(name.text);
    return;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element) && element.name) {
      collectBindingNames(element.name, names);
    }
  }
}

function declaredNames(statement: ts.Statement): string[] {
  if (ts.isVariableStatement(statement)) {
    const names: string[] = [];
    for (const declaration of statement.declarationList.declarations) {
      collectBindingNames(declaration.name, names);
    }
    return names;
  }
  if (
    (ts.isClassDeclaration(statement) ||
      ts.isEnumDeclaration(statement) ||
      ts.isFunctionDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      ts.isModuleDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement)) &&
    statement.name &&
    ts.isIdentifier(statement.name)
  ) {
    return [statement.name.text];
  }
  return [];
}

function referencedNames(statement: ts.Statement, ownNames: readonly string[]): string[] {
  const names = new Set<string>();
  const own = new Set(ownNames);
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && !own.has(node.text)) {
      names.add(node.text);
    }
    node.forEachChild(visit);
  };
  visit(statement);
  return [...names].toSorted(compareText);
}

function importTypeTarget(node: ts.ImportTypeNode): string | null {
  let qualifier = node.qualifier;
  while (qualifier && ts.isQualifiedName(qualifier)) {
    qualifier = qualifier.left;
  }
  return qualifier && ts.isIdentifier(qualifier) ? qualifier.text : null;
}

export function createDeclarationClosureRenderer(params: {
  project: Project;
  sourceProgram: Program;
  emittedSources: ReadonlySet<string>;
  repoRoot: string;
}): (sourceFile: ts.SourceFile, exportName: string) => DeclarationClosure | null {
  const { project, sourceProgram: program, emittedSources, repoRoot } = params;
  const printer = project.emitter;
  const isGlobalAugmentation = (node: ts.Node): node is ts.ModuleDeclaration =>
    ts.isModuleDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "global" &&
    project.checker.getSymbolAtLocation(node.name)?.escapedName === ts.InternalSymbolName.Global;
  const printStatement = (statement: ts.Statement) => {
    const text = printer.printNode(statement).trim();
    // The native AST wire format drops the augmentation marker; its printer adds a module
    // keyword. The checker still identifies the augmentation, so preserve that syntax.
    return isGlobalAugmentation(statement)
      ? text.replace(/^declare module global\b/u, "declare global")
      : text;
  };
  const canonical = (fileName: string) => path.resolve(fileName);
  const emitted = new Map<string, EmittedDeclaration>();
  const indexes = new Map<string, DeclarationIndex>();
  const renderedClosures = new Map<string, DeclarationClosure>();
  const reachability = new Map<string, WalkResult>();
  const active = new Set<string>();
  const rootReachability = new Map<string, WalkResult>();
  const ambientReachability = new Map<string, Walk>();
  const activeAmbient = new Set<string>();
  const rootAmbientReachability = new Map<string, Walk>();
  const unresolvedDependencies = new Set<string>();

  const baseDiagnostics = [
    ...program.getConfigFileParsingDiagnostics(),
    ...program.getProgramDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ];
  if (baseDiagnostics.length > 0) {
    throw new Error(
      `Unable to emit Plugin SDK declarations:\n${formatNativeTypeScriptDiagnostics(baseDiagnostics)}`,
    );
  }

  const isRepoOwned = (sourceFile: ts.SourceFile) => {
    if (
      program.isSourceFileDefaultLibrary(sourceFile) ||
      program.isSourceFileFromExternalLibrary(sourceFile)
    ) {
      return false;
    }
    const relative = path.relative(repoRoot, path.resolve(sourceFile.fileName));
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      !relative.split(path.sep).includes("node_modules")
    );
  };

  const getDeclaration = (sourceFile: ts.SourceFile): EmittedDeclaration => {
    const key = canonical(sourceFile.fileName);
    const cached = emitted.get(key);
    if (cached) {
      return cached;
    }
    if (!sourceFile.isDeclarationFile && !emittedSources.has(sourceFile.fileName)) {
      throw new Error(
        `Missing emitted declaration for ${normalizePluginSdkApiSourcePath(repoRoot, sourceFile.fileName)}`,
      );
    }
    const declarationFile = project.program.getSourceFile(sourceFile.fileName);
    if (!declarationFile) {
      throw new Error(`Missing Plugin SDK declaration module ${sourceFile.fileName}`);
    }
    const diagnostics = project.program.getSyntacticDiagnostics(sourceFile.fileName);
    if (diagnostics.length > 0) {
      throw new Error(
        `Unable to read Plugin SDK declarations:\n${formatNativeTypeScriptDiagnostics(diagnostics)}`,
      );
    }

    const declaration = {
      declarationFile,
      text: normalizePluginSdkApiDeclarationText(
        repoRoot,
        [
          ...(ts.getLeadingCommentRanges(declarationFile.text, 0) ?? [])
            .map((comment) => declarationFile.text.slice(comment.pos, comment.end))
            .filter((comment) => /^\/\/\/\s*<reference\b/u.test(comment)),
          ...declarationFile.statements.map(printStatement),
        ]
          .join("\n")
          .trim(),
      ),
    };
    emitted.set(key, declaration);
    return declaration;
  };

  const resolveDependency = (
    sourceFile: ts.SourceFile,
    reference: DeclarationReference,
    exportedName: string,
  ): Dependency => {
    // Resolve the actual emitted literal, including its enclosing import attributes and
    // import-equals syntax. The native checker owns package conditions and resolution modes.
    const symbol = project.checker.getSymbolAtLocation(reference.literal);
    const target = symbol?.declarations
      .map((handle) => handle.resolve()?.getSourceFile())
      .find((file) => file !== undefined);
    if (!target) {
      if (!reference.specifier.startsWith("node:")) {
        unresolvedDependencies.add(
          `${normalizePluginSdkApiSourcePath(repoRoot, sourceFile.fileName)} -> ${reference.specifier}`,
        );
      }
      return {
        kind:
          reference.specifier.startsWith(".") || path.isAbsolute(reference.specifier)
            ? "failure"
            : "external",
      };
    }
    const dependency = program.getSourceFile(target.fileName);
    if (!dependency) {
      const relative = path.relative(repoRoot, path.resolve(target.fileName));
      return relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative) &&
        !relative.split(path.sep).includes("node_modules")
        ? (unresolvedDependencies.add(
            `${normalizePluginSdkApiSourcePath(repoRoot, sourceFile.fileName)} -> ${reference.specifier}`,
          ),
          { kind: "failure" })
        : { kind: "external" };
    }
    return isRepoOwned(dependency)
      ? { exportedName, kind: "repo", sourceFile: dependency }
      : { kind: "external" };
  };

  const referenceFor = (literal: ts.StringLiteralLikeNode): DeclarationReference => ({
    literal,
    specifier: literal.text,
  });

  const getIndex = (sourceFile: ts.SourceFile): DeclarationIndex => {
    const key = canonical(sourceFile.fileName);
    const cached = indexes.get(key);
    if (cached) {
      return cached;
    }
    const declaration = getDeclaration(sourceFile);
    const declarations = new Map<string, ts.Statement[]>();
    const imports = new Map<string, Dependency>();
    const reexports = new Map<string, Reexport>();
    const exportStars: Dependency[] = [];
    const globals: ts.ModuleDeclaration[] = [];
    const sideEffects: Dependency[] = [];
    const addDeclaration = (name: string, statement: ts.Statement) => {
      declarations.set(name, [...(declarations.get(name) ?? []), statement]);
    };
    for (const statement of declaration.declarationFile.statements) {
      if (isGlobalAugmentation(statement)) {
        globals.push(statement);
        continue;
      }
      for (const name of declaredNames(statement)) {
        addDeclaration(name, statement);
        if (
          (ts.isClassDeclaration(statement) ||
            ts.isFunctionDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement)) &&
          statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)
        ) {
          addDeclaration("default", statement);
        }
      }
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteralLikeNode(statement.moduleSpecifier)
      ) {
        const reference = referenceFor(statement.moduleSpecifier);
        if (!statement.importClause) {
          sideEffects.push(resolveDependency(sourceFile, reference, "*"));
          continue;
        }
        if (statement.importClause.name) {
          imports.set(
            statement.importClause.name.text,
            resolveDependency(sourceFile, reference, "default"),
          );
        }
        const bindings = statement.importClause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          imports.set(bindings.name.text, resolveDependency(sourceFile, reference, "*"));
        } else if (bindings) {
          for (const element of bindings.elements) {
            imports.set(
              element.name.text,
              resolveDependency(
                sourceFile,
                reference,
                element.propertyName?.text ?? element.name.text,
              ),
            );
          }
        }
      } else if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        statement.moduleReference.expression &&
        ts.isStringLiteralLikeNode(statement.moduleReference.expression)
      ) {
        imports.set(
          statement.name.text,
          resolveDependency(sourceFile, referenceFor(statement.moduleReference.expression), "*"),
        );
      } else if (
        ts.isExportDeclaration(statement) &&
        (!statement.moduleSpecifier || ts.isStringLiteralLikeNode(statement.moduleSpecifier))
      ) {
        if (!statement.moduleSpecifier) {
          if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
            for (const element of statement.exportClause.elements) {
              reexports.set(element.name.text, {
                kind: "local",
                name: element.propertyName?.text ?? element.name.text,
              });
            }
          }
          continue;
        }
        const reference = referenceFor(statement.moduleSpecifier);
        if (!statement.exportClause) {
          exportStars.push(resolveDependency(sourceFile, reference, "*"));
        } else if (ts.isNamespaceExport(statement.exportClause)) {
          reexports.set(statement.exportClause.name.text, {
            dependency: resolveDependency(sourceFile, reference, "*"),
            kind: "module",
          });
        } else {
          for (const element of statement.exportClause.elements) {
            reexports.set(element.name.text, {
              dependency: resolveDependency(
                sourceFile,
                reference,
                element.propertyName?.text ?? element.name.text,
              ),
              kind: "module",
            });
          }
        }
      }
    }
    const index = {
      declaration,
      declarations,
      exportStars,
      globals,
      imports,
      reexports,
      sideEffects,
    };
    indexes.set(key, index);
    return index;
  };

  const statementText = (statement: ts.Statement) =>
    normalizePluginSdkApiDeclarationText(repoRoot, printStatement(statement));
  const globalSections = (index: DeclarationIndex): Sections => {
    const sections = new Map<string, DeclarationSection>();
    for (const statement of index.globals) {
      addSection(sections, { name: "global", text: statementText(statement) });
    }
    return sections;
  };

  const fallbackFile = (sourceFile: ts.SourceFile, visited = new Set<string>()): Sections => {
    const key = canonical(sourceFile.fileName);
    if (visited.has(key)) {
      return new Map();
    }
    visited.add(key);
    const index = getIndex(sourceFile);
    let text = index.declaration.text;
    const sections = new Map<string, DeclarationSection>();
    for (const reference of collectDeclarationReferences(index.declaration.declarationFile)) {
      const dependency = resolveDependency(sourceFile, reference, "*");
      if (dependency.kind !== "external") {
        text = text.replaceAll(`"${reference.specifier}"`, '"<repo>"');
        text = text.replaceAll(`'${reference.specifier}'`, "'<repo>'");
      }
      if (dependency.kind === "repo") {
        appendSections(sections, fallbackFile(dependency.sourceFile, visited));
      }
    }
    addSection(sections, { name: "*", text });
    return sections;
  };

  // Fail toward recall: an unindexable declaration retains the whole declaration subtree;
  // omitting it could let a reachable private type change escape the API baseline.
  const recallFallback = (sourceFile: ts.SourceFile): Walk => ({
    sections: fallbackFile(sourceFile),
    tainted: false,
  });

  const ambientContribution = (sourceFile: ts.SourceFile): Walk => {
    const key = canonical(sourceFile.fileName);
    const cached = ambientReachability.get(key) ?? rootAmbientReachability.get(key);
    if (cached) {
      return cached;
    }
    if (activeAmbient.has(key)) {
      return { sections: new Map(), tainted: true };
    }
    activeAmbient.add(key);
    const index = getIndex(sourceFile);
    const sections = globalSections(index);
    let tainted = false;
    for (const dependency of index.sideEffects) {
      if (dependency.kind === "failure") {
        tainted = appendWalk(sections, recallFallback(sourceFile)) || tainted;
      } else if (dependency.kind === "repo") {
        // Side-effect imports expose only ambient globals; named declarations are unreachable by
        // name through that edge and intentionally stay out of the closure.
        tainted = appendWalk(sections, ambientContribution(dependency.sourceFile)) || tainted;
      }
    }
    activeAmbient.delete(key);
    const result = { sections, tainted };
    if (!tainted) {
      ambientReachability.set(key, result);
    } else {
      rootAmbientReachability.set(key, result);
    }
    return result;
  };

  const resolveWalkDependency = (dependency: Dependency, owner: ts.SourceFile): Walk => {
    if (dependency.kind === "external") {
      return { sections: new Map(), tainted: false };
    }
    if (dependency.kind === "failure") {
      return recallFallback(owner);
    }
    if (dependency.exportedName === "*") {
      return recallFallback(dependency.sourceFile);
    }
    const result = walkDeclaration(dependency.sourceFile, dependency.exportedName, true);
    return result ?? recallFallback(dependency.sourceFile);
  };

  const walkStatementImports = (sourceFile: ts.SourceFile, statement: ts.Statement) => {
    const sections = new Map<string, DeclarationSection>();
    let tainted = false;
    const visit = (node: ts.Node) => {
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteralLikeNode(node.argument.literal)
      ) {
        const dependency = resolveDependency(
          sourceFile,
          referenceFor(node.argument.literal),
          importTypeTarget(node) ?? "*",
        );
        tainted = appendWalk(sections, resolveWalkDependency(dependency, sourceFile)) || tainted;
      }
      node.forEachChild(visit);
    };
    visit(statement);
    return { sections, tainted };
  };

  const walkDeclaration = (
    sourceFile: ts.SourceFile,
    name: string,
    exported: boolean,
  ): WalkResult => {
    const key = `${canonical(sourceFile.fileName)}\0${exported ? "export" : "local"}\0${name}`;
    const cached = reachability.get(key) ?? rootReachability.get(key);
    if (cached !== undefined || reachability.has(key) || rootReachability.has(key)) {
      return cached ?? null;
    }
    if (active.has(key)) {
      return { sections: new Map(), tainted: true };
    }
    active.add(key);
    const index = getIndex(sourceFile);
    const statements = index.declarations.get(name);
    let result: WalkResult;
    if (statements) {
      const ambient = ambientContribution(sourceFile);
      const sections = new Map(ambient.sections);
      let tainted = ambient.tainted;
      for (const statement of statements) {
        addSection(sections, { name, text: statementText(statement) });
        tainted = appendWalk(sections, walkStatementImports(sourceFile, statement)) || tainted;
        for (const reference of referencedNames(statement, declaredNames(statement))) {
          if (index.declarations.has(reference)) {
            tainted =
              appendWalk(
                sections,
                walkDeclaration(sourceFile, reference, false) ?? recallFallback(sourceFile),
              ) || tainted;
          } else {
            const dependency = index.imports.get(reference);
            if (dependency) {
              tainted =
                appendWalk(sections, resolveWalkDependency(dependency, sourceFile)) || tainted;
            }
          }
        }
      }
      result = { sections, tainted };
    } else if (!exported) {
      result = null;
    } else {
      const reexport = index.reexports.get(name);
      if (reexport?.kind === "local") {
        result = walkDeclaration(sourceFile, reexport.name, false) ?? recallFallback(sourceFile);
      } else if (reexport) {
        result = resolveWalkDependency(reexport.dependency, sourceFile);
      } else {
        result = null;
        for (const dependency of index.exportStars) {
          if (dependency.kind !== "repo") {
            if (dependency.kind === "failure") {
              result = recallFallback(sourceFile);
              break;
            }
            continue;
          }
          const candidate = walkDeclaration(dependency.sourceFile, name, true);
          if (candidate) {
            result = candidate;
            break;
          }
        }
      }
    }
    active.delete(key);
    if (result?.tainted) {
      // Back-edge results are complete only inside the current root union. Caching them can let
      // reachable cycle changes escape the hash and make later exports entry-order sensitive.
      // Reuse them only within this root: its union already includes the omitted back edge.
      rootReachability.set(key, result);
    } else {
      reachability.set(key, result);
    }
    return result;
  };

  return (owner, exportName) => {
    if (!isRepoOwned(owner)) {
      return null;
    }
    const cacheKey = `${canonical(owner.fileName)}\0${exportName}`;
    const cached = renderedClosures.get(cacheKey);
    if (cached) {
      return cached;
    }
    rootReachability.clear();
    rootAmbientReachability.clear();
    const walk = walkDeclaration(owner, exportName, true) ?? recallFallback(owner);
    const uniqueSections = [...walk.sections.values()].toSorted(
      (left, right) => compareText(left.name, right.name) || compareText(left.text, right.text),
    );
    const closure = {
      hash: createHash("sha256").update(JSON.stringify(uniqueSections), "utf8").digest("hex"),
      sections: uniqueSections,
    };
    if (unresolvedDependencies.size > 0) {
      throw new Error(
        `Unable to resolve Plugin SDK declaration dependencies:\n${[...unresolvedDependencies].toSorted(compareText).join("\n")}`,
      );
    }
    renderedClosures.set(cacheKey, closure);
    return closure;
  };
}
