/**
 * AST parser for tool-policy-pipeline.ts
 * Extracts the 7 pipeline steps from buildDefaultToolPolicyPipelineSteps.
 */

import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";
import type { ParsedPipeline, PipelineStep } from "./types.js";

function parseSourceFile(filePath: string): ts.SourceFile {
  const content = fs.readFileSync(filePath, "utf-8");
  return ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true);
}

function findFunctionDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): ts.FunctionDeclaration | undefined {
  let result: ts.FunctionDeclaration | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      result = node;
    }
  });
  return result;
}

function extractReturnArrayElements(func: ts.FunctionDeclaration): ts.Expression[] {
  const elements: ts.Expression[] = [];
  if (!func.body) {
    return elements;
  }

  ts.forEachChild(func.body, (node) => {
    if (ts.isReturnStatement(node) && node.expression) {
      if (ts.isArrayLiteralExpression(node.expression)) {
        elements.push(...node.expression.elements);
      }
    }
  });
  return elements;
}

function extractStepFromObject(node: ts.Expression): PipelineStep | undefined {
  if (!ts.isObjectLiteralExpression(node)) {
    return undefined;
  }

  let label = "";
  let paramName = "";
  let stripPluginOnlyAllowlist = false;

  for (const prop of node.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name)) {
      continue;
    }
    const name = prop.name.text;

    if (name === "label") {
      // label can be a string literal or template expression
      if (ts.isStringLiteral(prop.initializer)) {
        label = prop.initializer.text;
      } else {
        // For template or conditional expressions, extract the base label
        label = extractLabelFromExpression(prop.initializer);
      }
    } else if (name === "policy") {
      // Extract the param name from params.XXXPolicy
      paramName = extractParamName(prop.initializer);
    } else if (name === "stripPluginOnlyAllowlist") {
      if (prop.initializer.kind === ts.SyntaxKind.TrueKeyword) {
        stripPluginOnlyAllowlist = true;
      }
    }
  }

  if (!label && !paramName) {
    return undefined;
  }
  return { label, paramName, stripPluginOnlyAllowlist };
}

function extractLabelFromExpression(node: ts.Expression): string {
  if (ts.isStringLiteral(node)) {
    return node.text;
  }
  // For conditional expressions like: profile ? `tools.profile (${profile})` : "tools.profile"
  if (ts.isConditionalExpression(node)) {
    // Use the else branch (simple string) as the base label
    if (ts.isStringLiteral(node.whenFalse)) {
      return node.whenFalse.text;
    }
    if (ts.isTemplateExpression(node.whenTrue)) {
      // Extract from template: "tools.profile (${profile})" -> "tools.profile"
      return node.whenTrue.head.text.trim();
    }
  }
  return "";
}

function extractParamName(node: ts.Expression): string {
  // params.profilePolicy -> "profilePolicy"
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  return "";
}

/** Must match the number of steps in buildDefaultToolPolicyPipelineSteps */
const EXPECTED_PIPELINE_STEPS = 7;

export function parsePipeline(srcDir: string): ParsedPipeline {
  const filePath = path.join(srcDir, "agents", "tool-policy-pipeline.ts");
  const sourceFile = parseSourceFile(filePath);

  const func = findFunctionDeclaration(sourceFile, "buildDefaultToolPolicyPipelineSteps");
  if (!func) {
    throw new Error(
      `[parse-pipeline] Could not find buildDefaultToolPolicyPipelineSteps in ${filePath}`,
    );
  }

  const elements = extractReturnArrayElements(func);
  const steps: PipelineStep[] = [];
  for (const el of elements) {
    const step = extractStepFromObject(el);
    if (step) {
      steps.push(step);
    }
  }

  if (steps.length !== EXPECTED_PIPELINE_STEPS) {
    throw new Error(
      `[parse-pipeline] Expected ${EXPECTED_PIPELINE_STEPS} pipeline steps, got ${steps.length}. ` +
        `If buildDefaultToolPolicyPipelineSteps was intentionally changed, update the expected count.`,
    );
  }

  console.log(`[parse-pipeline] Parsed ${steps.length} pipeline steps`);
  return { steps };
}
