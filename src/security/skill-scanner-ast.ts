/**
 * AST-based skill scanner — catches evasion techniques that regex patterns miss.
 *
 * Uses TypeScript's built-in parser (zero new dependencies) to detect:
 * - Dynamic imports with variable/computed specifiers
 * - require() calls with non-literal arguments
 * - Indirect eval patterns (e.g., `const e = eval; e(...)`, `globalThis["eval"](...)`)
 * - new Function() via computed property access
 * - Prototype pollution patterns (__proto__, constructor.prototype assignment)
 *
 * Designed to complement (not replace) the regex-based scanner.
 */

import path from "node:path";
import ts from "typescript";
import type { SkillScanFinding, SkillScanSeverity } from "./skill-scanner.js";

// ---------------------------------------------------------------------------
// AST Rule Definitions
// ---------------------------------------------------------------------------

type AstFinding = {
  ruleId: string;
  severity: SkillScanSeverity;
  message: string;
  line: number;
  evidence: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nodeEvidence(node: ts.Node, sourceFile: ts.SourceFile, maxLen = 120): string {
  const text = node.getText(sourceFile).replace(/\s+/g, " ");
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

function nodeLine(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

// ---------------------------------------------------------------------------
// Detectors
// ---------------------------------------------------------------------------

function detectDynamicImport(node: ts.Node, sf: ts.SourceFile, findings: AstFinding[]): void {
  // import("foo") is fine — import(variable) is suspicious
  if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const arg = node.arguments[0];
    if (arg && !ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) {
      findings.push({
        ruleId: "dynamic-import",
        severity: "critical",
        message: "Dynamic import with non-literal specifier (possible code loading evasion)",
        line: nodeLine(node, sf),
        evidence: nodeEvidence(node, sf),
      });
    }
  }
}

function detectDynamicRequire(node: ts.Node, sf: ts.SourceFile, findings: AstFinding[]): void {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require"
  ) {
    const arg = node.arguments[0];
    if (arg && !ts.isStringLiteral(arg) && !ts.isNoSubstitutionTemplateLiteral(arg)) {
      findings.push({
        ruleId: "dynamic-require",
        severity: "critical",
        message: "require() with non-literal argument (possible code loading evasion)",
        line: nodeLine(node, sf),
        evidence: nodeEvidence(node, sf),
      });
    }
  }
}

function detectIndirectEval(node: ts.Node, sf: ts.SourceFile, findings: AstFinding[]): void {
  const GLOBAL_OBJECTS = new Set(["globalThis", "window", "global", "self"]);

  // Catch: globalThis["eval"](...), window["eval"](...), global["eval"](...)
  if (
    ts.isCallExpression(node) &&
    ts.isElementAccessExpression(node.expression)
  ) {
    const arg = node.expression.argumentExpression;
    const obj = node.expression.expression;
    if (
      ts.isStringLiteral(arg) &&
      (arg.text === "eval" || arg.text === "Function") &&
      ts.isIdentifier(obj) &&
      GLOBAL_OBJECTS.has(obj.text)
    ) {
      findings.push({
        ruleId: "indirect-eval",
        severity: "critical",
        message: "Indirect eval/Function via computed property access",
        line: nodeLine(node, sf),
        evidence: nodeEvidence(node, sf),
      });
    }
  }

  // Catch: globalThis.eval(...), window.Function(...)
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    (node.expression.name.text === "eval" || node.expression.name.text === "Function")
  ) {
    const obj = node.expression.expression;
    if (ts.isIdentifier(obj) && GLOBAL_OBJECTS.has(obj.text)) {
      findings.push({
        ruleId: "indirect-eval",
        severity: "critical",
        message: "Indirect eval/Function via global object property access",
        line: nodeLine(node, sf),
        evidence: nodeEvidence(node, sf),
      });
    }
  }

  // Catch: (0, eval)("code") — the comma-operator indirect eval trick
  if (
    ts.isCallExpression(node) &&
    ts.isParenthesizedExpression(node.expression)
  ) {
    const inner = node.expression.expression;
    if (
      ts.isBinaryExpression(inner) &&
      inner.operatorToken.kind === ts.SyntaxKind.CommaToken &&
      ts.isIdentifier(inner.right) &&
      inner.right.text === "eval"
    ) {
      findings.push({
        ruleId: "indirect-eval",
        severity: "critical",
        message: "Indirect eval via comma operator pattern: (0, eval)(...)",
        line: nodeLine(node, sf),
        evidence: nodeEvidence(node, sf),
      });
    }
  }
}

function detectPrototypePollution(
  node: ts.Node,
  sf: ts.SourceFile,
  findings: AstFinding[],
): void {
  // Catch assignment to __proto__ or constructor.prototype
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.EqualsToken
  ) {
    const left = node.left;
    const leftText = left.getText(sf);
    if (
      leftText.includes("__proto__") ||
      leftText.includes("constructor.prototype") ||
      leftText.includes('["__proto__"]') ||
      leftText.includes("['__proto__']")
    ) {
      findings.push({
        ruleId: "prototype-pollution",
        severity: "critical",
        message: "Prototype pollution — assignment to __proto__ or constructor.prototype",
        line: nodeLine(node, sf),
        evidence: nodeEvidence(node, sf),
      });
    }
  }

  // Catch: Object.setPrototypeOf(...), Reflect.setPrototypeOf(...)
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "setPrototypeOf"
  ) {
    const obj = node.expression.expression;
    if (ts.isIdentifier(obj) && (obj.text === "Object" || obj.text === "Reflect")) {
      findings.push({
        ruleId: "prototype-pollution",
        severity: "warn",
        message: "Prototype mutation — setPrototypeOf call detected (review in context)",
        line: nodeLine(node, sf),
        evidence: nodeEvidence(node, sf),
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Main AST scan
// ---------------------------------------------------------------------------

const DETECTORS = [
  detectDynamicImport,
  detectDynamicRequire,
  detectIndirectEval,
  detectPrototypePollution,
] as const;

export function scanSourceAst(source: string, filePath: string): SkillScanFinding[] {
  let sourceFile: ts.SourceFile;
  try {
    const ext = path.extname(filePath).toLowerCase();
    const scriptKind =
      ext === ".tsx"
        ? ts.ScriptKind.TSX
        : ext === ".jsx"
          ? ts.ScriptKind.JSX
          : [".mjs", ".cjs", ".js"].includes(ext)
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS;
    sourceFile = ts.createSourceFile(
      filePath,
      source,
      ts.ScriptTarget.Latest,
      /* setParentNodes */ false,
      scriptKind,
    );
  } catch {
    // Report that AST analysis could not run — a malicious skill could use
    // intentionally malformed syntax to bypass AST detection.
    return [
      {
        ruleId: "ast-parse-error",
        severity: "warn" as SkillScanSeverity,
        file: filePath,
        line: 1,
        message: "AST parse failed — file not fully analyzed by structural scanner",
        evidence: "",
      },
    ];
  }

  const astFindings: AstFinding[] = [];
  const seenRules = new Set<string>();

  function visit(node: ts.Node): void {
    for (const detector of DETECTORS) {
      detector(node, sourceFile, astFindings);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  // Deduplicate: one finding per ruleId per file
  const results: SkillScanFinding[] = [];
  for (const f of astFindings) {
    if (seenRules.has(f.ruleId)) continue;
    seenRules.add(f.ruleId);
    results.push({
      ruleId: f.ruleId,
      severity: f.severity,
      file: filePath,
      line: f.line,
      message: f.message,
      evidence: f.evidence,
    });
  }

  return results;
}
