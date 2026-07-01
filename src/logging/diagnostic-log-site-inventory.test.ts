// Diagnostic log inventory tests keep OTEL log-record coverage visible.
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const PRODUCTION_ROOTS = ["src", "extensions/diagnostics-otel"] as const;
const LOG_METHODS = new Set(["trace", "debug", "info", "warn", "error", "fatal", "raw"]);
const TEST_FILE_RE = /(?:\.test|\.spec|\.d)\.ts$/u;
const EXCLUDED_DIRS = new Set([".git", "dist", "build", "node_modules"]);

type KnownSubsystemLogCall = {
  file: string;
  line: number;
  method: string;
  subsystem: string;
  hasExplicitEvent: boolean;
};

type InjectedLoggerCall = {
  file: string;
  line: number;
  method: string;
  receiver: string;
  hasExplicitEvent: boolean;
};

function walkTsFiles(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTsFiles(entryPath, out);
      continue;
    }
    if (entry.isFile() && entryPath.endsWith(".ts") && !TEST_FILE_RE.test(entryPath)) {
      out.push(entryPath.replace(/\\/gu, "/"));
    }
  }
  return out;
}

function propName(name: ts.Node | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function stringLiteral(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function expressionName(expr: ts.Expression, source: ts.SourceFile): string | undefined {
  if (ts.isIdentifier(expr)) {
    return expr.text;
  }
  if (ts.isPropertyAccessExpression(expr)) {
    const base = expressionName(expr.expression, source) ?? expr.expression.getText(source);
    return `${base}.${expr.name.text}`;
  }
  if (ts.isElementAccessExpression(expr)) {
    const base = expressionName(expr.expression, source) ?? expr.expression.getText(source);
    return `${base}[]`;
  }
  return undefined;
}

function subsystemFromLoggerFactory(
  call: ts.CallExpression,
  bindings: Map<string, string>,
  source: ts.SourceFile,
): string | undefined {
  const expression = call.expression;
  if (ts.isIdentifier(expression) && expression.text === "createSubsystemLogger") {
    return stringLiteral(call.arguments[0]) ?? "<dynamic>";
  }
  if (ts.isIdentifier(expression) && expression.text === "getChildLogger") {
    const arg = call.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) {
      return "<getChildLogger-dynamic>";
    }
    let subsystem: string | undefined;
    let module: string | undefined;
    for (const property of arg.properties) {
      if (!ts.isPropertyAssignment(property)) {
        continue;
      }
      const key = propName(property.name);
      const value = stringLiteral(property.initializer) ?? "<dynamic>";
      if (key === "subsystem") {
        subsystem = value;
      } else if (key === "module") {
        module = value;
      }
    }
    return subsystem ?? (module ? `module:${module}` : "<getChildLogger>");
  }
  if (ts.isPropertyAccessExpression(expression) && expression.name.text === "child") {
    const parent = bindings.get(expressionName(expression.expression, source) ?? "");
    const child = stringLiteral(call.arguments[0]) ?? "<dynamic-child>";
    return parent ? `${parent}/${child}` : `<child-of:${expression.expression.getText(source)}>`;
  }
  return undefined;
}

function hasExplicitLogEvent(call: ts.CallExpression): boolean {
  for (const arg of call.arguments) {
    if (!ts.isObjectLiteralExpression(arg)) {
      continue;
    }
    for (const property of arg.properties) {
      if (ts.isPropertyAssignment(property) && propName(property.name) === "logEvent") {
        return true;
      }
    }
  }
  return false;
}

function isInjectedLoggerReceiver(receiver: string): boolean {
  return (
    receiver === "logger" ||
    receiver.endsWith(".logger") ||
    receiver.includes("logger") ||
    receiver.includes("Logger")
  );
}

function inventoryDiagnosticLogCalls(): {
  known: KnownSubsystemLogCall[];
  injected: InjectedLoggerCall[];
} {
  const known: KnownSubsystemLogCall[] = [];
  const injected: InjectedLoggerCall[] = [];

  for (const file of PRODUCTION_ROOTS.flatMap((root) => walkTsFiles(root))) {
    const sourceText = fs.readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
    const bindings = new Map<string, string>();

    function collectBindings(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const name = propName(node.name);
        if (name && ts.isCallExpression(node.initializer)) {
          const subsystem = subsystemFromLoggerFactory(node.initializer, bindings, source);
          if (subsystem) {
            bindings.set(name, subsystem);
          }
        }
      }
      ts.forEachChild(node, collectBindings);
    }

    function collectCalls(node: ts.Node): void {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text;
        if (LOG_METHODS.has(method)) {
          const receiver =
            expressionName(node.expression.expression, source) ??
            node.expression.expression.getText(source);
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          const explicit = hasExplicitLogEvent(node);
          const subsystem = bindings.get(receiver);
          if (subsystem) {
            known.push({ file, line, method, subsystem, hasExplicitEvent: explicit });
          } else if (isInjectedLoggerReceiver(receiver)) {
            injected.push({ file, line, method, receiver, hasExplicitEvent: explicit });
          }
        }
      }
      ts.forEachChild(node, collectCalls);
    }

    collectBindings(source);
    collectCalls(source);
  }

  return { known, injected };
}

describe("diagnostic OTEL log site inventory", () => {
  it("enumerates current production log-record surfaces", () => {
    const { known, injected } = inventoryDiagnosticLogCalls();
    const subsystems = new Set(known.map((entry) => entry.subsystem));
    const explicitEvents = known.filter((entry) => entry.hasExplicitEvent);

    expect(known.length).toBeGreaterThanOrEqual(600);
    expect(subsystems.size).toBeGreaterThanOrEqual(100);
    expect(injected.length).toBeGreaterThanOrEqual(200);
    expect(explicitEvents.length).toBeGreaterThanOrEqual(14);

    expect([...subsystems].sort()).toEqual(
      expect.arrayContaining([
        "agent/embedded",
        "agents/harness",
        "gateway",
        "gateway/heartbeat",
        "plugins",
        "sessions/store",
        "skills",
        "tasks/registry",
      ]),
    );
  });
});
