/**
 * Tests the plugin SDK public API baseline.
 */
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  collectPluginSdkApiDeprecatedMembers,
  normalizePluginSdkApiDeclarationText,
  normalizePluginSdkApiSourcePath,
  readPluginSdkApiExportDeprecation,
  readPluginSdkApiDeprecationFromNode,
  readPluginSdkApiModuleDeprecationFromSourceFile,
} from "./api-baseline.js";

/** Build an in-memory TypeScript program for deprecation metadata tests. */
function createDeprecationFixtureProgram(): {
  checker: ts.TypeChecker;
  currentSourceFile: ts.SourceFile;
  fixtureSourceFile: ts.SourceFile;
  program: ts.Program;
} {
  const repoRoot = process.cwd();
  const currentFileName = path.join(repoRoot, "src", "plugin-sdk", "current.ts");
  const fixtureFileName = path.join(repoRoot, "src", "plugin-sdk", "fixture.ts");
  const externalFileName = path.join(repoRoot, "node_modules", "external-pkg", "index.d.ts");
  const files = new Map([
    [
      currentFileName,
      [
        "import type { ExternalOptions } from 'external-pkg';",
        "export type CurrentOptions = {",
        "  /** @deprecated Use target.sessionId. */",
        "  sessionFile?: string;",
        "  target?: CurrentTarget;",
        "};",
        "export type CurrentTarget = {",
        "  session?: CurrentSession;",
        "};",
        "export type CurrentSession = {",
        "  /** @deprecated Use target.sessionId. */",
        "  sessionFile?: string;",
        "};",
        "export function defineThing(options: CurrentOptions): void {}",
        "export function defineExternal(options: ExternalOptions): void {}",
      ].join("\n"),
    ],
    [
      fixtureFileName,
      [
        "/** @deprecated Use CurrentOptions. */",
        "export type { CurrentOptions as LegacyOptions } from './current.js';",
        "export { defineThing } from './current.js';",
      ].join("\n"),
    ],
    [
      externalFileName,
      [
        "export interface ExternalOptions {",
        "  /** @deprecated External package internals are not SDK deprecations. */",
        "  oldExternalField?: string;",
        "}",
      ].join("\n"),
    ],
  ]);
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    target: ts.ScriptTarget.Latest,
  };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  host.readFile = (fileName) => files.get(path.resolve(fileName)) ?? readFile(fileName);
  host.fileExists = (fileName) => files.has(path.resolve(fileName)) || fileExists(fileName);
  host.getSourceFile = (fileName, languageVersion) => {
    const sourceText = files.get(path.resolve(fileName));
    if (sourceText !== undefined) {
      return ts.createSourceFile(fileName, sourceText, languageVersion, true, ts.ScriptKind.TS);
    }
    const fallbackText = readFile(fileName);
    return fallbackText === undefined
      ? undefined
      : ts.createSourceFile(fileName, fallbackText, languageVersion, true);
  };
  const program = ts.createProgram([fixtureFileName], options, host);
  const currentSourceFile = program.getSourceFile(currentFileName);
  const fixtureSourceFile = program.getSourceFile(fixtureFileName);
  if (!currentSourceFile || !fixtureSourceFile) {
    throw new Error("Fixture source files were not loaded");
  }
  return {
    checker: program.getTypeChecker(),
    currentSourceFile,
    fixtureSourceFile,
    program,
  };
}

