import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse, type AnyNode } from "acorn";
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

type RequireReferencePath = {
  node: (StaticStringNode & { name?: string; computed?: boolean }) | null;
  scope: {
    getBinding(name: string): { constant: boolean; path: RequireReferencePath } | undefined;
  };
  get(key: "arguments"): RequireReferencePath[];
  get(key: string): RequireReferencePath;
  referencesImport(source: string, name: string): boolean;
  matchesPattern(pattern: string): boolean;
};

function unwrapReferenceArgument(input: RequireReferencePath | undefined) {
  let argument = input;
  // TypeScript erases these wrappers without evaluating another value.
  while (
    argument &&
    [
      "TSAsExpression",
      "TSTypeAssertion",
      "TSNonNullExpression",
      "TSSatisfiesExpression",
      "TSInstantiationExpression",
    ].includes(argument.node?.type ?? "")
  ) {
    argument = argument.get("expression");
  }
  return argument;
}

/** Read the native factory binding before Jiti rewrites modules and import.meta. */
function isCurrentFileRequire(call: RequireReferencePath): boolean {
  const callee = call.get("callee");
  const reference =
    callee.node?.type === "MemberExpression" &&
    !callee.node.computed &&
    callee.get("property").node?.name === "resolve"
      ? callee.get("object")
      : callee;
  let init = reference;
  if (reference.node?.type === "Identifier" && reference.node.name) {
    const binding = reference.scope.getBinding(reference.node.name);
    if (!binding?.constant || binding.path.node?.type !== "VariableDeclarator") {
      return false;
    }
    init = binding.path.get("init");
  }
  if (init.node?.type !== "CallExpression") {
    return false;
  }
  const args = init.get("arguments");
  const anchor = args.length === 1 ? args[0] : undefined;
  if (
    !anchor ||
    !(
      (anchor.node?.type === "MemberExpression" &&
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
      (factory.node?.type === "MemberExpression" &&
        !factory.node.computed &&
        factory.get("property").node?.name === "createRequire" &&
        factory.get("object").referencesImport(source, "default")),
  );
}

/** Visit literal module and explicit asset inputs without evaluating plugin code. */
export function visitPluginSourceReferences(
  source: string,
  sourceText: string,
  resolver: ReturnType<typeof createJiti>,
  visitReference: (reference: string, kind: "asset" | "import" | "require") => void,
): void {
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
  const code = resolver.transform({
    source: sourceText,
    filename: source,
    ts: /\.[cm]?tsx?$/.test(source),
    async: true,
    babel: {
      plugins: [
        {
          pre(file: {
            path: {
              traverse(visitor: { CallExpression(call: RequireReferencePath): void }): void;
            };
          }) {
            file.path.traverse({
              CallExpression(call) {
                const args = call.get("arguments");
                // Jiti replaces this anchor with a string; capture its meaning before rewriting.
                if (unwrapReferenceArgument(args[0])?.matchesPattern("import.meta.dirname")) {
                  const callee = call.get("callee");
                  const member =
                    callee.node?.type === "MemberExpression" ? callee.get("property") : callee;
                  const name =
                    ["join", "resolve"].find((method) =>
                      ["path", "node:path"].some((moduleName) =>
                        callee.referencesImport(moduleName, method),
                      ),
                    ) ??
                    member.node?.name ??
                    "";
                  visitDirectoryAsset(
                    name,
                    args.slice(1).map((arg) => staticString(unwrapReferenceArgument(arg)?.node)),
                  );
                }
                const argument = unwrapReferenceArgument(args.length === 1 ? args[0] : undefined);
                const specifier = staticString(argument?.node);
                if (specifier !== undefined && isCurrentFileRequire(call)) {
                  visitReference(specifier, "require");
                }
              },
            });
          },
        },
      ],
    },
  });
  const visit = (node: AnyNode) => {
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
    for (const child of Object.values(node).flat()) {
      if (child && typeof child === "object" && "type" in child) {
        // SAFETY: The tree comes directly from Acorn; typed child fields are Acorn nodes.
        visit(child as AnyNode);
      }
    }
  };
  visit(
    parse(code, {
      ecmaVersion: "latest",
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    }),
  );
}
