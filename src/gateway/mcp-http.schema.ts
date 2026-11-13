import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { logWarn } from "../logger.js";
import {
  findToolInputSchemaTopLevelUnionError,
  TOOL_INPUT_SCHEMA_TOP_LEVEL_UNION_KEYWORDS,
} from "../shared/json-schema-defaults.js";
import { mergeLiteralSchemas } from "../shared/json-schema-literals.js";
import type { resolveGatewayScopedTools } from "./tool-resolution.js";

const MCP_LOOPBACK_LOG_PREFIX = "mcp-loopback";

export type McpLoopbackTool = Awaited<
  ReturnType<typeof resolveGatewayScopedTools>
>["tools"][number];

export type McpToolSchemaEntry = {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
};

export function readMcpLoopbackToolName(tool: McpLoopbackTool): string | undefined {
  return normalizeOptionalString(tool.name);
}

function readLoopbackToolParameters(tool: McpLoopbackTool): Record<string, unknown> | undefined {
  let value;
  try {
    value = tool.parameters;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) {
    return {};
  }
  try {
    return { ...value };
  } catch {
    return undefined;
  }
}

// MCP clients vary in union-schema support. Merge only safe object variants and
// report the ones that cannot merge, so generated forms stay usable and a lost
// constraint is never silent. Returns one required-key set per merged variant.
function mergeVariantsIntoProperties(
  variants: readonly unknown[],
  toolName: string,
  mergedProps: Record<string, boolean | Record<string, unknown>>,
): Set<string>[] {
  const requiredSets: Set<string>[] = [];
  for (const variant of variants) {
    if (variant === true) {
      requiredSets.push(new Set());
      continue;
    }
    if (!isRecord(variant)) {
      continue;
    }
    const props = isRecord(variant.properties) ? variant.properties : undefined;
    if (props) {
      for (const [key, schema] of Object.entries(props)) {
        if (!isPropertySchema(schema)) {
          warnSchemaOnce(
            `${MCP_LOOPBACK_LOG_PREFIX}: malformed schema definition for "${toolName}.${key}", ignoring that variant`,
          );
          continue;
        }
        if (!Object.hasOwn(mergedProps, key)) {
          mergedProps[key] = schema;
          continue;
        }
        const existing = mergedProps[key]!;
        if (existing === true || schema === true) {
          mergedProps[key] = true;
          continue;
        }
        if (existing === false) {
          mergedProps[key] = schema;
          continue;
        }
        if (schema === false) {
          continue;
        }
        if (isDeepStrictEqual(existing, schema, { skipPrototype: true })) {
          continue;
        }
        // A prior const merge becomes an enum. Treat both as one literal family
        // so later union variants cannot silently disappear based on ordering.
        const mergedLiterals = mergeLiteralSchemas(existing, schema);
        if (mergedLiterals) {
          mergedProps[key] = mergedLiterals;
          continue;
        }
        warnSchemaOnce(
          `${MCP_LOOPBACK_LOG_PREFIX}: conflicting schema definitions for "${toolName}.${key}", keeping the first variant`,
        );
      }
    }
    requiredSets.push(
      new Set(Array.isArray(variant.required) ? (variant.required as string[]) : []),
    );
  }
  return requiredSets;
}

function readSchemaVariants(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function hasTopLevelUnion(schema: Record<string, unknown>): boolean {
  return TOOL_INPUT_SCHEMA_TOP_LEVEL_UNION_KEYWORDS.some((keyword) =>
    Object.hasOwn(schema, keyword),
  );
}

// `type` lists the JSON types a value may take, so a conjunction keeps only the
// types both sides allow; an empty result admits nothing at all.
function readTypeNames(value: unknown): Set<string> | undefined {
  if (typeof value === "string") {
    return new Set([value]);
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return new Set(value as string[]);
  }
  return undefined;
}

function intersectTypeKeyword(left: unknown, right: unknown): unknown {
  const leftNames = readTypeNames(left);
  const rightNames = readTypeNames(right);
  if (!leftNames || !rightNames) {
    return undefined;
  }
  const kept = [...leftNames].filter((name) => rightNames.has(name));
  if (kept.length === 0) {
    return undefined;
  }
  return kept.length === 1 ? kept[0] : kept;
}

function intersectEnumKeyword(left: unknown, right: unknown): unknown {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return undefined;
  }
  const kept = left.filter((value) =>
    right.some((candidate) => isDeepStrictEqual(candidate, value, { skipPrototype: true })),
  );
  return kept.length > 0 ? kept : undefined;
}

