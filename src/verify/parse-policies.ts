/**
 * AST parser for policy files:
 * - tool-policy-shared.ts → TOOL_NAME_ALIASES
 * - tool-policy.ts → OWNER_ONLY_TOOL_NAME_FALLBACKS
 * - pi-tools.policy.ts → SUBAGENT_TOOL_DENY_ALWAYS, SUBAGENT_TOOL_DENY_LEAF
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import type { ParsedPolicies } from "./types.js";

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

/** Parse a Record<string, string> object literal */
function parseStringRecord(node: ts.Expression): Record<string, string> {
  const result: Record<string, string> = {};
  if (!ts.isObjectLiteralExpression(node)) {
    return result;
  }
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop)) {
      let key: string | undefined;
      if (ts.isIdentifier(prop.name)) {
        key = prop.name.text;
      } else if (ts.isStringLiteral(prop.name)) {
        key = prop.name.text;
      }
      const value = ts.isStringLiteral(prop.initializer) ? prop.initializer.text : undefined;
      if (key && value !== undefined) {
        result[key] = value;
      } else if (key && value === undefined) {
        console.warn(
          `[parse-policies] Warning: alias key "${key}" has a non-string-literal value and was skipped`,
        );
      }
    }
  }
  return result;
}

/** Parse a new Set<string>([...]) or new Set([...]) initializer */
function parseNewSetStrings(node: ts.Expression): string[] {
  if (!ts.isNewExpression(node)) {
    return [];
  }
  const args = node.arguments;
  if (!args || args.length === 0) {
    return [];
  }
  const firstArg = args[0];
  if (!ts.isArrayLiteralExpression(firstArg)) {
    return [];
  }
  return firstArg.elements
    .map((el) => (ts.isStringLiteral(el) ? el.text : undefined))
    .filter((s): s is string => s !== undefined);
}

/** Parse a string[] array literal */
function parseStringArray(node: ts.Expression): string[] {
  if (!ts.isArrayLiteralExpression(node)) {
    return [];
  }
  return node.elements
    .map((el) => (ts.isStringLiteral(el) ? el.text : undefined))
    .filter((s): s is string => s !== undefined);
}

function parseAliases(srcDir: string): Record<string, string> {
  const filePath = path.join(srcDir, "agents", "tool-policy-shared.ts");
  const sourceFile = parseSourceFile(filePath);
  const decl = findVariableDeclaration(sourceFile, "TOOL_NAME_ALIASES");
  if (!decl?.initializer) {
    throw new Error(`[parse-policies] Could not find TOOL_NAME_ALIASES in ${filePath}`);
  }
  const aliases = parseStringRecord(decl.initializer);
  console.log(`[parse-policies] Parsed ${Object.keys(aliases).length} aliases`);
  return aliases;
}

function parseOwnerOnlyFallbacks(srcDir: string): string[] {
  const filePath = path.join(srcDir, "agents", "tool-policy.ts");
  const sourceFile = parseSourceFile(filePath);
  const decl = findVariableDeclaration(sourceFile, "OWNER_ONLY_TOOL_NAME_FALLBACKS");
  if (!decl?.initializer) {
    throw new Error(
      `[parse-policies] Could not find OWNER_ONLY_TOOL_NAME_FALLBACKS in ${filePath}`,
    );
  }
  const items = parseNewSetStrings(decl.initializer);
  if (items.length === 0) {
    throw new Error(`[parse-policies] Error: OWNER_ONLY_TOOL_NAME_FALLBACKS is empty`);
  }
  console.log(`[parse-policies] Parsed ${items.length} owner-only fallbacks`);
  return items;
}

function parseSubagentDenyLists(srcDir: string): {
  denyAlways: string[];
  denyLeaf: string[];
} {
  const filePath = path.join(srcDir, "agents", "pi-tools.policy.ts");
  const sourceFile = parseSourceFile(filePath);

  const alwaysDecl = findVariableDeclaration(sourceFile, "SUBAGENT_TOOL_DENY_ALWAYS");
  if (!alwaysDecl?.initializer) {
    throw new Error(`[parse-policies] Could not find SUBAGENT_TOOL_DENY_ALWAYS in ${filePath}`);
  }
  const denyAlways = parseStringArray(alwaysDecl.initializer);

  const leafDecl = findVariableDeclaration(sourceFile, "SUBAGENT_TOOL_DENY_LEAF");
  if (!leafDecl?.initializer) {
    throw new Error(`[parse-policies] Could not find SUBAGENT_TOOL_DENY_LEAF in ${filePath}`);
  }
  const denyLeaf = parseStringArray(leafDecl.initializer);

  console.log(
    `[parse-policies] Parsed subagent deny lists: ${denyAlways.length} always, ${denyLeaf.length} leaf`,
  );
  return { denyAlways, denyLeaf };
}

export function parsePolicies(srcDir: string): ParsedPolicies {
  const aliases = parseAliases(srcDir);
  const ownerOnlyFallbacks = parseOwnerOnlyFallbacks(srcDir);
  const { denyAlways, denyLeaf } = parseSubagentDenyLists(srcDir);
  return {
    aliases,
    ownerOnlyFallbacks,
    subagentDenyAlways: denyAlways,
    subagentDenyLeaf: denyLeaf,
    // extraTools is intentionally hardcoded here because `whatsapp_login` is an intrinsic
    // security boundary that is treated as a core tool, despite not being in the
    // `CORE_TOOL_DEFINITIONS` catalog array itself. Without full cross-file resolution
    // joining `ParsedToolCatalog` and `ParsedPolicies`, we cannot dynamically compute this.
    extraTools: ["whatsapp_login"],
  };
}
