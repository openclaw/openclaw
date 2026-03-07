/**
 * AST parser for tool-catalog.ts
 * Extracts CORE_TOOL_DEFINITIONS and CORE_TOOL_SECTION_ORDER using the TypeScript compiler API.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import type { ParsedToolCatalog, ToolDefinition, SectionOrder } from "./types.js";

function parseSourceFile(filePath: string): ts.SourceFile {
  const content = fs.readFileSync(filePath, "utf-8");
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
}

function findVariableDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): ts.VariableDeclaration | undefined {
  let result: ts.VariableDeclaration | undefined;
  ts.forEachChild(sourceFile, function visit(node) {
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) {
          result = decl;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  });
  return result;
}

function resolveExpression(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
  visited = new Set<string>(),
): ts.Expression {
  if (ts.isIdentifier(node)) {
    if (visited.has(node.text)) {
      return node;
    }
    const decl = findVariableDeclaration(sourceFile, node.text);
    if (decl?.initializer) {
      visited.add(node.text);
      return resolveExpression(decl.initializer, sourceFile, visited);
    }
  }
  return node;
}

function extractStringLiteral(node: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  const resolved = resolveExpression(node, sourceFile);
  if (ts.isStringLiteral(resolved) || ts.isNoSubstitutionTemplateLiteral(resolved)) {
    return resolved.text;
  }
  return undefined;
}

function extractBooleanLiteral(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
): boolean | undefined {
  const resolved = resolveExpression(node, sourceFile);
  if (resolved.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (resolved.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  return undefined;
}

function extractStringArray(node: ts.Expression, sourceFile: ts.SourceFile): string[] {
  const resolved = resolveExpression(node, sourceFile);
  if (!ts.isArrayLiteralExpression(resolved)) {
    return [];
  }
  return resolved.elements
    .map((el) => {
      const resEl = ts.isExpression(el) ? resolveExpression(el, sourceFile) : el;
      return ts.isStringLiteral(resEl) ? resEl.text : undefined;
    })
    .filter((s): s is string => s !== undefined);
}

function extractObjectProperties(node: ts.ObjectLiteralExpression): Map<string, ts.Expression> {
  const props = new Map<string, ts.Expression>();
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop) && ts.isIdentifier(prop.name)) {
      props.set(prop.name.text, prop.initializer);
    }
  }
  return props;
}

function parseToolDefinition(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
): ToolDefinition | undefined {
  const resolved = resolveExpression(node, sourceFile);
  if (!ts.isObjectLiteralExpression(resolved)) {
    return undefined;
  }
  const props = extractObjectProperties(resolved);

  const id = props.has("id") ? extractStringLiteral(props.get("id")!, sourceFile) : undefined;
  const sectionId = props.has("sectionId")
    ? extractStringLiteral(props.get("sectionId")!, sourceFile)
    : undefined;
  const profiles = props.has("profiles")
    ? extractStringArray(props.get("profiles")!, sourceFile)
    : [];
  const includeInOpenClawGroup = props.has("includeInOpenClawGroup")
    ? (extractBooleanLiteral(props.get("includeInOpenClawGroup")!, sourceFile) ?? false)
    : false;

  if (!id || !sectionId) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
    console.warn(
      `[parse-tools] Warning: tool definition at L${line + 1}:${character + 1} missing id or sectionId`,
    );
    return undefined;
  }

  return { id, sectionId, profiles, includeInOpenClawGroup };
}

function parseSectionOrder(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
): SectionOrder | undefined {
  const resolved = resolveExpression(node, sourceFile);
  if (!ts.isObjectLiteralExpression(resolved)) {
    return undefined;
  }
  const props = extractObjectProperties(resolved);
  const id = props.has("id") ? extractStringLiteral(props.get("id")!, sourceFile) : undefined;
  const label = props.has("label")
    ? extractStringLiteral(props.get("label")!, sourceFile)
    : undefined;
  if (!id || !label) {
    return undefined;
  }
  return { id, label };
}

export function parseToolCatalog(srcDir: string): ParsedToolCatalog {
  const filePath = path.join(srcDir, "agents", "tool-catalog.ts");
  const sourceFile = parseSourceFile(filePath);

  // Parse CORE_TOOL_DEFINITIONS
  const defDecl = findVariableDeclaration(sourceFile, "CORE_TOOL_DEFINITIONS");
  if (!defDecl?.initializer || !ts.isArrayLiteralExpression(defDecl.initializer)) {
    throw new Error(`[parse-tools] Could not find CORE_TOOL_DEFINITIONS array in ${filePath}`);
  }
  const tools: ToolDefinition[] = [];
  for (const element of defDecl.initializer.elements) {
    const tool = parseToolDefinition(element, sourceFile);
    if (!tool) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(element.getStart());
      throw new Error(
        `[parse-tools] Failed to parse CORE_TOOL_DEFINITIONS element at ${filePath}:${line + 1}:${character + 1}. ` +
          `All tool definitions must be parseable for verification to be sound.`,
      );
    }
    tools.push(tool);
  }
  if (tools.length === 0) {
    throw new Error(`[parse-tools] No tool definitions parsed from ${filePath}`);
  }

  // Parse CORE_TOOL_SECTION_ORDER
  const sectionDecl = findVariableDeclaration(sourceFile, "CORE_TOOL_SECTION_ORDER");
  if (!sectionDecl?.initializer || !ts.isArrayLiteralExpression(sectionDecl.initializer)) {
    throw new Error(`[parse-tools] Could not find CORE_TOOL_SECTION_ORDER array in ${filePath}`);
  }
  const sectionOrder: SectionOrder[] = [];
  for (const element of sectionDecl.initializer.elements) {
    const section = parseSectionOrder(element, sourceFile);
    if (section) {
      sectionOrder.push(section);
    }
  }

  console.log(
    `[parse-tools] Parsed ${tools.length} tools, ${sectionOrder.length} sections from tool-catalog.ts`,
  );
  return { tools, sectionOrder };
}