// A `const` already pins the value, so an enum alongside it is redundant when it
// admits that value and unsatisfiable when it does not.
function normalizeLiteralKeywords(
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (!Object.hasOwn(schema, "const") || !Array.isArray(schema.enum)) {
    return schema;
  }
  const admitted = schema.enum.some((value) =>
    isDeepStrictEqual(value, schema.const, { skipPrototype: true }),
  );
  if (!admitted) {
    return undefined;
  }
  const { enum: _enum, ...rest } = schema;
  return rest;
}

// Structural inequality is not proof that an intersection is unrepresentable: a
// `true` branch admits everything, keywords only one side constrains are
// additive, and `type`/`enum` narrow to their intersection. Returns undefined
// only when no single flat schema can carry both constraints exactly.
function intersectPropertySchemas(
  left: boolean | Record<string, unknown>,
  right: boolean | Record<string, unknown>,
): boolean | Record<string, unknown> | undefined {
  if (left === true) {
    return right;
  }
  if (right === true) {
    return left;
  }
  if (left === false || right === false) {
    return false;
  }
  if (isDeepStrictEqual(left, right, { skipPrototype: true })) {
    return left;
  }
  const merged: Record<string, unknown> = { ...left };
  for (const [keyword, value] of Object.entries(right)) {
    if (!Object.hasOwn(merged, keyword)) {
      merged[keyword] = value;
      continue;
    }
    const existing = merged[keyword];
    if (isDeepStrictEqual(existing, value, { skipPrototype: true })) {
      continue;
    }
    const narrowed =
      keyword === "type"
        ? intersectTypeKeyword(existing, value)
        : keyword === "enum"
          ? intersectEnumKeyword(existing, value)
          : undefined;
    if (narrowed === undefined) {
      return undefined;
    }
    merged[keyword] = narrowed;
  }
  return normalizeLiteralKeywords(merged);
}

// Root properties, each allOf branch, and each sibling union keyword all hold at
// once, so a key constrained on both sides of such a boundary keeps the exact
// intersection when one object schema can express it. Only a genuinely
// unrepresentable overlap withholds the tool. Alternatives within one keyword
// stay on the keep-first-and-warn contract instead.
function combineConjunctiveProps(
  target: Record<string, boolean | Record<string, unknown>>,
  source: Record<string, boolean | Record<string, unknown>>,
  toolName: string,
): boolean {
  for (const [key, schema] of Object.entries(source)) {
    if (!Object.hasOwn(target, key)) {
      target[key] = schema;
      continue;
    }
    const intersected = intersectPropertySchemas(target[key]!, schema);
    if (intersected === undefined) {
      warnSchemaOnce(
        `${MCP_LOOPBACK_LOG_PREFIX}: tool "${toolName}" input schema constrains "${key}" differently across combined top-level schemas; skipping the tool instead of publishing a weakened constraint`,
      );
      return false;
    }
    target[key] = intersected;
  }
  return true;
}

// Keywords this flattener either folds into the published object schema or that
// only document it. Anything else on a branch is a real constraint the single
// flat schema would silently drop.
const FLATTENED_BRANCH_KEYWORDS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "$comment",
  "default",
  "deprecated",
  "description",
  "example",
  "examples",
  "readOnly",
  "title",
  "writeOnly",
]);

function findUnsupportedBranchKeyword(branch: Record<string, unknown>): string | undefined {
  return Object.keys(branch).find((keyword) => !FLATTENED_BRANCH_KEYWORDS.has(keyword));
}

function branchTypeAdmitsObject(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  const names = readTypeNames(value);
  return names ? names.has("object") : false;
}

// An `additionalProperties` other than `true` restricts the keys of the conjunct
// that declares it, so the flattened object can republish it only when no other
// combined schema contributed a key that conjunct does not list.
type ClosedConjunct = {
  readonly label: string;
  readonly value: unknown;
  readonly keys: ReadonlySet<string>;
};

function readClosedConjunct(
  schema: Record<string, unknown>,
  label: string,
  keys: readonly string[],
): ClosedConjunct | undefined {
  const value = schema.additionalProperties;
  if (value === undefined || value === true) {
    return undefined;
  }
  return { label, value, keys: new Set(keys) };
}

