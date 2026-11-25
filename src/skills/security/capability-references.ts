import { expectDefined } from "@openclaw/normalization-core";
import { escapeRegExp } from "../../shared/regexp.js";

const IDENT = String.raw`[A-Za-z_$][\w$]*`;
// A name, optionally with one `.member` or `["member"]` access.
const REFERENCE = String.raw`${IDENT}(?:\s*\.\s*${IDENT}|\s*\[\s*["']${IDENT}["']\s*\])?`;
// The reference must end the expression: `x = mod.exec` binds, `x = mod.exec(...)` does not.
const REFERENCE_END = String.raw`(?![\w$])(?!\s*[.[(\`])`;
const ASSIGNED_REFERENCE = String.raw`=(?![=>])\s*(?:await\s+)?(${REFERENCE})${REFERENCE_END}`;
const NAME_ASSIGNMENT = new RegExp(String.raw`(?<![\w$.])(${IDENT})\s*${ASSIGNED_REFERENCE}`, "g");
const TYPED_NAME_ASSIGNMENT = new RegExp(
  String.raw`\b(?:const|let|var)\s+(${IDENT})\s*:[^=;{}()]{1,120}?${ASSIGNED_REFERENCE}`,
  "g",
);
const MEMBER_ASSIGNMENT = new RegExp(
  String.raw`(?:\.\s*(${IDENT})|\[\s*["'](${IDENT})["']\s*\])\s*${ASSIGNED_REFERENCE}`,
  "g",
);
const DESTRUCTURING = new RegExp(String.raw`\{([^{}]*)\}\s*${ASSIGNED_REFERENCE}`, "g");
const OBJECT_ENTRY = new RegExp(
  String.raw`(?<=[{,]\s*)(?:(${IDENT})|["'](${IDENT})["']|\[\s*["'](${IDENT})["']\s*\])\s*:\s*(${REFERENCE})${REFERENCE_END}(?=\s*[,}])|(?<=[{,]\s*)(${IDENT})(?=\s*[,}])`,
  "g",
);