describe("Plugin SDK API baseline", () => {
  it("normalizes declaration import paths to repo-relative paths", () => {
    const repoRoot = process.cwd();
    const modelCatalogPath = path.join(repoRoot, "src", "agents", "agent-model-discovery");
    const declaration = `export function setModelCatalogImportForTest(loader?: (() => Promise<typeof import("${modelCatalogPath}", { with: { "resolution-mode": "import" } })>) | undefined): void;`;

    const normalized = normalizePluginSdkApiDeclarationText(repoRoot, declaration);

    expect(normalized).not.toContain(repoRoot);
    expect(normalized).toContain(
      'import("src/agents/agent-model-discovery", { with: { "resolution-mode": "import" } })',
    );
  });

  it("normalizes dependency source paths to stable node_modules paths", () => {
    const repoRoot = path.join(path.sep, "workspace", "openclaw-worktree");
    const linkedDependencyPath = path.join(
      path.sep,
      "workspace",
      "openclaw",
      "node_modules",
      "@openclaw",
      "fs-safe",
      "dist",
      "secret-file.d.ts",
    );
    const pnpmDependencyPath = path.join(
      repoRoot,
      "node_modules",
      ".pnpm",
      "@openclaw+fs-safe@1.0.0",
      "node_modules",
      "@openclaw",
      "fs-safe",
      "dist",
      "secret-file.d.ts",
    );

    expect(normalizePluginSdkApiSourcePath(repoRoot, linkedDependencyPath)).toBe(
      "node_modules/@openclaw/fs-safe/dist/secret-file.d.ts",
    );
    expect(normalizePluginSdkApiSourcePath(repoRoot, pnpmDependencyPath)).toBe(
      "node_modules/@openclaw/fs-safe/dist/secret-file.d.ts",
    );
  });

  it("keeps repo source paths relative when a parent directory is named node_modules", () => {
    const repoRoot = path.join(path.sep, "workspace", "node_modules", "openclaw");
    const sourcePath = path.join(repoRoot, "src", "plugin-sdk", "core.ts");

    expect(normalizePluginSdkApiSourcePath(repoRoot, sourcePath)).toBe("src/plugin-sdk/core.ts");
  });

  it("extracts deprecated module, export, and nested member metadata", () => {
    const sourceFile = ts.createSourceFile(
      path.join(process.cwd(), "src", "plugin-sdk", "fixture.ts"),
      [
        "/** @deprecated Compatibility subpath. Use `openclaw/plugin-sdk/current`. */",
        "export * from './current.js';",
        "",
        "/** @deprecated Use NEW_EXPORT. */",
        "export const OLD_EXPORT = 'old';",
        "",
        "export type FixtureOptions = {",
        "  /** @deprecated Use target.sessionId. */",
        "  sessionFile?: string;",
        "  nested?: {",
        "    /** @deprecated Use sessions. */",
        "    sessionFiles?: string[];",
        "  };",
        "};",
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    expect(readPluginSdkApiDeprecationFromNode(sourceFile.statements[0])?.message).toBe(
      "Compatibility subpath. Use `openclaw/plugin-sdk/current`.",
    );
    expect(readPluginSdkApiDeprecationFromNode(sourceFile.statements[1])?.message).toBe(
      "Use NEW_EXPORT.",
    );

    const importBackedModuleSourceFile = ts.createSourceFile(
      path.join(process.cwd(), "src", "plugin-sdk", "import-backed-fixture.ts"),
      [
        "/**",
        " * @deprecated Compatibility subpath.",
        " * Use `openclaw/plugin-sdk/current`.",
        " */",
        "import { current } from './current.js';",
        "export { current };",
      ].join("\n"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    expect(
      readPluginSdkApiModuleDeprecationFromSourceFile(importBackedModuleSourceFile)?.message,
    ).toBe("Compatibility subpath. Use `openclaw/plugin-sdk/current`.");

    const optionsDeclaration = sourceFile.statements[2];
    expect(ts.isTypeAliasDeclaration(optionsDeclaration)).toBe(true);
    if (!ts.isTypeAliasDeclaration(optionsDeclaration)) {
      return;
    }

    expect(
      collectPluginSdkApiDeprecatedMembers(process.cwd(), optionsDeclaration).map((member) => ({
        kind: member.kind,
        name: member.name,
        message: member.deprecated.message,
      })),
    ).toStrictEqual([
      {
        kind: "property",
        name: "sessionFile",
        message: "Use target.sessionId.",
      },
      {
        kind: "property",
        name: "nested.sessionFiles",
        message: "Use sessions.",
      },
    ]);
  });

  it("extracts deprecated alias exports and referenced option types", () => {
    const { checker, currentSourceFile, fixtureSourceFile } = createDeprecationFixtureProgram();
    const moduleSymbol = checker.getSymbolAtLocation(fixtureSourceFile);
    expect(moduleSymbol).toBeDefined();
    if (!moduleSymbol) {
      return;
    }

    const legacySymbol = checker
      .getExportsOfModule(moduleSymbol)
      .find((symbol) => symbol.getName() === "LegacyOptions");
    expect(legacySymbol).toBeDefined();
    if (!legacySymbol) {
      return;
    }
    const resolvedLegacySymbol = checker.getAliasedSymbol(legacySymbol);
    const legacyDeclaration = resolvedLegacySymbol.declarations?.[0];
    expect(legacyDeclaration).toBeDefined();
    if (!legacyDeclaration) {
      return;
    }

    expect(
      readPluginSdkApiExportDeprecation({
        declaration: legacyDeclaration,
        resolvedSymbol: resolvedLegacySymbol,
        symbol: legacySymbol,
      })?.message,
    ).toBe("Use CurrentOptions.");

    const defineThingDeclaration = currentSourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "defineThing",
    );
    expect(defineThingDeclaration).toBeDefined();
    if (!defineThingDeclaration) {
      return;
    }

    expect(
      collectPluginSdkApiDeprecatedMembers(process.cwd(), defineThingDeclaration, checker).map(
        (member) => ({
          kind: member.kind,
          name: member.name,
          message: member.deprecated.message,
        }),
      ),
    ).toStrictEqual([
      {
        kind: "property",
        name: "options.sessionFile",
        message: "Use target.sessionId.",
      },
      {
        kind: "property",
        name: "options.target.session.sessionFile",
        message: "Use target.sessionId.",
      },
    ]);

    const defineExternalDeclaration = currentSourceFile.statements.find(
      (statement): statement is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(statement) && statement.name?.text === "defineExternal",
    );
    expect(defineExternalDeclaration).toBeDefined();
    if (!defineExternalDeclaration) {
      return;
    }
    expect(
      collectPluginSdkApiDeprecatedMembers(process.cwd(), defineExternalDeclaration, checker),
    ).toStrictEqual([]);
  });
});
