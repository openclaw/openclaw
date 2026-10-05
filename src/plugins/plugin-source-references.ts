import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { NodePath } from "@babel/traverse";
import type {
  CallExpression,
  ExportAllDeclaration,
  ExportNamedDeclaration,
  ImportDeclaration,
  Node,
  Program as BabelProgram,
} from "@babel/types";
import { parse, type AnyNode, type Program } from "acorn";
import { moduleResolve } from "import-meta-resolve";
import type { createJiti } from "jiti";

export function capturedPluginModuleUrl(
  filename: string,
  specifier: string,
  conditions: readonly string[],
): URL {
  const url = pathToFileURL(filename);
  if (
    !conditions.includes("require") &&
    (specifier.startsWith(".") || specifier.startsWith("file:") || path.isAbsolute(specifier))
  ) {
    // URL suffixes distinguish ESM instances without changing the captured file bytes.
    const requested = new URL(specifier, url);
    url.search = requested.search;
    url.hash = requested.hash;
  }
  return url;
}

function isPackageMapError(error: unknown, code: string): error is Error & { url?: unknown } {
  return error instanceof Error && "code" in error && error.code === code;
}

/** Package metadata selects a target before its deferred body has been captured. */
export function resolvePluginPackageMapTarget(
  specifier: string,
  importer: string,
  conditions: readonly string[],
): URL | undefined {
  let selected: URL;
  try {
    selected = moduleResolve(specifier, pathToFileURL(importer), new Set(conditions));
  } catch (error) {
    // Bun owns its built-in target exception and validation of other URL-shaped targets.
    if (conditions.includes("bun") && isPackageMapError(error, "ERR_INVALID_PACKAGE_TARGET")) {
      return undefined;
    }
    if (!isPackageMapError(error, "ERR_MODULE_NOT_FOUND")) {
      throw error;
    }
    if (typeof error.url !== "string") {
      return undefined;
    }
    // Node chose this target from immutable metadata; only its body is still uncaptured.
    selected = new URL(error.url);
  }
  return selected.protocol === "file:" ? selected : undefined;
}

/** Missing physical inputs stay absent without poisoning another condition's selected target. */
export function createPluginPackageMapReferences() {
  const missingTargets = new Set<string>();
  const recordMissingTarget = (filename: string) => {
    missingTargets.add(path.resolve(filename));
  };
  return {
    recordMissingTarget,
    hasMissingTarget: (filename: string) => missingTargets.has(path.resolve(filename)),
    resolveReference(specifier: string, importer: string, conditions: readonly string[]) {
      try {
        return moduleResolve(specifier, pathToFileURL(importer), new Set(conditions)).href;
      } catch (error) {
        if (isPackageMapError(error, "ERR_MODULE_NOT_FOUND") && typeof error.url === "string") {
          const target = new URL(error.url);
          if (target.protocol === "file:") {
            recordMissingTarget(fileURLToPath(target));
          }
        }
        // Optional invalid metadata is reported only when its branch is executed.
        return undefined;
      }
    },
  };
}

type StaticStringNode = {
  type: string;
  value?: unknown;
  expressions?: readonly unknown[];
  quasis?: readonly { value: { cooked?: string | null } }[];
};

