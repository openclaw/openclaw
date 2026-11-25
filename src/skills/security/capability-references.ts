import { createRequire } from "node:module";
import type { Binding, NodePath, Scope, Visitor } from "@babel/traverse";
import type * as t from "@babel/types";
import { markdownToIRWithMeta } from "../../../packages/markdown-core/src/ir.js";

const require = createRequire(import.meta.url);
const PROCESS_METHODS = new Set([
  "exec",
  "execSync",
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
]);
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "window"]);
const CODE_FUNCTIONS = new Set(["eval", "Function"]);
type ObjectValue = Map<string, Value | undefined>;
type Value = "process-module" | "global-object" | "process-call" | "code-call" | ObjectValue;
type State = {
  bindings: Map<Binding | string, Value | undefined>;
  properties: Map<ObjectValue, Map<string, Value | undefined>>;
  parent?: State;
};

type CallMatches = Map<string, Map<number, Set<number>>>;

// Only literal strings and literal array lookups are evaluated, never inspected code.
function staticString(node: t.Node | null | undefined): string | undefined {
  if (node?.type === "StringLiteral") {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined;
  }
  if (
    node?.type === "MemberExpression" &&
    node.computed &&
    node.object.type === "ArrayExpression" &&
    node.property.type === "NumericLiteral"
  ) {
    const element = node.object.elements[node.property.value];
    return element?.type === "StringLiteral" ? element.value : undefined;
  }
  return undefined;
}

function propertyName(
  node: t.ObjectProperty | t.ObjectMethod | t.MemberExpression | t.OptionalMemberExpression,
): string | undefined {
  const key =
    node.type === "ObjectProperty" || node.type === "ObjectMethod" ? node.key : node.property;
  return !node.computed && key.type === "Identifier" ? key.name : staticString(key);
}

function isProcessModule(name: string | undefined): boolean {
  return name === "child_process" || name === "node:child_process";
}

/**
 * Bounded, source-order capability analysis using lexical bindings and object identity.
 * Functions are inspected after outer initialization; their writes do not execute in the enclosing scope.
 * This does not interpret branches/loops, call arguments/returns, arbitrary computed values,
 * call/apply/bind, prototypes, or cross-file flows. Unparseable fragments retain literal rules.
 */
