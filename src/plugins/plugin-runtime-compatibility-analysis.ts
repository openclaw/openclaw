import { builtinModules, createRequire } from "node:module";
import type { Binding, Scope } from "@babel/traverse";
import type * as t from "@babel/types";

const require = createRequire(import.meta.url);
const builtinModuleNames = new Set(builtinModules.map((name) => name.replace(/^node:/u, "")));

export type RuntimeCompatibilityRule =
  | "builtin-patch"
  | "host-patch"
  | "loader-patch"
  | "runtime-code-generation";

export type RuntimeCompatibilitySourceWarning = {
  ruleId: RuntimeCompatibilityRule;
  line: number;
  column: number;
  reference: string;
  message: string;
};

type Reference = { root: string; members: string[] };

const intrinsicObjects: Readonly<Record<string, object>> = {
  Array,
  ArrayBuffer,
  Atomics,
  BigInt,
  BigInt64Array,
  BigUint64Array,
  Boolean,
  Buffer,
  DataView,
  Date,
  Float32Array,
  Float64Array,
  Function,
  Int8Array,
  Int16Array,
  Int32Array,
  JSON,
  Map,
  Math,
  Number,
  Object,
  Promise,
  Proxy,
  Reflect,
  RegExp,
  Set,
  SharedArrayBuffer,
  String,
  Symbol,
  Uint8Array,
  Uint8ClampedArray,
  Uint16Array,
  Uint32Array,
  WeakMap,
  WeakSet,
  Blob,
  File,
  Headers,
  Request,
  Response,
  URL,
  URLSearchParams,
};
const closedPrototypes = new Set([
  "Object",
  "Promise",
  "RegExp",
  "Function",
  "Blob",
  "File",
  "Headers",
  "Request",
  "Response",
  "URL",
  "URLSearchParams",
]);
const hostRoots = new Set([
  "console",
  "process",
  "Error",
  "AggregateError",
  "TypeError",
  "RangeError",
  "SyntaxError",
]);
const globalFunctions = new Set([
  "fetch",
  "setTimeout",
  "setInterval",
  "setImmediate",
  "clearTimeout",
  "clearInterval",
  "clearImmediate",
  "queueMicrotask",
  "WebSocket",
  "AbortController",
  "AbortSignal",
  "FormData",
  "ReadableStream",
  "WritableStream",
  "TransformStream",
]);
const ambientNames = new Set([
  ...Object.keys(intrinsicObjects),
  ...hostRoots,
  ...globalFunctions,
  "Bun",
  "globalThis",
  "global",
  "eval",
]);
const wholeProcessState = new Set(["env", "argv", "execArgv", "title", "exitCode"]);
const runtimeCodeFunctions = new Set([
  "Script",
  "compileFunction",
  "runInContext",
  "runInNewContext",
  "runInThisContext",
  "SourceTextModule",
]);
// These built-in slots use the host-writer rule instead of unconditional immutability.
const hostDependentMembers = new Set([
  "Function.prototype.toString",
  "Math.random",
  "Math.sign",
  "Math.sinh",
  "Math.sumPrecise",
  "JSON.parse",
  "JSON.stringify",
  "Date.now",
  "Date.parse",
  "Date.prototype.toString",
  "Date.prototype.toLocaleString",
  "Date.prototype.toLocaleDateString",
  "Date.prototype.toLocaleTimeString",
  "Buffer.poolSize",
  "Number.parseFloat",
  "Number.parseInt",
  "Map.groupBy",
  "Promise.try",
  "RegExp.escape",
  "Uint8Array.fromBase64",
  "Uint8Array.fromHex",
  ...[
    "at",
    "trim",
    "trimStart",
    "trimEnd",
    "anchor",
    "big",
    "blink",
    "bold",
    "fixed",
    "fontcolor",
    "fontsize",
    "italics",
    "link",
    "small",
    "strike",
    "sub",
    "sup",
  ].map((name) => `String.prototype.${name}`),
  ...[
    "difference",
    "intersection",
    "isDisjointFrom",
    "isSubsetOf",
    "isSupersetOf",
    "symmetricDifference",
    "union",
  ].map((name) => `Set.prototype.${name}`),
]);

function memberName(node: t.MemberExpression | t.OptionalMemberExpression): string {
  return !node.computed && node.property.type === "Identifier"
    ? node.property.name
    : node.property.type === "StringLiteral" || node.property.type === "NumericLiteral"
      ? String(node.property.value)
      : "*";
}

