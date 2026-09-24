import { createRequire } from "node:module";
import { isAbsolute, win32 } from "node:path";
import type { Binding, NodePath } from "@babel/traverse";
import type * as t from "@babel/types";

const require = createRequire(import.meta.url);
type Origin =
  | "root"
  | "caller"
  | "factory"
  | "module"
  | "process"
  | "path"
  | "fs"
  | "fs-promises"
  | "builtin"
  | "join"
  | "resolve"
  | "realpath"
  | "realpath-async"
  | "cwd"
  | "chdir"
  | "location"
  | "input"
  | "caller-path"
  | "caller-string"
  | "literal"
  | "relative"
  | "scalar"
  | "unknown"
  | "unlocated";
const namespaces = new Map<string, Origin>([
  ["node:module", "module"],
  ["module", "module"],
  ["node:process", "process"],
  ["process", "process"],
  ["node:path", "path"],
  ["path", "path"],
  ["node:fs", "fs"],
  ["fs", "fs"],
  ["node:fs/promises", "fs-promises"],
  ["fs/promises", "fs-promises"],
]);
const members = new Map<Origin, ReadonlyMap<string, Origin>>([
  ["module", new Map([["createRequire", "factory"]])],
  [
    "process",
    new Map([
      ["getBuiltinModule", "builtin"],
      ["cwd", "cwd"],
      ["chdir", "chdir"],
    ]),
  ],
  [
    "path",
    new Map([
      ["join", "join"],
      ["resolve", "resolve"],
    ]),
  ],
  [
    "fs",
    new Map([
      ["realpathSync", "realpath"],
      ["promises", "fs-promises"],
    ]),
  ],
  ["fs-promises", new Map([["realpath", "realpath-async"]])],
]);
const ambient = new Map<string, Origin>([
  ["require", "root"],
  ["__filename", "location"],
  ["process", "process"],
]);
const loaders = new Set<Origin>(["root", "caller", "unlocated"]);
const snapshotsKinds = new Set<Origin>(["caller-path", "caller-string", "caller", "root"]);
const callerValues = new Set<Origin>(["input", "caller-path", "caller-string"]);
const pathValues = new Set<Origin>([...callerValues, "literal", "relative"]);
const readableValues = new Set<Origin>([
  ...pathValues,
  "module",
  "process",
  "path",
  "fs",
  "fs-promises",
  "scalar",
]);
const pureCalls = new Set<Origin>([
  "factory",
  "builtin",
  "join",
  "resolve",
  "realpath",
  "realpath-async",
  "cwd",
]);
function union(...values: Origin[][]): Origin[] {
  const result = [...new Set(values.flat())];
  return result.length ? result : ["unknown"];
}

type Declaration = {
  node: t.Node;
  name: t.Identifier;
  constant: boolean;
  inputScope?: t.Function;
};