export function collectCapabilityCalls(source: string, filePath: string): CallMatches {
  const matches: CallMatches = new Map();
  if (!/child_process|\b(?:eval|Function)\b/.test(source)) {
    return matches;
  }
  const { parse }: typeof import("@babel/parser") = require("@babel/parser");
  const { default: traverse }: typeof import("@babel/traverse") = require("@babel/traverse");

  function analyze(
    code: string,
    startLine: number,
    startIndex: number,
    columnOffsets?: readonly number[],
  ): boolean {
    let file: t.File | undefined;
    // Angle assertions are valid TypeScript but ambiguous with JSX. Accept either syntax.
    for (const jsx of [false, true]) {
      try {
        file = parse(code, {
          sourceType: "unambiguous",
          plugins: jsx ? ["typescript", "jsx"] : ["typescript"],
          allowReturnOutsideFunction: true,
          allowUndeclaredExports: true,
          createImportExpressions: true,
          startLine,
          startIndex,
          startColumn: 0,
        });
        break;
      } catch (error) {
        if (!(error instanceof SyntaxError) && !(error instanceof RangeError)) {
          throw error;
        }
      }
    }
    if (!file) {
      return false;
    }
    let state: State = { bindings: new Map(), properties: new Map() };
    const objects = new WeakMap<t.ObjectExpression, ObjectValue>();
    const functions: Array<{ path: NodePath<t.Function>; parent: State }> = [];

    function readBinding(key: Binding | string): Value | undefined {
      for (let current: State | undefined = state; current; current = current.parent) {
        if (current.bindings.has(key)) {
          return current.bindings.get(key);
        }
      }
      if (typeof key === "string") {
        if (CODE_FUNCTIONS.has(key)) {
          return "code-call";
        }
        if (GLOBAL_OBJECTS.has(key)) {
          return "global-object";
        }
      }
      return undefined;
    }
    function readProperty(object: Value | undefined, name: string | undefined): Value | undefined {
      if (name === undefined) {
        return undefined;
      }
      if (object === "process-module") {
        return PROCESS_METHODS.has(name) ? "process-call" : undefined;
      }
      if (object === "global-object") {
        return CODE_FUNCTIONS.has(name) ? readBinding(name) : undefined;
      }
      if (!(object instanceof Map)) {
        return undefined;
      }
      for (let current: State | undefined = state; current; current = current.parent) {
        const properties = current.properties.get(object);
        if (properties?.has(name)) {
          return properties.get(name);
        }
      }
      return object.get(name);
    }
    function value(node: t.Node | null | undefined, scope: Scope, depth = 0): Value | undefined {
      if (!node || depth > 32) {
        return undefined;
      }
      switch (node.type) {
        case "Identifier":
          return readBinding(scope.getBinding(node.name) ?? node.name);
        case "AwaitExpression":
          if (node.argument.type === "ImportExpression") {
            return isProcessModule(staticString(node.argument.source))
              ? "process-module"
              : undefined;
          }
          return value(node.argument, scope, depth + 1);
        case "TSAsExpression":
        case "TSTypeAssertion":
        case "TSNonNullExpression":
        case "ParenthesizedExpression":
          return value(node.expression, scope, depth + 1);
        case "SequenceExpression":
          return value(node.expressions.at(-1), scope, depth + 1);
        case "MemberExpression":
        case "OptionalMemberExpression":
          return readProperty(value(node.object, scope, depth + 1), propertyName(node));
        case "CallExpression":
          return node.callee.type === "Identifier" &&
            node.callee.name === "require" &&
            !scope.getBinding("require") &&
            isProcessModule(staticString(node.arguments[0]))
            ? "process-module"
            : undefined;
        case "ObjectExpression":
          return objects.get(node);
        default:
          return undefined;
      }
    }
    function assign(node: t.Node, next: Value | undefined, scope: Scope): void {
      if (node.type === "Identifier") {
        state.bindings.set(scope.getBinding(node.name) ?? node.name, next);
      } else if (node.type === "ObjectPattern") {
        for (const entry of node.properties) {
          if (entry.type === "ObjectProperty") {
            assign(entry.value, readProperty(next, propertyName(entry)), scope);
          }
        }
      } else if (node.type === "AssignmentPattern") {
        assign(node.left, next ?? value(node.right, scope), scope);
      } else if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
        const object = value(node.object, scope);
        const name = propertyName(node);
        if (object instanceof Map && name !== undefined) {
          let properties = state.properties.get(object);
          if (!properties) {
            state.properties.set(object, (properties = new Map()));
          }
          properties.set(name, next);
        }
      }
    }
    const visitor: Visitor = {
      Function(path) {
        functions.push({ path, parent: state });
        path.skip();
      },
      Program(path) {
        // ESM bindings exist before module evaluation, even when imports follow calls.
        for (const declaration of path.node.body) {
          if (declaration.type !== "ImportDeclaration") {
            continue;
          }
          if (!isProcessModule(declaration.source.value) || declaration.importKind === "type") {
            continue;
          }
          for (const specifier of declaration.specifiers) {
            const imported =
              specifier.type === "ImportSpecifier"
                ? specifier.imported.type === "Identifier"
                  ? specifier.imported.name
                  : specifier.imported.value
                : undefined;
            assign(
              specifier.local,
              specifier.type === "ImportSpecifier"
                ? specifier.importKind !== "type" && imported && PROCESS_METHODS.has(imported)
                  ? "process-call"
                  : undefined
                : "process-module",
              path.scope,
            );
          }
        }
      },
      TSImportEqualsDeclaration(path) {
        const reference = path.node.moduleReference;
        if (
          reference.type === "TSExternalModuleReference" &&
          isProcessModule(staticString(reference.expression))
        ) {
          assign(path.node.id, "process-module", path.scope);
        }
      },
      ObjectExpression: {
        exit(path) {
          const object: ObjectValue = new Map();
          for (const entry of path.node.properties) {
            if (entry.type === "SpreadElement") {
              const spread = value(entry.argument, path.scope);
              if (spread instanceof Map) {
                const keys = new Set(spread.keys());
                for (let current: State | undefined = state; current; current = current.parent) {
                  for (const key of current.properties.get(spread)?.keys() ?? []) {
                    keys.add(key);
                  }
                }
                for (const key of keys) {
                  object.set(key, readProperty(spread, key));
                }
              } else if (spread === "process-module") {
                for (const key of PROCESS_METHODS) {
                  object.set(key, "process-call");
                }
              } else if (
                !["NullLiteral", "NumericLiteral", "BooleanLiteral", "StringLiteral"].includes(
                  entry.argument.type,
                )
              ) {
                // An unknown spread can overwrite any earlier property; its provenance is unknown.
                object.clear();
              }
              continue;
            }
            if (entry.type === "ObjectProperty" || entry.type === "ObjectMethod") {
              const name = propertyName(entry);
              if (name !== undefined) {
                object.set(
                  name,
                  entry.type === "ObjectProperty" ? value(entry.value, path.scope) : undefined,
                );
              }
            }
          }
          objects.set(path.node, object);
        },
      },
      VariableDeclarator: {
        exit(path) {
          if (!path.node.init && path.parentPath.isVariableDeclaration({ kind: "var" })) {
            return;
          }
          assign(path.node.id, value(path.node.init, path.scope), path.scope);
        },
      },
      AssignmentExpression: {
        exit(path) {
          assign(
            path.node.left,
            path.node.operator === "=" ? value(path.node.right, path.scope) : undefined,
            path.scope,
          );
        },
      },
      "CallExpression|OptionalCallExpression|NewExpression": {
        exit(path) {
          if (
            !path.isCallExpression() &&
            !path.isOptionalCallExpression() &&
            !path.isNewExpression()
          ) {
            return;
          }
          const capability = value(path.node.callee, path.scope);
          if (capability !== "process-call" && capability !== "code-call") {
            return;
          }
          const callee = path.node.callee;
          const location = path.isNewExpression()
            ? path.node.loc?.start
            : (callee.type === "MemberExpression" || callee.type === "OptionalMemberExpression"
                ? callee.property
                : callee
              ).loc?.start;
          if (!location) {
            return;
          }
          const rule = capability === "process-call" ? "dangerous-exec" : "dynamic-code-execution";
          let lines = matches.get(rule);
          if (!lines) {
            matches.set(rule, (lines = new Map()));
          }
          let columns = lines.get(location.line);
          if (!columns) {
            lines.set(location.line, (columns = new Set()));
          }
          columns.add(location.column + (columnOffsets?.[location.line - startLine] ?? 0));
        },
      },
    };
    traverse(file, visitor);
    // Closures can be declared before their captured bindings are initialized. Inspect each
    // body once after its containing scope, without executing its writes in that scope.
    for (const job of functions) {
      state = { bindings: new Map(), properties: new Map(), parent: job.parent };
      job.path.traverse(visitor);
    }
    return true;
  }

  const markdown = /\.(?:md|markdown|mdx)$/i.test(filePath);
  if (!markdown && analyze(source, 1, 0)) {
    return matches;
  }
  // Parse the Markdown owner's decoded code, with original line/column mappings. Container
  // prefixes and code indentation are Markdown syntax, not part of the inspected program.
  const lines = source.split("\n");
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const { ir } = markdownToIRWithMeta(source);
  let hasCodeBlocks = false;
  for (const block of ir.blocks ?? []) {
    if (
      block.kind !== "code_block" ||
      block.sourceStartLine === undefined ||
      block.sourceEndLine === undefined
    ) {
      continue;
    }
    hasCodeBlocks = true;
    const start = block.sourceStartLine + (block.codeOrigin === "fenced" ? 1 : 0);
    const code = ir.text.slice(block.start, block.end);
    const columns = code.split("\n").map((line, index) => {
      const content = line.trimStart();
      const rawColumn = (lines[start + index] ?? "").lastIndexOf(content);
      return content && rawColumn >= 0 ? rawColumn - (line.length - content.length) : 0;
    });
    analyze(code, start + 1, starts[start] ?? source.length, columns);
  }
  if (markdown && !hasCodeBlocks) {
    analyze(source, 1, 0);
  }
  return matches;
}