// `require(...)`, `import(...)` and `import x = require(...)` whose argument holds a
// child_process string literal, e.g. `require(["child_process"][0])`.
const CHILD_PROCESS_MODULE_CALL = String.raw`(?:require|import)\s*\(\s*[^()]{0,80}?["'\`](?:node:)?child_process["'\`][^()]{0,80}?\)`;
const CHILD_PROCESS_MODULE_CALLS = new RegExp(CHILD_PROCESS_MODULE_CALL, "g");
const CHILD_PROCESS_IMPORTS =
  /\bimport\s*([^;'"]{1,500}?)\s*from\s*["'](?:node:)?child_process["']/g;
export const ENDS_WITH_CHILD_PROCESS_MODULE_CALL = new RegExp(
  String.raw`${CHILD_PROCESS_MODULE_CALL}\s*$`,
);
// Stands for the child_process module object while bindings are collected.
export const CHILD_PROCESS_MODULE = "$child_process$";

export type CapabilityReferenceSpec = {
  /** Skip binding analysis unless the source mentions the capability. */
  context: RegExp;
  /** Global names holding the capability; the rule pattern reports their direct calls. */
  values: readonly string[];
  /** Objects whose `members` are the capability. */
  namespaces: readonly string[];
  members: ReadonlySet<string>;
};

/** `target` receives `source` (`name` or `name.member`); member targets are property names. */
export type BindingEdge = { target: string; member: boolean; source: string };

type CapabilityReferences = {
  namespaces: Set<string>;
  /** Matches calls through derived bindings; reports the callee or member start. */
  calls: RegExp;
};

function normalizeReference(reference: string): string {
  return reference.replace(/\s+/g, "").replace(/\[["']([^"']+)["']\]/, ".$1");
}

/**
 * Collects simple bindings for capability provenance. This is a bounded heuristic, not
 * JavaScript evaluation: a name bound to a capability anywhere counts in the whole file
 * (no block scope, shadowing, or later reassignment), references follow one member level,
 * and computed names, call/apply/bind, and cross-file flows are not followed.
 */
export function collectBindingEdges(source: string): BindingEdge[] {
  const analysisSource = source
    .replace(CHILD_PROCESS_IMPORTS, (_match, clause: string) => {
      const bindings = clause.match(
        new RegExp(String.raw`^(?:(${IDENT})\s*,?\s*)?(?:\*\s*as\s+(${IDENT})|(\{[^}]*\}))?$`),
      );
      return [bindings?.[1], bindings?.[2], bindings?.[3]]
        .filter(Boolean)
        .map((binding) => `${binding} = ${CHILD_PROCESS_MODULE};`)
        .join(" ");
    })
    .replace(CHILD_PROCESS_MODULE_CALLS, CHILD_PROCESS_MODULE);
  const edges: BindingEdge[] = [];
  const add = (target: string | undefined, member: boolean, reference: string | undefined) => {
    if (target && reference) {
      edges.push({ target, member, source: normalizeReference(reference) });
    }
  };
  for (const pattern of [NAME_ASSIGNMENT, TYPED_NAME_ASSIGNMENT]) {
    for (const match of analysisSource.matchAll(pattern)) {
      add(match[1], false, match[2]);
    }
  }
  for (const match of analysisSource.matchAll(MEMBER_ASSIGNMENT)) {
    add(match[1] ?? match[2], true, match[3]);
  }
  for (const match of analysisSource.matchAll(DESTRUCTURING)) {
    const object = normalizeReference(expectDefined(match[2], "destructured source"));
    if (object.includes(".")) {
      continue;
    }
    for (const rawSpec of expectDefined(match[1], "destructured specifiers").split(",")) {
      const spec = rawSpec.replace(/[=][\s\S]*$/, "").trim();
      const rest = spec.match(new RegExp(String.raw`^\.\.\.\s*(${IDENT})$`));
      if (rest) {
        add(rest[1], false, object);
        continue;
      }
      // `key`, `key: name`, `["key"]: name` (CJS) or `key as name` (ESM).
      const renamed = spec.match(
        new RegExp(
          String.raw`^(?:\[\s*)?["']?(${IDENT})["']?(?:\s*\])?(?:\s*(?::|\bas\b)\s*(${IDENT}))?$`,
        ),
      );
      if (renamed?.[1]) {
        add(renamed[2] ?? renamed[1], false, `${object}.${renamed[1]}`);
      }
    }
  }
  for (const match of analysisSource.matchAll(OBJECT_ENTRY)) {
    add(match[1] ?? match[2] ?? match[3] ?? match[5], true, match[4] ?? match[5]);
  }
  return edges;
}

// Follow bindings from the capability's global names and modules; unrelated names must not match.
export function resolveCapabilityReferences(
  edges: readonly BindingEdge[],
  spec: CapabilityReferenceSpec,
): CapabilityReferences {
  const values = new Set(spec.values);
  const namespaces = new Set(spec.namespaces);
  const storedMembers = new Set<string>();
  const edgesByName = new Map<string, BindingEdge[]>();
  const edgesByMember = new Map<string, BindingEdge[]>();
  const index = (map: Map<string, BindingEdge[]>, key: string, edge: BindingEdge) => {
    const list = map.get(key);
    if (list) {
      list.push(edge);
    } else {
      map.set(key, [edge]);
    }
  };
  for (const edge of edges) {
    const [name = "", member] = edge.source.split(".");
    index(edgesByName, name, edge);
    if (member) {
      index(edgesByMember, member, edge);
    }
  }
  const pending = [...values, ...namespaces].flatMap((name) => edgesByName.get(name) ?? []);
  for (let edge = pending.pop(); edge; edge = pending.pop()) {
    const [name = "", member] = edge.source.split(".");
    const isValue = member
      ? (namespaces.has(name) && spec.members.has(member)) || storedMembers.has(member)
      : values.has(name);
    if (edge.member) {
      // Watched members already have receiver-aware handling in the rule pattern.
      if (isValue && !spec.members.has(edge.target) && !storedMembers.has(edge.target)) {
        storedMembers.add(edge.target);
        pending.push(...(edgesByMember.get(edge.target) ?? []));
      }
      continue;
    }
    const bindings = isValue ? values : !member && namespaces.has(name) ? namespaces : undefined;
    if (bindings && !bindings.has(edge.target)) {
      bindings.add(edge.target);
      pending.push(...(edgesByName.get(edge.target) ?? []));
    }
  }

  const union = (names: Iterable<string>) => [...names].map(escapeRegExp).join("|");
  const calls: string[] = [];
  const aliases = [...values].filter((name) => !spec.values.includes(name));
  if (aliases.length > 0) {
    calls.push(String.raw`(?<![\w$.])(?:${union(aliases)})\s*\(`);
  }
  if (storedMembers.size > 0) {
    const stored = union(storedMembers);
    calls.push(String.raw`(?<=\.\s*)(?:${stored})\s*\(`);
    calls.push(String.raw`(?<=\[\s*)["'](?:${stored})["']\s*\]\s*\(`);
  }
  const receivers = union(namespaces);
  const members = union(spec.members);
  calls.push(String.raw`(?<=(?<![\w$.])(?:${receivers})\s*\.\s*)(?:${members})\s*\(`);
  calls.push(String.raw`(?<=(?<![\w$.])(?:${receivers})\s*\[\s*)["'](?:${members})["']\s*\]\s*\(`);
  return { namespaces, calls: new RegExp(calls.join("|"), "g") };
}