function propertyName(node: t.Expression | t.PrivateName | t.Identifier): string {
  return node.type === "Identifier"
    ? node.name
    : node.type === "StringLiteral" || node.type === "NumericLiteral"
      ? String(node.value)
      : "*";
}

function append(reference: Reference | undefined, ...members: string[]): Reference | undefined {
  if (!reference) {
    return undefined;
  }
  const next = { root: reference.root, members: [...reference.members, ...members] };
  if (
    (next.root === "globalThis" || next.root === "global") &&
    ambientNames.has(next.members[0] ?? "")
  ) {
    return { root: next.members[0]!, members: next.members.slice(1) };
  }
  if (next.root === "node:buffer" && next.members[0] === "Buffer") {
    return { root: "Buffer", members: next.members.slice(1) };
  }
  return next;
}

function moduleReference(specifier: string): Reference | undefined {
  const name = specifier.replace(/^node:/u, "");
  if (name === "process") {
    return { root: "process", members: [] };
  }
  return builtinModuleNames.has(name) ? { root: `node:${name}`, members: [] } : undefined;
}

function isObject(value: unknown): value is object {
  return (typeof value === "object" && value !== null) || typeof value === "function";
}

function isRuntimeCodeConstructor(reference: Reference | undefined): boolean {
  return (
    reference !== undefined &&
    (reference.root === "Function" || reference.root === "eval") &&
    reference.members.every((member) => member === "call" || member === "apply")
  );
}

function canBeEvalSource(node: t.Node | null | undefined, scope: Scope): boolean {
  if (
    !node ||
    [
      "NumericLiteral",
      "BooleanLiteral",
      "NullLiteral",
      "BigIntLiteral",
      "RegExpLiteral",
      "ObjectExpression",
      "ArrayExpression",
      "FunctionExpression",
      "ArrowFunctionExpression",
      "ClassExpression",
    ].includes(node.type)
  ) {
    return false;
  }
  if (node.type === "Identifier" && node.name === "undefined" && !scope.getBinding("undefined")) {
    return false;
  }
  return node.type !== "UnaryExpression" || node.operator === "typeof";
}

function invokesRuntimeCode(
  reference: Reference,
  args: readonly (t.Node | null | undefined)[],
  scope: Scope,
): boolean {
  if (reference.root === "Function" || reference.members.length > 1) {
    return true;
  }
  if (reference.members[0] === "apply") {
    const values = args[1];
    return values?.type === "ArrayExpression"
      ? canBeEvalSource(values.elements[0], scope)
      : values != null && values.type !== "NullLiteral";
  }
  return canBeEvalSource(args[reference.members[0] === "call" ? 1 : 0], scope);
}

function isReservedPrototypeName(root: string, key: string): boolean {
  const primitive = ["String", "Number", "Boolean", "BigInt", "Symbol"].includes(root);
  return (
    (key === "then" && !primitive) ||
    (key === "toJSON" && !primitive && root !== "Map" && root !== "Set") ||
    (["next", "return", "throw"].includes(key) && !(root === "Date" && key === "next"))
  );
}

function mutationRule(
  reference: Reference,
  wholeObject: boolean,
): RuntimeCompatibilityRule | undefined {
  const label = [reference.root, ...reference.members].join(".");
  if (reference.root === "node:module") {
    return "loader-patch";
  }
  if (reference.root.startsWith("node:")) {
    return "host-patch";
  }
  if (
    (reference.root === "globalThis" || reference.root === "global") &&
    (wholeObject || reference.members.includes("*"))
  ) {
    return "host-patch";
  }
  if (reference.root === "process" && wholeProcessState.has(reference.members[0] ?? "")) {
    return undefined;
  }
  if (
    hostRoots.has(reference.root) ||
    globalFunctions.has(reference.root) ||
    hostDependentMembers.has(label)
  ) {
    return "host-patch";
  }
  const intrinsic = intrinsicObjects[reference.root];
  if (!intrinsic) {
    return undefined;
  }
  if (wholeObject || reference.members.length === 0) {
    return "builtin-patch";
  }
  if (reference.members.includes("*")) {
    return "host-patch";
  }
  let receiver: unknown = intrinsic;
  for (const member of reference.members.slice(0, -1)) {
    if (!isObject(receiver)) {
      return undefined;
    }
    receiver = Object.getOwnPropertyDescriptor(receiver, member)?.value;
  }
  if (!isObject(receiver)) {
    return undefined;
  }
  const key = reference.members.at(-1)!;
  return key in receiver ||
    (reference.members[0] === "prototype" &&
      (closedPrototypes.has(reference.root) ||
        isReservedPrototypeName(reference.root, key) ||
        /^\d+$/u.test(key)))
    ? "builtin-patch"
    : undefined;
}