function resolveAdditionalProperties(
  conjuncts: readonly ClosedConjunct[],
  mergedKeys: readonly string[],
  toolName: string,
): { readonly published: unknown } | undefined {
  let published: unknown;
  for (const conjunct of conjuncts) {
    const foreign = mergedKeys.find((key) => !conjunct.keys.has(key));
    if (foreign !== undefined) {
      warnSchemaOnce(
        `${MCP_LOOPBACK_LOG_PREFIX}: tool "${toolName}" closes ${conjunct.label} to additional properties while another combined schema contributes "${foreign}"; skipping the tool instead of publishing a weakened constraint`,
      );
      return undefined;
    }
    if (conjunct.value === false || published === false) {
      published = false;
      continue;
    }
    if (published === undefined || isDeepStrictEqual(published, conjunct.value)) {
      published = conjunct.value;
      continue;
    }
    warnSchemaOnce(
      `${MCP_LOOPBACK_LOG_PREFIX}: tool "${toolName}" input schema constrains "additionalProperties" differently across combined top-level schemas; skipping the tool instead of publishing a weakened constraint`,
    );
    return undefined;
  }
  return { published };
}

// Collapses every top-level union keyword into the single object schema native
// tool definitions require. `anyOf`/`oneOf` branches are alternatives, so only a
// key required by every branch stays required; `allOf` branches all hold, so
// their required keys are added. Sibling `properties`/`required` on the root are
// kept rather than replaced, and an empty union list is reported instead of
// being left in place for the provider to reject. Branch-level constraints are
// carried over where one flat object can express them. Returns undefined when a
// conjunct makes every flattening lossy; the caller skips the tool.
function flattenTopLevelUnionSchema(
  raw: Record<string, unknown>,
  toolName: string,
): Record<string, unknown> | undefined {
  const mergedProps = Object.create(null) as Record<string, boolean | Record<string, unknown>>;
  if (isRecord(raw.properties)) {
    for (const [key, schema] of Object.entries(raw.properties)) {
      if (isPropertySchema(schema)) {
        mergedProps[key] = schema;
      }
    }
  }
  // SAFETY: JSON Schema `required` is a string list; this mirrors the variant read above.
  const required = new Set<string>(Array.isArray(raw.required) ? (raw.required as string[]) : []);
  const closedConjuncts: ClosedConjunct[] = [];
  const rootClosure = readClosedConjunct(raw, "the root schema", Object.keys(mergedProps));
  if (rootClosure) {
    closedConjuncts.push(rootClosure);
  }
  for (const keyword of TOOL_INPUT_SCHEMA_TOP_LEVEL_UNION_KEYWORDS) {
    const variants = readSchemaVariants(raw[keyword]);
    if (!variants || variants.length > 0) {
      continue;
    }
    warnSchemaOnce(
      `${MCP_LOOPBACK_LOG_PREFIX}: dropping empty top-level "${keyword}" for "${toolName}", native tool schemas reject it`,
    );
  }
  // Sibling anyOf and oneOf apply together, so each keyword's alternatives decide
  // their own required keys instead of pooling branches into one alternative set.
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const alternatives = readSchemaVariants(raw[keyword]) ?? [];
    if (alternatives.length === 0) {
      continue;
    }
    for (const alternative of alternatives) {
      const dropped = isRecord(alternative) ? findUnsupportedBranchKeyword(alternative) : undefined;
      if (dropped) {
        // Alternatives keep the established keep-first publishing contract, so
        // report the dropped branch constraint rather than withholding the tool.
        warnSchemaOnce(
          `${MCP_LOOPBACK_LOG_PREFIX}: tool "${toolName}" has a "${keyword}" alternative constraining "${dropped}", which the flattened object schema does not carry`,
        );
      }
    }
    // SAFETY: fresh null-prototype map; mergeVariantsIntoProperties validates every entry.
    const groupProps = Object.create(null) as Record<string, boolean | Record<string, unknown>>;
    const requiredSets = mergeVariantsIntoProperties(alternatives, toolName, groupProps);
    if (!combineConjunctiveProps(mergedProps, groupProps, toolName)) {
      return undefined;
    }
    for (const key of requiredSets[0] ?? []) {
      if (requiredSets.every((set) => set.has(key))) {
        required.add(key);
      }
    }
  }
  // Every allOf branch holds on every instance, so a branch keyword this
  // flattener does not fold in is a real constraint the published schema would
  // lose. Withhold the tool by name instead of advertising a weaker definition.
  for (const branch of readSchemaVariants(raw.allOf) ?? []) {
    if (branch === true) {
      continue;
    }
    if (!isRecord(branch)) {
      warnSchemaOnce(
        `${MCP_LOOPBACK_LOG_PREFIX}: tool "${toolName}" has an allOf branch that is not an object schema; skipping the tool instead of publishing a weakened constraint`,
      );
      return undefined;
    }
    if (!branchTypeAdmitsObject(branch.type)) {
      warnSchemaOnce(
        `${MCP_LOOPBACK_LOG_PREFIX}: tool "${toolName}" has an allOf branch whose "type" excludes objects; skipping the tool instead of publishing a weakened constraint`,
      );
      return undefined;
    }
    const unsupported = findUnsupportedBranchKeyword(branch);
    if (unsupported) {
      warnSchemaOnce(
        `${MCP_LOOPBACK_LOG_PREFIX}: tool "${toolName}" has an allOf branch constraining "${unsupported}", which one flattened object schema cannot express; skipping the tool instead of publishing a weakened constraint`,
      );
      return undefined;
    }
    // SAFETY: fresh null-prototype map; mergeVariantsIntoProperties validates every entry.
    const branchProps = Object.create(null) as Record<string, boolean | Record<string, unknown>>;
    const requiredSets = mergeVariantsIntoProperties([branch], toolName, branchProps);
    if (!combineConjunctiveProps(mergedProps, branchProps, toolName)) {
      return undefined;
    }
    const branchClosure = readClosedConjunct(branch, "an allOf branch", Object.keys(branchProps));
    if (branchClosure) {
      closedConjuncts.push(branchClosure);
    }
    for (const set of requiredSets) {
      for (const key of set) {
        required.add(key);
      }
    }
  }
  const additional = resolveAdditionalProperties(
    closedConjuncts,
    Object.keys(mergedProps),
    toolName,
  );
  if (!additional) {
    return undefined;
  }
  const { allOf: _allOf, anyOf: _anyOf, oneOf: _oneOf, ...rest } = raw;
  const flattened: Record<string, unknown> = {
    ...rest,
    type: "object",
    properties: mergedProps,
    required: [...required].filter((key) => Object.hasOwn(mergedProps, key)),
  };
  if (additional.published !== undefined) {
    flattened.additionalProperties = additional.published;
  }
  return flattened;
}