function staticString(node: StaticStringNode | null | undefined): string | undefined {
  if (
    (node?.type === "Literal" || node?.type === "StringLiteral") &&
    typeof node.value === "string"
  ) {
    return node.value;
  }
  if (node?.type === "TemplateLiteral" && node.expressions?.length === 0) {
    return node.quasis?.[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** Whether this expression receives a value, directly or through a destructuring pattern. */
function isAssignmentTarget(target: NodePath): boolean {
  let child = target;
  for (let parent = target.parentPath; parent?.node; parent = parent.parentPath) {
    switch (parent.node.type) {
      case "AssignmentExpression":
      case "AssignmentPattern":
      case "ForInStatement":
      case "ForOfStatement":
        return child.key === "left";
      case "UpdateExpression":
        return true;
      case "ObjectProperty":
        if (child.key !== "value") {
          return false;
        }
        break;
      case "ArrayPattern":
      case "ObjectPattern":
      case "RestElement":
        break;
      default:
        return false;
    }
    child = parent;
  }
  return false;
}

function unwrapReferenceArgument(input: NodePath | undefined) {
  let argument = input;
  // TypeScript erases these wrappers without evaluating another value.
  while (
    argument?.isTSAsExpression() ||
    argument?.isTSTypeAssertion() ||
    argument?.isTSNonNullExpression() ||
    argument?.isTSSatisfiesExpression() ||
    argument?.isTSInstantiationExpression()
  ) {
    argument = argument.get("expression");
  }
  return argument;
}

/** Inspect authored TypeScript syntax before Jiti rewrites module operations. */
export function inspectPluginTypeScriptExecutionFacts(
  source: string,
  sourceText: string,
  resolver: ReturnType<typeof createJiti>,
): {
  hasComputedImport: boolean;
  staticImports: Array<{ specifier: string; sideEffect: boolean }>;
} {
  let hasComputedImport = false;
  const staticImports = new Map<string, boolean>();
  const recordStaticImport = (specifier: string, sideEffect: boolean) => {
    staticImports.set(specifier, (staticImports.get(specifier) ?? false) || sideEffect);
  };
  resolver.transform({
    source: sourceText,
    filename: source,
    ts: true,
    async: true,
    babel: {
      plugins: [
        {
          pre(file: { path: NodePath<BabelProgram> }) {
            file.path.traverse({
              "ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration"(
                declaration: NodePath<
                  ImportDeclaration | ExportNamedDeclaration | ExportAllDeclaration
                >,
              ) {
                const specifier = staticString(declaration.node.source);
                if (specifier !== undefined) {
                  recordStaticImport(
                    specifier,
                    declaration.isImportDeclaration() && declaration.node.specifiers.length === 0,
                  );
                }
              },
              ImportExpression(expression) {
                if (staticString(expression.get("source").node) === undefined) {
                  hasComputedImport = true;
                }
              },
              CallExpression(call) {
                const args = call.get("arguments");
                if (
                  call.get("callee").node?.type === "Import" &&
                  staticString(unwrapReferenceArgument(args[0])?.node) === undefined
                ) {
                  hasComputedImport = true;
                }
              },
            });
          },
        },
      ],
    },
  });
  return {
    hasComputedImport,
    staticImports: [...staticImports].map(([specifier, sideEffect]) => ({
      specifier,
      sideEffect,
    })),
  };
}

/** Read the native factory binding before Jiti rewrites modules and import.meta. */
function isCurrentFileRequire(call: NodePath<CallExpression>): boolean {
  const callee = call.get("callee");
  const reference =
    callee.isMemberExpression() &&
    !callee.node.computed &&
    callee.get("property").isIdentifier({ name: "resolve" })
      ? callee.get("object")
      : callee;
  let init: NodePath<Node | null> = reference;
  if (reference.isIdentifier() && reference.node.name) {
    const binding = reference.scope.getBinding(reference.node.name);
    if (!binding?.constant || !binding.path.isVariableDeclarator()) {
      return false;
    }
    init = binding.path.get("init");
  }
  if (!init.isCallExpression()) {
    return false;
  }
  const args = init.get("arguments");
  const anchor = args.length === 1 ? args[0] : undefined;
  if (
    !anchor ||
    !(
      (anchor.isMemberExpression() &&
        !anchor.node.computed &&
        anchor.get("object").node?.type === "MetaProperty" &&
        anchor.matchesPattern("import.meta.url")) ||
      (anchor.node?.type === "Identifier" &&
        anchor.node.name === "__filename" &&
        !anchor.scope.getBinding("__filename"))
    )
  ) {
    return false;
  }
  const factory = init.get("callee");
  return ["module", "node:module"].some(
    (source) =>
      factory.referencesImport(source, "createRequire") ||
      (factory.isMemberExpression() &&
        !factory.node.computed &&
        factory.get("property").isIdentifier({ name: "createRequire" }) &&
        factory.get("object").referencesImport(source, "default")),
  );
}

// These imports and native anchors need Jiti's binding-aware prepass or rewritten callee names.
const TRANSFORMED_REFERENCE_NAMES = new Set([
  "createRequire",
  "URL",
  "readFile",
  "readFileSync",
  "createReadStream",
  "join",
  "resolve",
  "require",
  "jitiImport",
  "jitiESMResolve",
  "__dirname",
]);

function* sourceChildren(node: AnyNode): Generator<AnyNode> {
  for (const value of Object.values(node)) {
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === "object" && "type" in child) {
        // SAFETY: Child fields and arrays come from the same Acorn tree.
        yield child as AnyNode;
      }
    }
  }
}

function parseNativePluginJavaScript(source: string, sourceText: string): Program | undefined {
  if (!/\.[cm]?js$/.test(source)) {
    return undefined;
  }
  let tree: Program;
  try {
    tree = parse(sourceText, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowAwaitOutsideFunction: true,
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return undefined;
    }
    throw error;
  }
  const needsTransform = (node: AnyNode, exportedDeclaration = false): boolean => {
    if (node.type === "MetaProperty") {
      return true;
    }
    // Jiti moves declarations around resource disposal blocks, changing reference order.
    if (
      node.type === "VariableDeclaration" &&
      (node.kind === "using" || node.kind === "await using")
    ) {
      return true;
    }
    // Jiti moves module-binding loop assignments into the body or removes their targets.
    if (
      (node.type === "ForInStatement" || node.type === "ForOfStatement") &&
      node.left.type !== "VariableDeclaration"
    ) {
      return true;
    }
    // Jiti rejects reserved exports before visiting references, including declaration bindings.
    const exported =
      node.type === "ExportSpecifier" || node.type === "ExportAllDeclaration"
        ? node.exported
        : undefined;
    if (
      (exported?.type === "Identifier" ? exported.name : staticString(exported)) === "__esModule" ||
      (exportedDeclaration && node.type === "Identifier" && node.name === "__esModule")
    ) {
      return true;
    }
    // Jiti renames local require/__dirname bindings before the reference visitor runs.
    if (node.type === "Identifier" && (node.name === "require" || node.name === "__dirname")) {
      return true;
    }
    if (
      node.type === "ImportExpression" &&
      (node.source.type !== "Literal" ||
        typeof node.source.value !== "string" ||
        node.options != null)
    ) {
      return true;
    }
    if (node.type === "ImportDeclaration") {
      if (node.source.value === "module" || node.source.value === "node:module") {
        return true;
      }
      for (const specifier of node.specifiers) {
        const imported =
          specifier.type === "ImportSpecifier"
            ? specifier.imported.type === "Identifier"
              ? specifier.imported.name
              : staticString(specifier.imported)
            : undefined;
        if (
          TRANSFORMED_REFERENCE_NAMES.has(specifier.local.name) ||
          (imported !== undefined && TRANSFORMED_REFERENCE_NAMES.has(imported))
        ) {
          return true;
        }
      }
    }
    for (const child of sourceChildren(node)) {
      if (
        needsTransform(
          child,
          exportedDeclaration ||
            (node.type === "ExportNamedDeclaration" && child === node.declaration),
        )
      ) {
        return true;
      }
    }
    return false;
  };
  return needsTransform(tree) ? undefined : tree;
}

function parseTransformedPluginSource(source: string, code: string): Program {
  try {
    return parse(code, {
      ecmaVersion: "latest",
      // Jiti can retain import.meta in its mixed ESM/CommonJS inspection output.
      allowImportExportEverywhere: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    // Name the blocking file; positions refer to the Jiti output, not the authored source.
    throw new SyntaxError(`${source}: could not parse transformed source: ${error.message}`, {
      cause: error,
    });
  }
}

/** Visit literal module and explicit asset inputs without evaluating plugin code. */
export function visitPluginSourceReferences(
  source: string,
  sourceText: string,
  resolver: ReturnType<typeof createJiti>,
  visitReference: (reference: string, kind: "asset" | "import" | "require") => void,
): ReadonlySet<string> {
  const authoredStaticImports = new Set<string>();
  const visitDirectoryAsset = (name: string, parts: readonly (string | undefined)[]) => {
    if (
      (name === "join" || name === "resolve") &&
      parts.length > 0 &&
      parts.every((part) => part !== undefined) &&
      // Absolute resolve segments discard the source directory.
      (name === "join" || !parts.some((part) => path.isAbsolute(part)))
    ) {
      visitReference(path.join(".", ...parts), "asset");
    }
  };
  const tree =
    parseNativePluginJavaScript(source, sourceText) ??
    parseTransformedPluginSource(
      source,
      resolver.transform({
        source: sourceText,
        filename: source,
        ts: /\.[cm]?tsx?$/.test(source),
        async: true,
        babel: {
          plugins: [
            {
              pre(file: { path: NodePath<BabelProgram> }) {
                file.path.traverse({
                  // Native type erasure retains empty requests from specifier-only type syntax.
                  ImportDeclaration(declaration) {
                    if (
                      declaration.node.importKind !== "type" &&
                      declaration.node.specifiers.length > 0 &&
                      declaration.node.specifiers.every(
                        (specifier) =>
                          specifier.type === "ImportSpecifier" && specifier.importKind === "type",
                      )
                    ) {
                      authoredStaticImports.add(declaration.node.source.value);
                    }
                  },
                  ExportNamedDeclaration(declaration) {
                    if (
                      declaration.node.source &&
                      declaration.node.exportKind !== "type" &&
                      declaration.node.specifiers.length > 0 &&
                      declaration.node.specifiers.every(
                        (specifier) =>
                          specifier.type === "ExportSpecifier" && specifier.exportKind === "type",
                      )
                    ) {
                      authoredStaticImports.add(declaration.node.source.value);
                    }
                  },
                  MemberExpression(member) {
                    // Jiti inlines import.meta.url, dirname and filename as strings, also
                    // where valid code assigns to them. Inspection reads only references,
                    // so a plain identifier keeps that target parseable.
                    if (
                      member.get("object").node?.type === "MetaProperty" &&
                      isAssignmentTarget(member)
                    ) {
                      member.replaceWith({ type: "Identifier", name: "importMetaTarget" });
                    }
                  },
                  CallExpression(call) {
                    const args = call.get("arguments");
                    // Jiti replaces this anchor with a string; capture its meaning before rewriting.
                    if (unwrapReferenceArgument(args[0])?.matchesPattern("import.meta.dirname")) {
                      const callee = call.get("callee");
                      const member = callee.isMemberExpression() ? callee.get("property") : callee;
                      const name =
                        ["join", "resolve"].find((method) =>
                          ["path", "node:path"].some((moduleName) =>
                            callee.referencesImport(moduleName, method),
                          ),
                        ) ??
                        (member.isIdentifier() ? member.node.name : undefined) ??
                        "";
                      visitDirectoryAsset(
                        name,
                        args
                          .slice(1)
                          .map((arg) => staticString(unwrapReferenceArgument(arg)?.node)),
                      );
                    }
                    const argument = unwrapReferenceArgument(
                      args.length === 1 ? args[0] : undefined,
                    );
                    const specifier = staticString(argument?.node);
                    if (specifier !== undefined && isCurrentFileRequire(call)) {
                      visitReference(specifier, "require");
                    }
                  },
                });
              },
              // Jiti runs these after TypeScript erasure and before lowering module declarations.
              visitor: {
                "ImportDeclaration|ExportNamedDeclaration|ExportAllDeclaration"(
                  declaration: NodePath<
                    ImportDeclaration | ExportNamedDeclaration | ExportAllDeclaration
                  >,
                ) {
                  if (declaration.node.source) {
                    authoredStaticImports.add(declaration.node.source.value);
                  }
                },
              },
            },
          ],
        },
      }),
    );
  const staticImports = new Set<string>();
  for (const statement of tree.body) {
    if (
      (statement.type === "ImportDeclaration" ||
        statement.type === "ExportNamedDeclaration" ||
        statement.type === "ExportAllDeclaration") &&
      statement.source
    ) {
      const reference = staticString(statement.source);
      if (reference !== undefined) {
        staticImports.add(reference);
        authoredStaticImports.add(reference);
      }
    }
  }
  // Jiti hoists and deduplicates static module sources before the executable body.
  for (const reference of staticImports) {
    visitReference(reference, "import");
  }
  const visit = (node: AnyNode) => {
    if (node.type === "ImportExpression") {
      const reference = staticString(node.source);
      if (reference !== undefined) {
        visitReference(reference, "import");
      }
    }
    if (node.type === "CallExpression" || node.type === "NewExpression") {
      const { callee: call, arguments: args } = node;
      // Jiti emits named-import calls as (0, binding); their last expression is the callee.
      const callee = call.type === "SequenceExpression" ? call.expressions.at(-1)! : call;
      const member = callee.type === "MemberExpression" ? callee.property : callee;
      const name = member.type === "Identifier" ? member.name : "";
      const module =
        callee.type === "Identifier"
          ? ["require", "jitiImport", "jitiESMResolve"].includes(name)
          : callee.type === "MemberExpression" &&
            callee.object.type === "Identifier" &&
            callee.object.name === "require" &&
            name === "resolve";
      const asset =
        (node.type === "NewExpression" && name === "URL") ||
        ["readFile", "readFileSync", "createReadStream"].includes(name);
      // Trace module references and explicit asset reads. Ordinary strings
      // (labels, descriptions, prompts) never confer ownership of sibling files.
      const reference = staticString(args[0]);
      if ((module || asset) && reference !== undefined) {
        visitReference(
          reference,
          module ? (name === "require" || name === "resolve" ? "require" : "import") : "asset",
        );
      }
      if (
        callee.type === "MemberExpression" &&
        args[0]?.type === "Identifier" &&
        args[0].name === "__dirname"
      ) {
        visitDirectoryAsset(name, args.slice(1).map(staticString));
      }
    }
    for (const child of sourceChildren(node)) {
      visit(child);
    }
  };
  visit(tree);
  return authoredStaticImports;
}