const guidance: Record<RuntimeCompatibilityRule, string> = {
  "builtin-patch":
    "Changes a built-in member; use an owned wrapper or subclass. Compiled hosts can reject this write.",
  "host-patch":
    "Changes process-wide behavior; use api.logger, local wrappers, or documented provider and diagnostic hooks. Compiled-host support depends on the host's retained writers.",
  "loader-patch":
    "Changes module loading; compiled imports bypass runtime loader hooks. Use the supported plugin loader and SDK entrypoints.",
  "runtime-code-generation":
    "Generates code at runtime; prefer emitted JavaScript or a parser. Compiled hosts may interpret or disallow generated code.",
};

/** Inspect lexical receivers without evaluating the plugin or its dependencies. */
export function analyzePluginRuntimeCompatibility(
  source: string,
  filename: string,
): RuntimeCompatibilitySourceWarning[] {
  const { parse }: typeof import("@babel/parser") = require("@babel/parser");
  const { default: traverse }: typeof import("@babel/traverse") = require("@babel/traverse");
  const file = parse(source, {
    sourceType: "unambiguous",
    allowReturnOutsideFunction: true,
    allowUndeclaredExports: true,
    plugins: [
      "typescript",
      "decorators-legacy",
      ...(/\.[cm]?[jt]sx$/u.test(filename) ? ["jsx" as const] : []),
    ],
  });
  function reference(
    node: t.Node | null | undefined,
    scope: Scope,
    seen = new Set<Binding>(),
  ): Reference | undefined {
    if (!node) {
      return undefined;
    }
    if (node.type === "Identifier") {
      const binding = scope.getBinding(node.name);
      if (!binding) {
        if (node.name === "require") {
          return { root: "node:module", members: ["require"] };
        }
        if (node.name === "module") {
          return { root: "cjs:module", members: [] };
        }
        return ambientNames.has(node.name) ? { root: node.name, members: [] } : undefined;
      }
      if (!binding.constant || seen.has(binding)) {
        return undefined;
      }
      seen.add(binding);
      const declaration = binding.path.node;
      const parent = binding.path.parent;
      if (parent?.type === "ImportDeclaration") {
        const imported = moduleReference(parent.source.value);
        if (declaration.type === "ImportSpecifier") {
          return append(
            imported,
            declaration.imported.type === "Identifier"
              ? declaration.imported.name
              : declaration.imported.value,
          );
        }
        return imported;
      }
      if (declaration.type === "VariableDeclarator") {
        const initial = reference(declaration.init, binding.path.scope, seen);
        if (declaration.id.type === "Identifier") {
          return initial;
        }
        if (declaration.id.type === "ObjectPattern") {
          for (const property of declaration.id.properties) {
            if (
              property.type === "ObjectProperty" &&
              property.value.type === "Identifier" &&
              property.value.name === node.name
            ) {
              return append(initial, property.computed ? "*" : propertyName(property.key));
            }
          }
        }
      }
      return undefined;
    }
    if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      const owner = reference(node.object, scope, seen);
      const member = memberName(node);
      if (owner?.root === "cjs:module" && owner.members.length === 0 && member === "constructor") {
        return { root: "node:module", members: [] };
      }
      return append(owner, member);
    }
    if (
      node.type === "TSAsExpression" ||
      node.type === "TSTypeAssertion" ||
      node.type === "TSNonNullExpression" ||
      node.type === "ParenthesizedExpression"
    ) {
      return reference(node.expression, scope, seen);
    }
    if (node.type === "CallExpression" || node.type === "OptionalCallExpression") {
      const callee = reference(node.callee, scope, seen);
      if (callee?.root === "node:module" && callee.members[0] === "createRequire") {
        return { root: "node:module", members: ["require"] };
      }
      if (
        ((callee?.root === "node:module" && callee.members[0] === "require") ||
          (callee?.root === "cjs:module" && callee.members[0] === "require") ||
          (callee?.root === "process" && callee.members[0] === "getBuiltinModule")) &&
        node.arguments[0]?.type === "StringLiteral"
      ) {
        return moduleReference(node.arguments[0].value);
      }
    }
    return undefined;
  }

  const warnings: RuntimeCompatibilitySourceWarning[] = [];
  const found = new Set<string>();
  function record(
    node: t.Node,
    target: Reference | undefined,
    rule: RuntimeCompatibilityRule | undefined,
  ) {
    if (!target || !rule) {
      return;
    }
    const key = `${node.start}:${rule}`;
    if (found.has(key)) {
      return;
    }
    found.add(key);
    warnings.push({
      ruleId: rule,
      line: node.loc?.start.line ?? 1,
      column: (node.loc?.start.column ?? 0) + 1,
      reference: [target.root, ...target.members].join("."),
      message: guidance[rule],
    });
  }
  function mutation(node: t.Node, target: Reference | undefined, wholeObject = false) {
    record(node, target, target && mutationRule(target, wholeObject));
  }
  function inspectCall(
    node: t.CallExpression | t.OptionalCallExpression | t.NewExpression,
    scope: Scope,
  ) {
    const callee = reference(node.callee, scope);
    if (!callee) {
      return;
    }
    if (
      (isRuntimeCodeConstructor(callee) && invokesRuntimeCode(callee, node.arguments, scope)) ||
      (callee.root === "node:vm" && runtimeCodeFunctions.has(callee.members[0] ?? ""))
    ) {
      record(node, callee, "runtime-code-generation");
    }
    const method = callee.members[0];
    if (
      callee.root === "Reflect" &&
      callee.members.length === 1 &&
      (method === "apply" || method === "construct")
    ) {
      const target = reference(node.arguments[0], scope);
      const values = node.arguments[method === "apply" ? 2 : 1];
      if (
        target &&
        isRuntimeCodeConstructor(target) &&
        (target.root === "Function" ||
          values?.type !== "ArrayExpression" ||
          invokesRuntimeCode(target, values.elements, scope))
      ) {
        record(node, target, "runtime-code-generation");
      }
    }
    if (
      (callee.root === "node:module" && ["register", "registerHooks"].includes(method ?? "")) ||
      (callee.root === "Bun" && method === "plugin")
    ) {
      record(node, callee, "loader-patch");
    }
    if ((callee.root !== "Object" && callee.root !== "Reflect") || callee.members.length !== 1) {
      return;
    }
    const receiver = reference(node.arguments[0], scope);
    if (["defineProperty", "set", "deleteProperty"].includes(method ?? "")) {
      const key = node.arguments[1];
      mutation(
        node,
        append(
          receiver,
          key?.type === "StringLiteral" || key?.type === "NumericLiteral" ? String(key.value) : "*",
        ),
      );
    } else if (method === "defineProperties" || method === "assign") {
      const sources = method === "assign" ? node.arguments.slice(1) : node.arguments.slice(1, 2);
      for (const properties of sources) {
        if (properties?.type === "ObjectExpression") {
          for (const property of properties.properties) {
            if (property.type === "SpreadElement") {
              mutation(node, receiver, true);
            } else {
              mutation(
                node,
                append(receiver, property.computed ? "*" : propertyName(property.key)),
              );
            }
          }
        } else {
          mutation(node, receiver, true);
        }
      }
    } else if (method === "setPrototypeOf") {
      mutation(node, receiver, true);
    }
  }
  traverse(file, {
    AssignmentExpression: (nodePath) =>
      mutation(nodePath.node, reference(nodePath.node.left, nodePath.scope)),
    UpdateExpression: (nodePath) =>
      mutation(nodePath.node, reference(nodePath.node.argument, nodePath.scope)),
    UnaryExpression: (nodePath) => {
      if (nodePath.node.operator === "delete") {
        mutation(nodePath.node, reference(nodePath.node.argument, nodePath.scope));
      }
    },
    CallExpression: (nodePath) => inspectCall(nodePath.node, nodePath.scope),
    OptionalCallExpression: (nodePath) => inspectCall(nodePath.node, nodePath.scope),
    NewExpression: (nodePath) => inspectCall(nodePath.node, nodePath.scope),
  });
  return warnings.toSorted(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      left.ruleId.localeCompare(right.ruleId),
  );
}