/** Read dependency ownership without resolving or executing the inspected package. */
export function collectPackageRootImports(
  source: string,
  onImport?: (specifier: string, start: number, kind: "static" | "runtime") => void,
): string[] {
  const { parse }: typeof import("@babel/parser") = require("@babel/parser");
  // SAFETY: Babel 7 exposes its typed traversal API as the default CommonJS export.
  const { default: traverse } = require("@babel/traverse") as typeof import("@babel/traverse");
  const file = parse(source, {
    sourceType: "unambiguous",
    allowUndeclaredExports: true,
    allowReturnOutsideFunction: true,
    createImportExpressions: true,
  });
  const imports: string[] = [];
  const recordImport = (
    specifier: string,
    node: t.Node,
    kind: "static" | "runtime" = "runtime",
  ) => {
    imports.push(specifier);
    if (onImport) {
      if (node.start == null) {
        throw new Error("Parsed package import is missing its source position");
      }
      onImport(specifier, node.start, kind);
    }
  };
  const paths = new Map<t.Node, NodePath>();
  const calls: Array<t.CallExpression | t.OptionalCallExpression> = [];
  const scopes: Array<t.Program | t.Function> = [file.program];
  const declarations = new Map<Binding, Declaration[]>();
  const assignments: Array<[t.Identifier, t.Node | undefined]> = [];
  const cwdReferences: t.Node[] = [];
  // Only const primitive paths and bound Node loaders survive the entry prefix; raw inputs do not.
  const snapshots = new Map<Binding, Origin[]>();
  let changedCwd = false;

  function symbolAt(node: t.Identifier): Binding | undefined {
    return paths.get(node)?.scope.getBinding(node.name);
  }
  function literal(node: t.Node | null | undefined): string | undefined {
    return node?.type === "StringLiteral" ? node.value : undefined;
  }
  function property(node: t.Node): string | undefined {
    return node.type === "Identifier" ? node.name : literal(node);
  }
  function memberName(node: t.MemberExpression | t.OptionalMemberExpression) {
    return node.computed ? literal(node.property) : property(node.property);
  }
  function register(path: NodePath, constant: boolean, inputScope?: t.Function) {
    for (const name of Object.values(path.getBindingIdentifiers())) {
      const symbol = path.scope.getBinding(name.name);
      if (symbol) {
        const entries = declarations.get(symbol) ?? [];
        entries.push({ node: path.node, name, constant, inputScope });
        declarations.set(symbol, entries);
      }
    }
  }
  function recordWrite(node: t.Node, value?: t.Node) {
    switch (node.type) {
      case "Identifier":
        assignments.push([node, value]);
        break;
      case "AssignmentPattern":
        recordWrite(node.left);
        break;
      case "ObjectPattern":
        for (const entry of node.properties) {
          recordWrite(entry.type === "ObjectProperty" ? entry.value : entry.argument);
        }
        break;
      case "ArrayPattern":
        for (const entry of node.elements) {
          if (entry) {
            recordWrite(entry);
          }
        }
        break;
      case "RestElement":
        recordWrite(node.argument);
        break;
      default:
        // Member writes do not rebind their containing lexical variable.
        break;
    }
  }
  traverse(file, {
    enter(path) {
      paths.set(path.node, path);
    },
    ImportDeclaration(path) {
      recordImport(path.node.source.value, path.node, "static");
      for (const specifier of path.get("specifiers")) {
        register(specifier, true);
      }
    },
    ExportNamedDeclaration(path) {
      if (path.node.source) {
        recordImport(path.node.source.value, path.node, "static");
      }
    },
    ExportAllDeclaration(path) {
      recordImport(path.node.source.value, path.node, "static");
    },
    ImportExpression(path) {
      const specifier = literal(path.node.source);
      if (specifier !== undefined) {
        recordImport(specifier, path.node);
      }
    },
    "CallExpression|OptionalCallExpression"(path) {
      if (path.isCallExpression() || path.isOptionalCallExpression()) {
        calls.push(path.node);
      }
    },
    Function(path) {
      scopes.push(path.node);
      for (const parameter of path.get("params")) {
        register(parameter, false, path.node);
      }
    },
    VariableDeclarator(path) {
      register(path, path.parentPath.isVariableDeclaration({ kind: "const" }));
    },
    AssignmentExpression(path) {
      recordWrite(path.node.left, path.node.right);
    },
    "ForOfStatement|ForInStatement"(path) {
      if (path.isForOfStatement() || path.isForInStatement()) {
        if (path.node.left.type !== "VariableDeclaration") {
          recordWrite(path.node.left);
        }
      }
    },
    "MemberExpression|OptionalMemberExpression"(path) {
      if (path.isMemberExpression() || path.isOptionalMemberExpression()) {
        if (memberName(path.node) === "chdir") {
          cwdReferences.push(path.node);
        }
      }
    },
  });
  const writes = new Map<Binding, Array<t.Node | undefined>>();
  for (const [name, value] of assignments) {
    const symbol = symbolAt(name);
    if (symbol) {
      writes.set(symbol, [...(writes.get(symbol) ?? []), value]);
    }
  }
  function memberOrigins(owners: Origin[], name: string | undefined): Origin[] {
    return union(
      owners.map((owner) =>
        owner === "input"
          ? "input"
          : name === undefined
            ? "unknown"
            : (members.get(owner)?.get(name) ?? "unknown"),
      ),
    );
  }
  function origins(
    expression: t.Node,
    seen = new Set<Binding>(),
    inputScope?: t.Node,
    awaited = false,
  ): Origin[] {
    if (expression.type === "AwaitExpression") {
      return origins(expression.argument, seen, inputScope, true);
    }
    if (
      expression.type === "StringLiteral" ||
      (expression.type === "TemplateLiteral" && expression.expressions.length === 0)
    ) {
      const value =
        expression.type === "StringLiteral"
          ? expression.value
          : (expression.quasis[0]?.value.cooked ?? "");
      return [
        isAbsolute(value) || win32.isAbsolute(value) || URL.canParse(value)
          ? "literal"
          : "relative",
      ];
    }
    if (["NumericLiteral", "BooleanLiteral", "NullLiteral"].includes(expression.type)) {
      return ["literal"];
    }
    if (expression.type === "ConditionalExpression") {
      return union(
        origins(expression.consequent, new Set(seen), inputScope),
        origins(expression.alternate, new Set(seen), inputScope),
      );
    }
    if (expression.type === "SequenceExpression") {
      const result = expression.expressions.at(-1);
      return result ? origins(result, seen, inputScope) : ["unknown"];
    }
    if (
      expression.type === "BinaryExpression" ||
      expression.type === "LogicalExpression" ||
      expression.type === "AssignmentExpression"
    ) {
      if (expression.operator === "=") {
        return origins(expression.right, seen, inputScope);
      }
      const values = union(
        origins(expression.left, new Set(seen), inputScope),
        origins(expression.right, new Set(seen), inputScope),
      );
      if (["||", "&&", "??", "||=", "&&=", "??="].includes(expression.operator)) {
        return values;
      }
      if (
        expression.operator === "+" &&
        values.some((value) => callerValues.has(value)) &&
        values.every((value) => pathValues.has(value))
      ) {
        return ["caller-string"];
      }
      return ["scalar"];
    }
    if (expression.type === "Identifier") {
      const symbol = symbolAt(expression);
      if (!symbol) {
        return [ambient.get(expression.name) ?? "unknown"];
      }
      const snapshot = snapshots.get(symbol);
      if (snapshot) {
        return snapshot;
      }
      if (seen.has(symbol)) {
        return ["unknown"];
      }
      seen.add(symbol);
      const entries = declarations.get(symbol) ?? [];
      const entryParameter = inputScope && entries.some((entry) => entry.inputScope === inputScope);
      return union(
        ...entries.map((entry) => declarationOrigins(entry, new Set(seen), inputScope)),
        ...(entryParameter ? [] : (writes.get(symbol) ?? [])).map((value): Origin[] =>
          value ? origins(value, new Set(seen), inputScope) : ["unknown"],
        ),
      );
    }
    if (expression.type === "MemberExpression" || expression.type === "OptionalMemberExpression") {
      const name = memberName(expression);
      if (
        name === "url" &&
        expression.object.type === "MetaProperty" &&
        expression.object.meta.name === "import" &&
        expression.object.property.name === "meta"
      ) {
        return ["location"];
      }
      return memberOrigins(origins(expression.object, seen, inputScope), name);
    }
    if (expression.type === "ImportExpression") {
      return [namespaces.get(literal(expression.source) ?? "") ?? "unknown"];
    }
    if (expression.type === "CallExpression" || expression.type === "OptionalCallExpression") {
      const specifier = literal(expression.arguments[0]);
      const namespace = specifier === undefined ? undefined : namespaces.get(specifier);
      const locations = expression.arguments.map((value) =>
        origins(value, new Set(seen), inputScope),
      );
      return union(
        ...origins(expression.callee, new Set(seen), inputScope).map((loader): Origin[] => {
          if (loader === "factory") {
            return (locations[0] ?? ["unknown"]).map((location) =>
              location === "location"
                ? "root"
                : callerValues.has(location)
                  ? "caller"
                  : "unlocated",
            );
          }
          if (loaders.has(loader) || loader === "builtin") {
            return [namespace ?? "unknown"];
          }
          if (loader === "cwd") {
            return [inputScope && !changedCwd ? "caller-path" : "scalar"];
          }
          // Only the awaited default result is a string; the Promise itself is mutable.
          if (loader === "realpath-async" && !awaited) {
            return ["unknown"];
          }
          if (
            loader === "resolve" ||
            ((loader === "realpath" || loader === "realpath-async") &&
              expression.arguments.length === 1)
          ) {
            const values = loader === "resolve" ? locations.flat() : (locations[0] ?? ["unknown"]);
            return [
              !changedCwd &&
              values.every((value) =>
                ["input", "caller-path", "caller-string", "relative"].includes(value),
              ) &&
              (inputScope || values.includes("caller-path")) &&
              (inputScope || !values.includes("caller-string"))
                ? "caller-path"
                : "scalar",
            ];
          }
          if (loader === "join") {
            const values = locations.flat();
            if (
              values.every((value) => pathValues.has(value)) &&
              values.some((value) => callerValues.has(value))
            ) {
              return [
                locations[0]?.every((value) => value === "caller-path")
                  ? "caller-path"
                  : "caller-string",
              ];
            }
            return ["scalar"];
          }
          return ["unknown"];
        }),
      );
    }
    return ["unknown"];
  }
  function declarationOrigins(
    declaration: Declaration,
    seen: Set<Binding>,
    inputScope?: t.Node,
  ): Origin[] {
    const { node, name } = declaration;
    if (
      node.type === "ImportSpecifier" ||
      node.type === "ImportNamespaceSpecifier" ||
      node.type === "ImportDefaultSpecifier"
    ) {
      const owner = paths.get(node)?.parent;
      const namespace =
        owner?.type === "ImportDeclaration" ? namespaces.get(owner.source.value) : undefined;
      return namespace
        ? node.type === "ImportSpecifier"
          ? memberOrigins([namespace], property(node.imported))
          : [namespace]
        : ["unknown"];
    }
    if (node.type !== "VariableDeclarator" && !declaration.inputScope) {
      return ["unknown"];
    }
    const pattern = node.type === "VariableDeclarator" ? node.id : node;
    const initial =
      node.type === "VariableDeclarator"
        ? node.init
        : node.type === "AssignmentPattern"
          ? node.right
          : undefined;
    const incoming: Origin[] = declaration.inputScope
      ? // A nested function cannot recapture a mutable input belonging to an outer invocation.
        union(
          [inputScope === declaration.inputScope ? "input" : "unknown"],
          initial
            ? pattern.type === "AssignmentPattern" && pattern.left.type !== "Identifier"
              ? ["unknown"]
              : origins(initial, new Set(seen), inputScope)
            : [],
        )
      : initial
        ? origins(initial, new Set(seen), inputScope)
        : ["unknown"];
    if (pattern === name || (pattern.type === "AssignmentPattern" && pattern.left === name)) {
      return union(incoming, !declaration.inputScope && !declaration.constant ? ["unknown"] : []);
    }
    const defaults: Origin[][] = [];
    let child: t.Node = name;
    let parent = paths.get(child)?.parent;
    let directMember: string | undefined;
    while (parent && child !== pattern) {
      if (parent.type === "AssignmentPattern") {
        defaults.push(
          parent.left === name ? origins(parent.right, new Set(seen), inputScope) : ["unknown"],
        );
      }
      if (
        parent.type === "ObjectProperty" &&
        paths.get(parent)?.parent === pattern &&
        (parent.value === name ||
          (parent.value.type === "AssignmentPattern" && parent.value.left === name))
      ) {
        directMember = parent.computed ? literal(parent.key) : property(parent.key);
      }
      child = parent;
      parent = paths.get(child)?.parent;
    }
    return union(
      declaration.inputScope
        ? incoming
        : directMember === undefined
          ? ["unknown"]
          : memberOrigins(incoming, directMember),
      ...defaults,
      !declaration.inputScope && !declaration.constant ? ["unknown"] : [],
    );
  }
  function pure(node: t.Node, scope: t.Node): boolean {
    // Admission is closed: coercion, iteration, defaults and unknown syntax may execute caller code.
    if (node.type === "Identifier") {
      return Boolean(symbolAt(node)) || ambient.has(node.name) || node.name === "undefined";
    }
    if (
      ["StringLiteral", "NumericLiteral", "BooleanLiteral", "NullLiteral"].includes(node.type) ||
      (node.type === "TemplateLiteral" && node.expressions.length === 0)
    ) {
      return true;
    }
    if (node.type === "LogicalExpression") {
      return pure(node.left, scope) && pure(node.right, scope);
    }
    if (node.type === "ConditionalExpression") {
      return pure(node.test, scope) && pure(node.consequent, scope) && pure(node.alternate, scope);
    }
    if (node.type === "AwaitExpression") {
      const value = node.argument;
      if (value.type === "ImportExpression") {
        return namespaces.has(literal(value.source) ?? "") && pure(value, scope);
      }
      if (value.type !== "CallExpression" && value.type !== "OptionalCallExpression") {
        return false;
      }
      return (
        origins(value.callee, new Set(), scope).every((origin) => origin === "realpath-async") &&
        pure(value, scope)
      );
    }
    if (node.type === "MemberExpression" || node.type === "OptionalMemberExpression") {
      if (origins(node, new Set(), scope).includes("location")) {
        return true;
      }
      return (
        origins(node.object, new Set(), scope).every((value) => readableValues.has(value)) &&
        pure(node.object, scope) &&
        (!node.computed || literal(node.property) !== undefined)
      );
    }
    if (node.type === "ImportExpression") {
      return !node.options && namespaces.has(literal(node.source) ?? "");
    }
    if (node.type !== "CallExpression" && node.type !== "OptionalCallExpression") {
      return false;
    }
    const builtinCall =
      namespaces.has(literal(node.arguments[0]) ?? "") && node.arguments.length === 1;
    return (
      origins(node.callee, new Set(), scope).every(
        (value) =>
          (pureCalls.has(value) &&
            (value === "join" ||
              value === "resolve" ||
              node.arguments.length === (value === "cwd" ? 0 : 1))) ||
          (loaders.has(value) && builtinCall),
      ) &&
      pure(node.callee, scope) &&
      node.arguments.every((argument) => pure(argument, scope))
    );
  }
  changedCwd =
    cwdReferences.some((reference) => origins(reference).includes("chdir")) ||
    [...declarations.values()].some((entries) =>
      entries.some((entry) => declarationOrigins(entry, new Set()).includes("chdir")),
    );
  // Effects or control flow end admission; later loaders may still use captured immutable paths.
  for (const scope of scopes.toSorted((a, b) => (a.start ?? 0) - (b.start ?? 0))) {
    const body = scope.type === "Program" ? scope : scope.body;
    if (body.type !== "Program" && body.type !== "BlockStatement") {
      continue;
    }
    if (
      scope.type !== "Program" &&
      scope.params.some((parameter) => parameter.type !== "Identifier")
    ) {
      continue;
    }
    prefix: for (const entry of body.body) {
      const statement =
        entry.type === "ExportNamedDeclaration" || entry.type === "ExportDefaultDeclaration"
          ? entry.declaration
          : entry;
      if (
        !statement ||
        statement.type === "ImportDeclaration" ||
        statement.type === "ExportAllDeclaration" ||
        statement.type === "FunctionDeclaration" ||
        statement.type === "EmptyStatement" ||
        (statement.type === "ExpressionStatement" && statement.expression.type === "StringLiteral")
      ) {
        continue;
      }
      if (statement.type !== "VariableDeclaration" || statement.kind !== "const") {
        break;
      }
      for (const declaration of statement.declarations) {
        if (
          declaration.id.type !== "Identifier" ||
          !declaration.init ||
          !pure(declaration.init, scope)
        ) {
          break prefix;
        }
        const values = origins(declaration.init, new Set(), scope);
        if (
          !values.every(
            (value) =>
              snapshotsKinds.has(value) ||
              ["literal", "relative", ...namespaces.values(), ...pureCalls].includes(value),
          )
        ) {
          break prefix;
        }
        const symbol = symbolAt(declaration.id);
        if (symbol && values.every((value) => snapshotsKinds.has(value))) {
          snapshots.set(symbol, values);
        }
      }
    }
  }
  for (const node of calls) {
    const specifier = literal(node.arguments[0]);
    if (node.arguments.length !== 1 || specifier === undefined) {
      continue;
    }
    const values = origins(node.callee);
    // Unproven literal require calls retain the original conservative manifest check.
    if (
      values.includes("root") ||
      (node.callee.type === "Identifier" &&
        node.callee.name === "require" &&
        !values.every((value) => value === "caller"))
    ) {
      recordImport(specifier, node);
    }
  }
  return imports;
}
