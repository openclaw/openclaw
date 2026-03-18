import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const RUNTIME_API_EXPORT_GUARDS: Record<string, readonly string[]> = {
  "extensions/discord/runtime-api.ts": [
    'export * from "./src/audit.js";',
    'export * from "./src/actions/runtime.js";',
    'export * from "./src/actions/runtime.moderation-shared.js";',
    'export * from "./src/actions/runtime.shared.js";',
    'export * from "./src/channel-actions.js";',
    'export * from "./src/directory-live.js";',
    'export * from "./src/monitor.js";',
    'export * from "./src/monitor/gateway-plugin.js";',
    'export * from "./src/monitor/gateway-registry.js";',
    'export * from "./src/monitor/presence-cache.js";',
    'export * from "./src/monitor/thread-bindings.js";',
    'export * from "./src/monitor/thread-bindings.manager.js";',
    'export * from "./src/monitor/timeouts.js";',
    'export * from "./src/probe.js";',
    'export * from "./src/resolve-channels.js";',
    'export * from "./src/resolve-users.js";',
    'export * from "./src/send.js";',
  ],
  "extensions/imessage/runtime-api.ts": [
    'export * from "./src/monitor.js";',
    'export * from "./src/probe.js";',
    'export * from "./src/send.js";',
  ],
  "extensions/nextcloud-talk/runtime-api.ts": [
    'export * from "openclaw/plugin-sdk/nextcloud-talk";',
  ],
  "extensions/signal/runtime-api.ts": [
    'export * from "./src/index.js";',
  ],
  "extensions/slack/runtime-api.ts": [
    'export * from "./src/action-runtime.js";',
    'export * from "./src/directory-live.js";',
    'export * from "./src/index.js";',
    'export * from "./src/resolve-channels.js";',
    'export * from "./src/resolve-users.js";',
  ],
  "extensions/telegram/runtime-api.ts": [
    'export * from "./src/audit.js";',
    'export * from "./src/action-runtime.js";',
    'export * from "./src/channel-actions.js";',
    'export * from "./src/monitor.js";',
    'export * from "./src/probe.js";',
    'export * from "./src/send.js";',
    'export * from "./src/thread-bindings.js";',
    'export * from "./src/token.js";',
  ],
  "extensions/whatsapp/runtime-api.ts": [
    'export * from "./src/active-listener.js";',
    'export * from "./src/action-runtime.js";',
    'export * from "./src/agent-tools-login.js";',
    'export * from "./src/auth-store.js";',
    'export * from "./src/auto-reply.js";',
    'export * from "./src/inbound.js";',
    'export * from "./src/login.js";',
    'export * from "./src/media.js";',
    'export * from "./src/send.js";',
    'export * from "./src/session.js";',
  ],
} as const;

function collectRuntimeApiFiles(): string[] {
  const extensionsDir = resolve(ROOT_DIR, "..", "extensions");
  const files: string[] = [];
  const stack = [extensionsDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== "runtime-api.ts") {
        continue;
      }
      files.push(relative(resolve(ROOT_DIR, ".."), fullPath).replaceAll("\\", "/"));
    }
  }
  return files;
}

function collectExtensionSourceFiles(): string[] {
  const extensionsDir = resolve(ROOT_DIR, "..", "extensions");
  const files: string[] = [];
  const stack = [extensionsDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || !/\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u.test(entry.name)) {
        continue;
      }
      if (
        entry.name.endsWith(".d.ts") ||
        fullPath.includes(".test.") ||
        fullPath.includes(".test-") ||
        fullPath.includes(".spec.") ||
        fullPath.includes(".fixture.") ||
        fullPath.includes(".snap")
      ) {
        continue;
      }
      files.push(fullPath);
    }
  }
  return files;
}

function loadCompilerOptions(): ts.CompilerOptions {
  const configPath = resolve(ROOT_DIR, "..", "tsconfig.json");
  const readConfig = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (readConfig.error) {
    throw new Error(ts.flattenDiagnosticMessageText(readConfig.error.messageText, "\n"));
  }
  const parsed = ts.parseJsonConfigFileContent(readConfig.config, ts.sys, resolve(ROOT_DIR, ".."));
  return parsed.options;
}

