import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const MANIFEST_NAME = "asset-manifest.json";
const MAX_ASSETS = 256;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_INVENTORY_ENTRIES = 512;
const mimeByExtension = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".woff2", "font/woff2"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".webp", "image/webp"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
]);

// Reject ambiguous URL spellings and platform-specific path syntax before any I/O.
export function validateAssetPath(name) {
  if (
    typeof name !== "string" ||
    name.length > 512 ||
    name.split("/").length > 8 ||
    !/^(?:index\.html|assets\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*)$/.test(
      name,
    ) ||
    name.split("/").some((part) => part.startsWith(".")) ||
    /^(?:sw|service[-_]?worker)(?:[._-]|$)/i.test(name.split("/").at(-1))
  ) {
    throw new Error(`Unsafe or worker asset path: ${String(name)}`);
  }
  if (
    name !== "index.html" &&
    (path.posix.extname(name) !== path.posix.extname(name).toLowerCase() ||
      path.posix.extname(name) === ".html" ||
      !mimeByExtension.has(path.posix.extname(name)))
  ) {
    throw new Error(`Unsupported asset MIME: ${name}`);
  }
  return name;
}

// All parents, including the output root, must be real directories. This is
// a local build precondition, not a defense against a concurrent filesystem writer.
export function assertRealDirectory(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Unsafe directory: ${current}`);
    }
  }
}

function collect(root, relative = "") {
  const names = [];
  for (const entry of readdirSync(path.join(root, relative)).toSorted()) {
    const name = relative ? `${relative}/${entry}` : entry;
    const stat = lstatSync(path.join(root, name));
    if (stat.isSymbolicLink()) {
      throw new Error(`Symlink in output: ${name}`);
    }
    if (stat.isDirectory()) {
      if (name !== "assets" && !name.startsWith("assets/")) {
        throw new Error(`Unexpected directory: ${name}`);
      }
      const nested = collect(root, name);
      if (!nested.length) {
        throw new Error(`Unexpected empty output directory: ${name}`);
      }
      names.push(...nested);
    } else if (stat.isFile() && stat.nlink === 1) {
      names.push(validateAssetPath(name));
    } else {
      throw new Error(`Nonregular or linked output: ${name}`);
    }
  }
  return names;
}

function localReference(value, from, files) {
  if (!/^(?:\.\/)?[A-Za-z0-9_./-]+$/.test(value) || value.split("/").includes("..")) {
    throw new Error(`Unsafe or external asset reference: ${value}`);
  }
  const resolved = path.posix.join(path.posix.dirname(from), value);
  validateAssetPath(resolved);
  if (!files.has(resolved)) {
    throw new Error(`Unlisted asset reference: ${resolved}`);
  }
}

// This is a deliberately small HTML grammar, not a general HTML parser.
// Reject entities and all unknown syntax before matching the document structure.
function hasControlCharacter(value, allowed = []) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return (code < 32 || code === 127) && !allowed.includes(code);
  });
}

function validateDocument(html, files) {
  if (/[&\\]/.test(html) || hasControlCharacter(html, [9, 10])) {
    throw new Error("Ambiguous document encoding");
  }
  const pieces = html.match(/<!doctype html>|<[^>]*>|[^<]+/gi) ?? [];
  if (pieces.join("") !== html) {
    throw new Error("Malformed document");
  }
  const shape = [];
  let scripts = 0;
  let charsets = 0;
  let viewports = 0;
  for (const piece of pieces) {
    if (/^<!doctype html>$/i.test(piece)) {
      shape.push("doctype");
      continue;
    }
    if (!piece.startsWith("<")) {
      if (piece.trim()) {
        shape.push(`text:${piece.trim()}`);
      }
      continue;
    }
    const tag = /^<(\/?)([a-z][a-z0-9-]*)([^<>]*)>$/i.exec(piece);
    if (!tag) {
      throw new Error("Malformed document tag");
    }
    const [, closing, rawName, tail] = tag;
    const name = rawName.toLowerCase();
    if (closing) {
      if (tail.trim()) {
        throw new Error("Malformed closing tag");
      }
      shape.push(`/${name}`);
      continue;
    }
    const attrs = new Map();
    let rest = tail;
    while (rest.length) {
      if (/^\s+$/.test(rest)) {
        break;
      }
      const attr = /^\s+([a-z][a-z0-9-]*)(?:\s*=\s*(?:"([^"<>]*)"|'([^'<>]*)'))?/i.exec(rest);
      if (!attr) {
        throw new Error("Malformed document attribute");
      }
      const key = attr[1].toLowerCase();
      if (attrs.has(key)) {
        throw new Error("Duplicate document attribute");
      }
      attrs.set(key, attr[2] ?? attr[3] ?? null);
      rest = rest.slice(attr[0].length);
    }
    const exact = (required, optional = []) => {
      if (
        [...attrs.keys()].some((key) => !required.includes(key) && !optional.includes(key)) ||
        required.some((key) => !attrs.has(key))
      ) {
        throw new Error(`Unsupported ${name} attributes`);
      }
    };
    if (name === "html") {
      exact(["lang"]);
      if (attrs.get("lang") !== "en") {
        throw new Error("Unsupported language");
      }
    } else if (name === "meta") {
      if (attrs.has("charset")) {
        charsets++;
        exact(["charset"]);
        if (attrs.get("charset")?.toLowerCase() !== "utf-8") {
          throw new Error("Unsupported charset");
        }
      } else {
        viewports++;
        exact(["name", "content"]);
        if (
          attrs.get("name") !== "viewport" ||
          attrs.get("content") !== "width=device-width, initial-scale=1"
        ) {
          throw new Error("Unsupported meta");
        }
      }
    } else if (name === "script" || name === "link") {
      exact(name === "script" ? ["type", "src"] : ["rel", "href"], ["crossorigin"]);
      if (attrs.has("crossorigin") && ![null, "", "anonymous"].includes(attrs.get("crossorigin"))) {
        throw new Error("Unsupported crossorigin");
      }
      const value = attrs.get(name === "script" ? "src" : "href");
      const kind = attrs.get(name === "script" ? "type" : "rel");
      if (name === "script") {
        if (kind !== "module" || !value?.endsWith(".js")) {
          throw new Error("Unsupported script");
        }
        scripts++;
      } else if (
        !(
          (kind === "stylesheet" && value?.endsWith(".css")) ||
          (kind === "modulepreload" && value?.endsWith(".js"))
        )
      ) {
        throw new Error("Unsupported link");
      }
      localReference(value, "index.html", files);
    } else if (["head", "title", "body", "main", "openclaw-team-event-product"].includes(name)) {
      exact([]);
    } else {
      throw new Error(`Unsupported document element: ${name}`);
    }
    shape.push(name);
  }
  // Links and module scripts can be emitted in either order inside the head.
  const actual = shape.join(" ");
  if (
    scripts !== 1 ||
    charsets !== 1 ||
    viewports !== 1 ||
    !/^doctype html head meta meta title text:Team event \/title (?:(?:script \/script|link) )+\/head body main openclaw-team-event-product \/openclaw-team-event-product \/main \/body \/html$/.test(
      actual,
    )
  ) {
    throw new Error("Unsupported document structure");
  }
}

function validateStylesheet(name, css, files) {
  // Only strings and comments may contain escapes. Escape-bearing identifiers
  // and URLs are rejected; quoted content such as "\\2026" remains valid.
  let i = 0;
  while (i < css.length) {
    if (css.startsWith("/*", i)) {
      const end = css.indexOf("*/", i + 2);
      if (end < 0) {
        throw new Error(`Malformed CSS comment: ${name}`);
      }
      i = end + 2;
      continue;
    }
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let closed = false;
      while (i < css.length) {
        if (css[i] === "\\") {
          if (i + 1 >= css.length) {
            break;
          }
          i += 2;
        } else if (css[i] === quote) {
          i++;
          closed = true;
          break;
        } else if (/[\r\n\f]/.test(css[i])) {
          break;
        } else {
          i++;
        }
      }
      if (!closed) {
        throw new Error(`Malformed CSS string: ${name}`);
      }
      continue;
    }
    if (ch === "\\" || hasControlCharacter(ch, [9, 10, 12, 13])) {
      throw new Error(`Unsupported CSS escape: ${name}`);
    }
    if (/[a-zA-Z_-]/.test(ch)) {
      const start = i++;
      while (i < css.length && /[a-zA-Z0-9_-]/.test(css[i])) {
        i++;
      }
      const word = css.slice(start, i).toLowerCase();
      if (word === "import" && css[start - 1] === "@") {
        throw new Error(`Unsupported CSS import: ${name}`);
      }
      if (["image-set", "-webkit-image-set", "image", "src"].includes(word) && css[i] === "(") {
        throw new Error(`Unsupported CSS image function: ${name}`);
      }
      if (word === "url" && css[i] === "(") {
        const end = css.indexOf(")", i + 1);
        if (end < 0) {
          throw new Error(`Malformed CSS URL: ${name}`);
        }
        let value = css.slice(i + 1, end).trim();
        if (value.startsWith('"') || value.startsWith("'")) {
          if (value.length < 2 || value.at(-1) !== value[0]) {
            throw new Error(`Malformed CSS URL: ${name}`);
          }
          value = value.slice(1, -1);
        }
        if (!value || /[\\()]/.test(value) || hasControlCharacter(value)) {
          throw new Error(`Unsupported CSS URL: ${name}`);
        }
        if (!value.startsWith("data:")) {
          localReference(value, name, files);
        }
        i = end + 1;
      }
      continue;
    }
    i++;
  }
}

// This check examines emitted JavaScript, after TypeScript and bundler transforms.
// It rejects recognizable worker access and ambiguous computed access to known
// global aliases. It cannot prove arbitrary JavaScript lacks indirect capability;
// an isolated origin, no controlling service worker and an enforced worker-src
// CSP without dynamic code generation still require independent runtime qualification.
// Parameter and alias propagation covers only recognizable local forms; indirect
// calls, computed runtime URLs and other code generation remain runtime gates.
export function validateWorkerCapabilities(source, assetName = "script") {
  const { parse } = createRequire(import.meta.url)("acorn");
  let root;
  try {
    root = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch (error) {
    throw new Error(`Unparseable event JavaScript: ${assetName}`, { cause: error });
  }
  const nodes = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") {
      continue;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        pending.push(child);
      }
      continue;
    }
    if (typeof node.type === "string") {
      nodes.push(node);
    }
    for (const child of Object.values(node)) {
      if (child && typeof child === "object") {
        pending.push(child);
      }
    }
  }
  // Resolve inert values and capability aliases by lexical binding. A same-named
  // binding in another scope cannot make a global reference safe or tainted.
  const parents = new WeakMap();
  const scopes = new WeakMap();
  const declaredBindings = new WeakMap();
  const rootScope = { parent: null, bindings: new Map(), functionScope: true };
  const bind = (pattern, scope, candidate) => {
    if (!pattern) {
      return;
    }
    if (pattern.type === "Identifier") {
      // Body var bindings copy same-named parameter values on entry. Sharing
      // their taint identity conservatively retains that initial capability.
      const previous =
        scope.bindings.get(pattern.name) ?? scope.parameterScope?.bindings.get(pattern.name);
      // Repeated var/function declarations share an identity. Invalidate inert
      // evidence without stranding references to the earlier binding record.
      if (previous) {
        for (const key of Object.keys(previous)) {
          delete previous[key];
        }
        previous.safe = false;
      }
      scope.bindings.set(pattern.name, previous ?? candidate);
      declaredBindings.set(pattern, previous ?? candidate);
    } else if (pattern.type === "RestElement") {
      bind(pattern.argument, scope, { safe: false });
    } else if (pattern.type === "AssignmentPattern") {
      bind(pattern.left, scope, { safe: false });
    } else if (pattern.type === "ArrayPattern") {
      pattern.elements.forEach((part) => bind(part, scope, { safe: false }));
    } else if (pattern.type === "ObjectPattern") {
      pattern.properties.forEach((part) =>
        bind(part.type === "RestElement" ? part.argument : part.value, scope, { safe: false }),
      );
    }
  };
  const isString = (node) => node?.type === "Literal" && typeof node.value === "string";
  const isInertLiteral = (node) =>
    node?.type === "Literal" &&
    !node.regex &&
    (node.value === null || ["string", "number", "boolean"].includes(typeof node.value));
  const inertObject = (node) =>
    node?.type === "ObjectExpression" &&
    node.properties.every(
      (entry) =>
        entry.type === "Property" &&
        entry.kind === "init" &&
        !entry.method &&
        !entry.shorthand &&
        !entry.computed &&
        isInertLiteral(entry.value) &&
        (entry.key.type === "Identifier" || isString(entry.key)) &&
        (entry.key.name ?? entry.key.value) !== "__proto__",
    );
  const walkScopes = (node, inputScope, parent = null) => {
    let scope = inputScope;
    if (!node || typeof node !== "object") {
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child) => walkScopes(child, scope, parent));
      return;
    }
    if (typeof node.type !== "string") {
      return;
    }
    if (parent) {
      parents.set(node, parent);
    }
    if (node.type === "FunctionDeclaration" && node.id) {
      bind(node.id, scope, { safe: false, function: node });
    }
    if (node.type === "ClassDeclaration" && node.id) {
      bind(node.id, scope, { safe: false });
    }
    const fn = ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
      node.type,
    );
    // Each class static block owns lexical bindings and is also a var
    // hoisting boundary, independently of the enclosing function or module.
    const staticBlock = node.type === "StaticBlock";
    // A named expression's self binding sits outside its parameters. Functions
    // with parameter expressions also have a separate body var environment.
    if (node.type === "FunctionExpression" && node.id) {
      scope = { parent: scope, bindings: new Map(), functionScope: false };
      bind(node.id, scope, { safe: false });
    }
    const enclosingScope = scope;
    const parameterBody =
      node.type === "BlockStatement" &&
      parent?.body === node &&
      ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(
        parent.type,
      ) &&
      parent.params.some((param) => param.type !== "Identifier");
    if (
      fn ||
      staticBlock ||
      [
        "BlockStatement",
        "CatchClause",
        "ForStatement",
        "ForInStatement",
        "ForOfStatement",
        "SwitchStatement",
      ].includes(node.type)
    ) {
      scope = {
        parent: scope,
        bindings: new Map(),
        functionScope: fn || staticBlock || parameterBody,
        parameterScope: parameterBody ? scope : undefined,
      };
    }
    scopes.set(node, scope);
    if (fn) {
      node.params.forEach((param, index) =>
        bind(param, scope, { safe: false, parameter: { function: node, index } }),
      );
    }
    if (node.type === "CatchClause") {
      bind(node.param, scope, { safe: false });
    }
    if (node.type === "ImportDeclaration") {
      node.specifiers.forEach((spec) => bind(spec.local, scope, { safe: false }));
    }
    if (node.type === "VariableDeclaration") {
      let target = scope;
      if (node.kind === "var") {
        while (target.parent && !target.functionScope) {
          target = target.parent;
        }
      }
      for (const decl of node.declarations) {
        bind(decl.id, target, {
          safe: isInertLiteral(decl.init),
          object: node.kind === "const" && inertObject(decl.init) ? decl.init : null,
          declaration: decl,
        });
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "type" && child && typeof child === "object") {
        walkScopes(
          child,
          node.type === "SwitchStatement" && key === "discriminant" ? enclosingScope : scope,
          node,
        );
      }
    }
  };
  walkScopes(root, rootScope);
  const referenceBinding = (node) => {
    for (let scope = scopes.get(node); scope; scope = scope.parent) {
      if (scope.bindings.has(node.name)) {
        return scope.bindings.get(node.name);
      }
    }
    return undefined;
  };
  const binding = (node) => declaredBindings.get(node) ?? referenceBinding(node);
  // Resolve each declaration once, then inspect each write target once. Keep
  // binding identity: a same-spelled name in another scope is not the target.
  const declarationBindings = new Set();
  for (const node of nodes) {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") {
      continue;
    }
    const found = binding(node.id);
    if (found) {
      declarationBindings.add(found);
    }
  }
  for (const node of nodes) {
    const target =
      node.type === "AssignmentExpression"
        ? node.left
        : node.type === "UpdateExpression"
          ? node.argument
          : ["ForInStatement", "ForOfStatement"].includes(node.type) &&
              node.left.type !== "VariableDeclaration"
            ? node.left
            : null;
    if (!target) {
      continue;
    }
    const parts = [target];
    while (parts.length) {
      const part = parts.pop();
      if (!part || typeof part !== "object") {
        continue;
      }
      if (Array.isArray(part)) {
        parts.push(...part);
        continue;
      }
      if (part.type === "Identifier") {
        const found = binding(part);
        if (declarationBindings.has(found) && found.safe) {
          found.safe = false;
        }
      } else {
        parts.push(...Object.values(part));
      }
    }
  }
  // A named function parameter is inert only if the function does not escape
  // and every direct call supplies an inert literal at that position.
  for (const fn of nodes.filter(
    (node) =>
      node.type === "FunctionDeclaration" &&
      node.id &&
      node.params.some(
        (param) =>
          param.type === "Identifier" &&
          ["Worker", "SharedWorker", "serviceWorker"].includes(param.name),
      ),
  )) {
    const fnBinding = binding(fn.id);
    if (
      fnBinding?.function !== fn ||
      parents.get(fn)?.type === "ExportNamedDeclaration" ||
      parents.get(fn)?.type === "ExportDefaultDeclaration"
    ) {
      continue;
    }
    const calls = [];
    let escapes = false;
    for (const ref of nodes) {
      if (ref.type !== "Identifier" || binding(ref) !== fnBinding || ref === fn.id) {
        continue;
      }
      const parent = parents.get(ref);
      if (parent?.type === "CallExpression" && parent.callee === ref && !parent.optional) {
        calls.push(parent);
      } else {
        escapes = true;
      }
    }
    if (escapes || calls.length === 0) {
      continue;
    }
    for (const [index, param] of fn.params.entries()) {
      if (param.type !== "Identifier") {
        continue;
      }
      const paramBinding = binding(param);
      const containsBinding = (part) => {
        if (!part || typeof part !== "object") {
          return false;
        }
        if (Array.isArray(part)) {
          return part.some(containsBinding);
        }
        if (part.type === "Identifier") {
          return binding(part) === paramBinding;
        }
        return Object.values(part).some(containsBinding);
      };
      const written = nodes.some(
        (node) =>
          (node.type === "AssignmentExpression" && containsBinding(node.left)) ||
          (node.type === "UpdateExpression" && containsBinding(node.argument)) ||
          (["ForInStatement", "ForOfStatement"].includes(node.type) &&
            node.left.type !== "VariableDeclaration" &&
            containsBinding(node.left)),
      );
      if (
        paramBinding?.parameter?.function === fn &&
        !written &&
        calls.every((call) => isInertLiteral(call.arguments[index]))
      ) {
        paramBinding.safe = true;
      }
    }
  }
  const inertObjectBindings = new Set();
  for (const node of nodes) {
    if (node.type !== "VariableDeclarator" || node.id.type !== "Identifier") {
      continue;
    }
    const found = binding(node.id);
    if (found?.object && found.declaration === node) {
      inertObjectBindings.add(found);
    }
  }
  // Admit only nonescaping read-only literal property accesses. Missing fields
  // additionally require no recognizable prototype access in this script.
  const prototypeAccess = nodes.some(
    (node) =>
      node.type === "MemberExpression" &&
      (node.computed
        ? isString(node.property) && ["prototype", "__proto__"].includes(node.property.value)
        : ["prototype", "__proto__"].includes(node.property.name)),
  );
  for (const node of nodes) {
    if (node.type !== "Identifier") {
      continue;
    }
    const found = binding(node);
    if (!inertObjectBindings.has(found)) {
      continue;
    }
    const parent = parents.get(node);
    if (parent === found.declaration && parent.id === node) {
      continue;
    }
    const outer = parents.get(parent);
    const key =
      parent?.type === "MemberExpression" && parent.object === node
        ? parent.computed
          ? isString(parent.property)
            ? parent.property.value
            : undefined
          : parent.property.name
        : undefined;
    const own = found.object.properties.some(
      (entry) => (entry.key.name ?? entry.key.value) === key,
    );
    if (
      key === undefined ||
      (!own && prototypeAccess) ||
      (outer?.type === "AssignmentExpression" && outer.left === parent) ||
      (outer?.type === "UpdateExpression" && outer.argument === parent) ||
      (outer?.type === "UnaryExpression" && outer.operator === "delete") ||
      (["CallExpression", "NewExpression", "TaggedTemplateExpression"].includes(outer?.type) &&
        (outer.callee === parent || outer.tag === parent))
    ) {
      inertObjectBindings.delete(found);
    }
  }
  // Unresolved globals need distinct identities, separate from local bindings
  // with builtin spellings. Declaration identities were captured at their owner
  // scope (a function declaration can have a same-named parameter).
  const globalBindings = new Map();
  const globalBinding = (name) => {
    if (!globalBindings.has(name)) {
      globalBindings.set(name, {});
    }
    return globalBindings.get(name);
  };
  const identity = (node) => binding(node) ?? globalBinding(node.name);
  // A var declaration hoists out of catch, but its initializer assigns the
  // catch parameter when that parameter shadows the hoisted binding.
  const initializerIdentity = (node) => referenceBinding(node) ?? globalBinding(node.name);
  const globals = new Set(["globalThis", "window", "self", "navigator"].map(globalBinding));
  const strings = new Map();
  const constBindings = new Map();
  const assigned = new Set();
  for (const node of nodes) {
    if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) {
        if (declaration.id.type !== "Identifier") {
          continue;
        }
        const name = initializerIdentity(declaration.id);
        constBindings.set(
          name,
          constBindings.has(name) || node.kind !== "const" ? null : declaration.init,
        );
      }
    }
    if (["AssignmentExpression", "UpdateExpression"].includes(node.type)) {
      const target = node.left ?? node.argument;
      if (target?.type === "Identifier") {
        assigned.add(identity(target));
      }
    }
  }
  const value = (node) => {
    if (!node) {
      return undefined;
    }
    if (node.type === "Literal" && typeof node.value === "string") {
      return node.value;
    }
    if (node.type === "Identifier") {
      return strings.get(identity(node));
    }
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
      return node.quasis[0].value.cooked;
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = value(node.left),
        right = value(node.right);
      return typeof left === "string" && typeof right === "string" ? left + right : undefined;
    }
    return undefined;
  };
  const staticValue = (node) => {
    if (!node) {
      return undefined;
    }
    if (node.type === "Literal" && typeof node.value === "string") {
      return node.value;
    }
    if (node.type === "TemplateLiteral" && node.expressions.length === 0) {
      return node.quasis[0].value.cooked;
    }
    if (node.type === "BinaryExpression" && node.operator === "+") {
      const left = staticValue(node.left),
        right = staticValue(node.right);
      return typeof left === "string" && typeof right === "string" ? left + right : undefined;
    }
    return undefined;
  };
  const property = (node) => (node.computed ? value(node.property) : node.property?.name);
  const globalObject = (node) =>
    (node?.type === "Identifier" && globals.has(identity(node))) ||
    (node?.type === "MemberExpression" &&
      globalObject(node.object) &&
      ["window", "self", "globalThis", "navigator"].includes(property(node))) ||
    (node?.type === "CallExpression" &&
      reflectionMethod(node.callee) &&
      property(node.callee) === "get" &&
      globalObject(node.arguments[0]) &&
      ["window", "self", "globalThis", "navigator"].includes(value(node.arguments[1])));
  const reflection = new Set();
  const functions = new Map();
  const functionTargets = (node) =>
    node?.type === "Identifier"
      ? functions.get(identity(node))
      : ["FunctionExpression", "ArrowFunctionExpression"].includes(node?.type)
        ? [node]
        : undefined;
  const addFunctions = (key, candidates) => {
    if (!candidates) {
      return false;
    }
    if (!functions.has(key)) {
      functions.set(key, new Set());
    }
    const targets = functions.get(key);
    const before = targets.size;
    for (const fn of candidates) {
      targets.add(fn);
    }
    return targets.size !== before;
  };
  for (const node of nodes) {
    if (["FunctionDeclaration", "FunctionExpression"].includes(node.type) && node.id) {
      addFunctions(identity(node.id), [node]);
    }
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
      addFunctions(initializerIdentity(node.id), functionTargets(node.init));
    }
  }
  const reflectionObjects = new Map([
    [globalBinding("Reflect"), "Reflect"],
    [globalBinding("Object"), "Object"],
  ]);
  const reflectionObject = (node) =>
    node?.type === "Identifier"
      ? reflectionObjects.get(identity(node))
      : node?.type === "MemberExpression" &&
          globalObject(node.object) &&
          ["Reflect", "Object"].includes(property(node))
        ? property(node)
        : undefined;
  const reflectionMethod = (node) =>
    node?.type === "MemberExpression" &&
    reflectionObject(node.object) &&
    [
      "get",
      "getOwnPropertyDescriptor",
      "getOwnPropertyDescriptors",
      "getOwnPropertyNames",
      "ownKeys",
      "keys",
      "values",
      "entries",
    ].includes(property(node));
  const reflectionValue = (node) =>
    reflectionMethod(node) ||
    (node?.type === "Identifier" && reflection.has(identity(node))) ||
    (node?.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      property(node.callee) === "bind" &&
      reflectionValue(node.callee.object));
  // Follow simple aliases and unambiguous constant strings. Reject unusually
  // deep alias chains rather than spending unbounded time on generated code.
  let converged = false;
  for (let pass = 0; pass < 32; pass++) {
    let changed = false;
    // Declarations, defaults and direct arguments share the same narrow transfer.
    // Defaults remain possible sources; declarators retain catch/var write identity.
    const propagatePattern = (param, argument, targetIdentity = identity) => {
      if (!param) {
        return;
      }
      if (param.type === "AssignmentPattern") {
        propagatePattern(param.left, argument, targetIdentity);
        propagatePattern(param.left, param.right, targetIdentity);
        return;
      }
      if (param.type === "Identifier") {
        const key = targetIdentity(param);
        if (globalObject(argument) && !globals.has(key)) {
          globals.add(key);
          changed = true;
        }
        const object = reflectionObject(argument);
        if (object && !reflectionObjects.has(key)) {
          reflectionObjects.set(key, object);
          changed = true;
        }
        if (reflectionValue(argument) && !reflection.has(key)) {
          reflection.add(key);
          changed = true;
        }
        if (addFunctions(key, functionTargets(argument))) {
          changed = true;
        }
        return;
      }
      const capability =
        globalObject(argument) ||
        reflectionObject(argument) ||
        reflectionValue(argument) ||
        functionTargets(argument);
      if (param.type !== "ObjectPattern") {
        if (capability) {
          throw new Error(`Worker capability unavailable in event UI: ${assetName}`);
        }
        // Even a local/unknown source can have capability-bearing defaults.
        if (param.type === "ArrayPattern") {
          param.elements.forEach((part) => propagatePattern(part, undefined, targetIdentity));
        }
        if (param.type === "RestElement") {
          propagatePattern(param.argument, undefined, targetIdentity);
        }
        return;
      }
      for (const entry of param.properties) {
        // Unknown keys and rest can hide a recognizable capability transfer.
        if (
          capability &&
          (entry.type === "RestElement" || (entry.computed && staticValue(entry.key) === undefined))
        ) {
          throw new Error(`Worker capability unavailable in event UI: ${assetName}`);
        }
        propagatePattern(
          entry.type === "RestElement" ? entry.argument : entry.value,
          capability
            ? {
                type: "MemberExpression",
                object: argument,
                property: entry.key,
                computed: entry.computed || entry.key.type === "Literal",
              }
            : undefined,
          targetIdentity,
        );
      }
    };
    for (const node of nodes) {
      if (
        ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type)
      ) {
        node.params.forEach((param) => propagatePattern(param, undefined));
      }
      if (node.type === "CatchClause") {
        propagatePattern(node.param, undefined);
      }
      if (
        ["ForInStatement", "ForOfStatement"].includes(node.type) &&
        node.left.type !== "VariableDeclaration"
      ) {
        propagatePattern(node.left, undefined);
      }
      if (node.type === "CallExpression") {
        for (const fn of functionTargets(node.callee) ?? []) {
          fn.params.forEach((param, i) => {
            propagatePattern(param, node.arguments[i]);
          });
        }
      }
      if (
        node.type === "AssignmentExpression" &&
        node.operator === "=" &&
        node.left.type !== "MemberExpression"
      ) {
        propagatePattern(node.left, node.right);
      }
      if (node.type !== "VariableDeclarator") {
        continue;
      }
      propagatePattern(node.id, node.init, initializerIdentity);
      if (node.id.type !== "Identifier") {
        continue;
      }
      const key = initializerIdentity(node.id);
      const literal =
        constBindings.get(key) === node.init && !assigned.has(key) ? value(node.init) : undefined;
      if (literal !== undefined && !strings.has(key)) {
        strings.set(key, literal);
        changed = true;
      }
    }
    if (!changed) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    throw new Error(`Unresolved event JavaScript aliases: ${assetName}`);
  }
  const forbidden = new Set(["Worker", "SharedWorker", "serviceWorker"]);
  const fail = () => {
    throw new Error(`Worker capability unavailable in event UI: ${assetName}`);
  };
  for (const node of nodes) {
    if (node.type === "Identifier") {
      const parent = parents.get(node);
      const staticName =
        (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) ||
        (parent?.type === "Property" &&
          parent.key === node &&
          !parent.computed &&
          !parent.shorthand) ||
        (parent?.type === "ExportSpecifier" && parent.exported === node) ||
        (parent?.type === "ImportSpecifier" && parent.imported === node);
      const assignment = parents.get(parent);
      // An inert plain write names a property without reading its capability.
      // Reads, calls, compound writes and global-object access stay guarded.
      const inertPropertyWrite =
        parent?.type === "MemberExpression" &&
        parent.property === node &&
        !parent.computed &&
        assignment?.type === "AssignmentExpression" &&
        assignment.left === parent &&
        assignment.operator === "=" &&
        isInertLiteral(assignment.right);
      if (
        (!staticName && forbidden.has(node.name) && !binding(node)?.safe) ||
        (!inertPropertyWrite && (node.name === "eval" || node.name === "Function"))
      ) {
        fail();
      }
    }
    if (node.type === "MemberExpression") {
      const key = property(node);
      if (
        forbidden.has(key) &&
        !(node.object.type === "Identifier" && inertObjectBindings.has(binding(node.object)))
      ) {
        fail();
      }
      if (
        globalObject(node.object) &&
        ((node.computed && staticValue(node.property) === undefined) ||
          key === undefined ||
          key === "eval" ||
          key === "Function")
      ) {
        fail();
      }
      if (
        reflectionObject(node.object) &&
        node.computed &&
        staticValue(node.property) === undefined
      ) {
        fail();
      }
      // A function constructor can synthesize code even with one property access.
      if (
        key === "constructor" &&
        (["FunctionExpression", "ArrowFunctionExpression"].includes(node.object.type) ||
          (node.object.type === "Identifier" && functions.has(identity(node.object))) ||
          (node.object.type === "MemberExpression" && property(node.object) === "constructor"))
      ) {
        fail();
      }
    }
    // Bound reflection with pre-applied globals and call/apply can bypass the
    // ordinary first-argument check. Reject these recognizable ambiguous forms.
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      reflectionValue(node.callee.object) &&
      ((property(node.callee) === "bind" && node.arguments.slice(1).some(globalObject)) ||
        ["call", "apply"].includes(property(node.callee)))
    ) {
      fail();
    }
    // Browser timers also compile string callbacks.
    if (
      node.type === "CallExpression" &&
      ((node.callee.type === "Identifier" &&
        ["setTimeout", "setInterval"].includes(node.callee.name)) ||
        (node.callee.type === "MemberExpression" &&
          globalObject(node.callee.object) &&
          ["setTimeout", "setInterval"].includes(property(node.callee)))) &&
      value(node.arguments[0]) !== undefined
    ) {
      fail();
    }
    // Destructuring can acquire a capability without a MemberExpression.
    if (node.type === "ObjectPattern") {
      for (const entry of node.properties) {
        if (entry.type === "RestElement") {
          continue;
        }
        const key = entry.computed ? value(entry.key) : (entry.key.name ?? entry.key.value);
        if (forbidden.has(key)) {
          fail();
        }
      }
    }
    if (
      node.type === "VariableDeclarator" &&
      node.id.type === "ObjectPattern" &&
      globalObject(node.init)
    ) {
      if (
        node.id.properties.some(
          (entry) =>
            entry.type === "RestElement" ||
            (entry.computed && staticValue(entry.key) === undefined),
        )
      ) {
        fail();
      }
    }
    if (
      node.type === "CallExpression" &&
      reflectionValue(node.callee) &&
      globalObject(node.arguments[0])
    ) {
      const key = staticValue(node.arguments[1]);
      const method = node.callee.type === "MemberExpression" ? property(node.callee) : undefined;
      if (
        !["get", "getOwnPropertyDescriptor"].includes(method) ||
        key === undefined ||
        forbidden.has(key) ||
        key === "eval" ||
        key === "Function"
      ) {
        fail();
      }
    }
  }
}

/**
 * Hash final emitted bytes, requiring exactly the complete Vite bundle file list.
 * SVG content is not inspected. Manifest validity is inventory evidence, not
 * authorization to serve assets; SVG handling, origin isolation and CSP belong
 * to the serving boundary.
 */
export function createAssetManifest(root, emittedFiles) {
  assertRealDirectory(root);
  if (
    !Array.isArray(emittedFiles) ||
    emittedFiles.length === 0 ||
    emittedFiles.length > MAX_ASSETS
  ) {
    throw new Error("Invalid emitted file count");
  }
  const expected = emittedFiles.map(validateAssetPath).toSorted();
  if (new Set(expected).size !== expected.length) {
    throw new Error("Duplicate emitted path");
  }
  const directories = new Set();
  for (const name of expected) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) {
      directories.add(parts.slice(0, i).join("/"));
    }
  }
  // The receiver counts the manifest itself and every directory as well as assets.
  if (expected.length + directories.size + 1 > MAX_INVENTORY_ENTRIES) {
    throw new Error("Asset inventory exceeds size limit");
  }
  if (
    !expected.includes("index.html") ||
    !expected.some((name) => name.startsWith("assets/") && name.endsWith(".js"))
  ) {
    throw new Error("Missing event document or entry script");
  }
  const actual = collect(root).toSorted();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Output and emitted files differ");
  }
  let declaredTotal = 0;
  for (const name of expected) {
    const size = lstatSync(path.join(root, name)).size;
    if (size > MAX_ASSET_BYTES) {
      throw new Error(`Asset exceeds size limit: ${name}`);
    }
    declaredTotal += size;
  }
  if (declaredTotal > MAX_TOTAL_BYTES) {
    throw new Error("Asset total exceeds size limit");
  }
  const fileSet = new Set(expected);
  let total = 0;
  const assets = expected.map((name) => {
    const bytes = readFileSync(path.join(root, name));
    total += bytes.length;
    if (bytes.length > MAX_ASSET_BYTES || total > MAX_TOTAL_BYTES) {
      throw new Error("Asset bytes exceed size limit");
    }
    if (name === "index.html") {
      validateDocument(new TextDecoder("utf-8", { fatal: true }).decode(bytes), fileSet);
    }
    if (name.endsWith(".css")) {
      validateStylesheet(name, new TextDecoder("utf-8", { fatal: true }).decode(bytes), fileSet);
    }
    if (name.endsWith(".js")) {
      validateWorkerCapabilities(new TextDecoder("utf-8", { fatal: true }).decode(bytes), name);
    }
    return {
      path: name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      mimeType: mimeByExtension.get(path.posix.extname(name).toLowerCase()),
    };
  });
  return { version: 1, assets };
}

/** Publish only after Vite's complete bundle agrees with the emitted file inventory. */
export function writeAssetManifest(root, emittedFiles, bundle) {
  validateBundleClosure(bundle);
  if (
    !Array.isArray(emittedFiles) ||
    JSON.stringify(Object.keys(bundle).toSorted()) !==
      JSON.stringify(emittedFiles.map(validateAssetPath).toSorted())
  ) {
    throw new Error("Bundle and emitted files differ");
  }
  const manifest = createAssetManifest(root, emittedFiles);
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > MAX_MANIFEST_BYTES) {
    throw new Error("Manifest exceeds size limit");
  }
  writeFileSync(path.join(root, MANIFEST_NAME), bytes, { flag: "wx" });
  return manifest;
}

/** Reject omitted or external Vite-declared dependencies before hashing. */
export function validateBundleClosure(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) {
    throw new Error("Invalid event bundle");
  }
  const files = new Set(Object.keys(bundle));
  if (!files.size) {
    throw new Error("Empty event bundle");
  }
  for (const output of Object.values(bundle)) {
    if (!output || typeof output !== "object" || !["chunk", "asset"].includes(output.type)) {
      throw new Error("Invalid event bundle output");
    }
    const metadata = output.viteMetadata;
    // Vite 8 injects these sets on both chunks and assets in writeBundle.
    // Its asset plugin records Vite asset URLs and Rolldown file URLs here;
    // arbitrary computed URLs remain outside this metadata's guarantee.
    if (
      !metadata ||
      typeof metadata !== "object" ||
      !(metadata.importedCss instanceof Set) ||
      !(metadata.importedAssets instanceof Set)
    ) {
      throw new Error("Invalid event Vite metadata");
    }
    const references = [...metadata.importedCss, ...metadata.importedAssets];
    if (
      output.type === "asset" &&
      ["imports", "dynamicImports", "referencedFiles"].some((field) => field in output)
    ) {
      throw new Error("Invalid event asset dependency metadata");
    }
    if (output.type === "chunk") {
      if (
        !Array.isArray(output.imports) ||
        !Array.isArray(output.dynamicImports) ||
        (output.referencedFiles !== undefined && !Array.isArray(output.referencedFiles))
      ) {
        throw new Error("Invalid event chunk metadata");
      }
      // Rolldown 1.2.9 has no referencedFiles field. When another output
      // provides it, validate it as well rather than ignoring it.
      references.push(
        ...output.imports,
        ...output.dynamicImports,
        ...(output.referencedFiles ?? []),
      );
    }
    for (const name of references) {
      validateAssetPath(name);
      if (!files.has(name)) {
        throw new Error(`Missing or external event dependency: ${name}`);
      }
    }
  }
}