function isPropertySchema(value: unknown): value is boolean | Record<string, unknown> {
  return typeof value === "boolean" || isRecord(value);
}

// Deduplicate by tool, field, and reason across per-session schema cache misses.
// Tool metadata stays stable until restart or explicit reload.
const emittedSchemaWarnings = new Set<string>();

function warnSchemaOnce(message: string) {
  if (emittedSchemaWarnings.has(message)) {
    return;
  }
  emittedSchemaWarnings.add(message);
  logWarn(message);
}

export function buildMcpToolSchema(tools: McpLoopbackTool[]): McpToolSchemaEntry[] {
  return tools.flatMap((tool) => {
    const name = readMcpLoopbackToolName(tool);
    if (!name) {
      return [];
    }
    let raw = readLoopbackToolParameters(tool);
    if (!raw) {
      return [];
    }
    if (hasTopLevelUnion(raw)) {
      const flattened = flattenTopLevelUnionSchema(raw, name);
      if (!flattened) {
        // A conjunctive overlap means no single object schema can keep every
        // constraint. Skip the tool with the warning above instead of failing
        // the whole catalog build mid run preparation.
        return [];
      }
      raw = flattened;
    }
    if (raw.type !== "object") {
      raw.type = "object";
    }
    if (!raw.properties) {
      raw.properties = {};
    }
    // Publish-boundary invariant: the flatten above removes every top-level union
    // keyword, and a schema carrying one past this point is rejected by native
    // tool definitions as an opaque request-wide 400 that names only a tool index.
    // Fail here, where the tool is named, rather than at the provider.
    const unionError = findToolInputSchemaTopLevelUnionError(raw, name);
    if (unionError) {
      throw new Error(`${MCP_LOOPBACK_LOG_PREFIX}: ${unionError}`);
    }
    return {
      name,
      description: typeof tool.description === "string" ? tool.description : undefined,
      inputSchema: raw,
    };
  });
}