function readExportStatements(path: string): string[] {
  const sourceText = readFileSync(resolve(ROOT_DIR, "..", path), "utf8");
  const sourceFile = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);

  return sourceFile.statements.flatMap((statement) => {
    if (!ts.isExportDeclaration(statement)) {
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
        return [];
      }
      return [statement.getText(sourceFile).replaceAll(/\s+/g, " ").trim()];
    }

    const moduleSpecifier = statement.moduleSpecifier;
    if (!moduleSpecifier || !ts.isStringLiteral(moduleSpecifier)) {
      return [statement.getText(sourceFile).replaceAll(/\s+/g, " ").trim()];
    }

    if (!statement.exportClause) {
      const prefix = statement.isTypeOnly ? "export type *" : "export *";
      return [`${prefix} from ${moduleSpecifier.getText(sourceFile)};`];
    }

    if (!ts.isNamedExports(statement.exportClause)) {
      return [statement.getText(sourceFile).replaceAll(/\s+/g, " ").trim()];
    }

    const specifiers = statement.exportClause.elements.map((element) => {
      const imported = element.propertyName?.text;
      const exported = element.name.text;
      const alias = imported ? `${imported} as ${exported}` : exported;
      return element.isTypeOnly ? `type ${alias}` : alias;
    });
    const exportPrefix = statement.isTypeOnly ? "export type" : "export";
    return [
      `${exportPrefix} { ${specifiers.join(", ")} } from ${moduleSpecifier.getText(sourceFile)};`,
    ];
  });
}

describe("runtime api guardrails", () => {
  it("keeps runtime api seams on an explicit export allowlist", () => {
    const runtimeApiFiles = collectRuntimeApiFiles();
    expect(runtimeApiFiles).toEqual(
      expect.arrayContaining(Object.keys(RUNTIME_API_EXPORT_GUARDS).toSorted()),
    );

    for (const file of Object.keys(RUNTIME_API_EXPORT_GUARDS).toSorted()) {
      expect(readExportStatements(file), `${file} runtime api exports changed`).toEqual(
        RUNTIME_API_EXPORT_GUARDS[file],
      );
    }
  });

  it("keeps extension runtime-api named imports aligned with exported values", () => {
    const sourceFiles = collectExtensionSourceFiles();
    const program = ts.createProgram(sourceFiles, loadCompilerOptions());
    const checker = program.getTypeChecker();
    const failures: string[] = [];

    for (const sourceFile of program.getSourceFiles()) {
      const normalizedPath = sourceFile.fileName.replaceAll("\\", "/");
      if (!normalizedPath.includes("/extensions/")) {
        continue;
      }
      if (
        normalizedPath.includes("/node_modules/") ||
        normalizedPath.endsWith(".d.ts") ||
        normalizedPath.includes(".test.") ||
        normalizedPath.includes(".test-") ||
        normalizedPath.includes(".spec.") ||
        normalizedPath.includes(".fixture.") ||
        normalizedPath.includes(".snap")
      ) {
        continue;
      }

      for (const statement of sourceFile.statements) {
        if (!ts.isImportDeclaration(statement)) {
          continue;
        }
        if (!ts.isStringLiteral(statement.moduleSpecifier)) {
          continue;
        }
        if (!statement.moduleSpecifier.text.endsWith("runtime-api.js")) {
          continue;
        }
        if (!statement.importClause || !statement.importClause.namedBindings) {
          continue;
        }
        if (!ts.isNamedImports(statement.importClause.namedBindings)) {
          continue;
        }

        const moduleSymbol = checker.getSymbolAtLocation(statement.moduleSpecifier);
        if (!moduleSymbol) {
          failures.push(
            `${relative(resolve(ROOT_DIR, ".."), sourceFile.fileName)}: could not resolve ${statement.moduleSpecifier.text}`,
          );
          continue;
        }
        const exportedNames = new Set(
          checker.getExportsOfModule(moduleSymbol).map((sym) => sym.name),
        );
        for (const element of statement.importClause.namedBindings.elements) {
          if (element.isTypeOnly) {
            continue;
          }
          const importedName = element.propertyName?.text ?? element.name.text;
          if (!exportedNames.has(importedName)) {
            failures.push(
              `${relative(resolve(ROOT_DIR, ".."), sourceFile.fileName)} imports ${importedName} from ${statement.moduleSpecifier.text}, but that value is not exported`,
            );
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
