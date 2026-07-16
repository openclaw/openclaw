import { normalizeToolParameterSchema } from "@openclaw/ai/internal/openai";
// Guards model-facing tool schemas against constructs that llama.cpp's
// JSON-schema -> GBNF grammar converter rejects (issue #108580). Because the
// whole active tool list compiles into one grammar, a single bad field 400s
// every request on a grammar-constrained backend, not just calls to that tool.
import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "./common.js";
import { createCronTool } from "./cron-tool.js";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import { createSessionsListTool } from "./sessions-list-tool.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";
import { createTaskSuggestionTools } from "./task-suggestion-tools.js";

// llama.cpp compiles a bounded `maxLength` into repeated grammar rules and caps
// the repetition count at MAX_REPETITION_THRESHOLD (2000 in src/llama-grammar.cpp);
// anything larger fails GBNF compilation ("number of repetitions exceeds sane
// defaults"). Keep this named so a future ceiling change is a one-line edit.
const LLAMACPP_MAX_REPETITION_THRESHOLD = 2000;

// llama.cpp's regex->GBNF converter only understands a small set of literal
// escapes; PCRE shorthand character classes (\s \S \d \D \w \W \b \B) are
// rejected as unknown escapes, so no pattern reaching the model may use them.
const PCRE_SHORTHAND_ESCAPE = /\\[dDwWsSbB]/;

// JSON Schema keywords whose value is a map of name -> subschema.
const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

// JSON Schema keywords whose value is a subschema or an array of subschemas.
const SCHEMA_CHILD_KEYS = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "additionalProperties",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "unevaluatedProperties",
  "anyOf",
  "oneOf",
  "allOf",
]);

/**
 * Collects llama.cpp GBNF-incompatible constructs (unanchored or PCRE-shorthand
 * `pattern`, oversized `maxLength`) reachable in a tool's JSON Schema. Recurses
 * only through structural schema positions so data literals under `enum`,
 * `const`, `default`, or `examples` (which may legitimately hold a key named
 * "pattern" or "maxLength") never trigger a false positive.
 */
function collectGbnfViolations(node: unknown, path: string, out: string[]): void {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((entry, index) => collectGbnfViolations(entry, `${path}[${index}]`, out));
    return;
  }

  const record = node as Record<string, unknown>;

  const pattern = record.pattern;
  if (typeof pattern === "string") {
    if (!pattern.startsWith("^") || !pattern.endsWith("$")) {
      out.push(`${path}.pattern is not fully anchored (^...$): ${JSON.stringify(pattern)}`);
    }
    if (PCRE_SHORTHAND_ESCAPE.test(pattern)) {
      out.push(`${path}.pattern uses PCRE shorthand escapes: ${JSON.stringify(pattern)}`);
    }
  }

  const maxLength = record.maxLength;
  if (typeof maxLength === "number" && maxLength > LLAMACPP_MAX_REPETITION_THRESHOLD) {
    out.push(
      `${path}.maxLength ${maxLength} exceeds llama.cpp repetition ceiling ${LLAMACPP_MAX_REPETITION_THRESHOLD}`,
    );
  }

  for (const [key, value] of Object.entries(record)) {
    if (SCHEMA_MAP_KEYS.has(key)) {
      if (value && typeof value === "object" && !Array.isArray(value)) {
        for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
          collectGbnfViolations(childValue, `${path}.${key}.${childKey}`, out);
        }
      }
      continue;
    }
    if (SCHEMA_CHILD_KEYS.has(key)) {
      collectGbnfViolations(value, `${path}.${key}`, out);
    }
    // Every other key (type, enum, const, default, examples, description,
    // minLength, and the already-checked pattern/maxLength) is a leaf or data
    // value — do not recurse, so literals never masquerade as constraints.
  }
}

/**
 * Model-facing tools whose parameters are hand-authored TypeBox schemas that
 * reach a grammar-constrained backend verbatim. New tools in this family (cron,
 * task suggestions, sessions) should be added here so the GBNF guard covers them.
 */
function createModelFacingToolInventory(): AnyAgentTool[] {
  return [
    createCronTool(),
    ...createTaskSuggestionTools({
      sessionKey: "agent:main:main",
      agentId: "main",
      cwd: "/tmp/openclaw-llamacpp-compat",
    }),
    createSessionsSearchTool(),
    createSessionsListTool(),
    createSessionsSendTool(),
    createSessionsHistoryTool(),
  ];
}

describe("model-facing tool schemas stay llama.cpp GBNF-compatible", () => {
  const tools = createModelFacingToolInventory();

  it("materializes the llama.cpp-sensitive tools (guards against a vacuous pass)", () => {
    const names = new Set(tools.map((tool) => tool.name));
    for (const name of [
      "cron",
      "spawn_task",
      "dismiss_task",
      "sessions_search",
      "sessions_list",
      "sessions_send",
    ]) {
      expect(names.has(name), `expected tool "${name}" in the inventory`).toBe(true);
    }
  });

  it("raw tool parameter schemas carry no GBNF-breaking pattern or maxLength", () => {
    const violations: string[] = [];
    for (const tool of tools) {
      collectGbnfViolations(tool.parameters, tool.name, violations);
    }
    expect(violations).toEqual([]);
  });

  it("openai-normalized tool schemas carry no GBNF-breaking pattern or maxLength", () => {
    // llama.cpp servers speak the OpenAI-compatible chat API; that provider path
    // does not strip pattern/maxLength, so walk the normalized shape too in case
    // $ref inlining or union flattening ever reintroduces a violation unseen.
    const violations: string[] = [];
    for (const tool of tools) {
      const normalized = normalizeToolParameterSchema(tool.parameters, { modelProvider: "openai" });
      collectGbnfViolations(normalized, tool.name, violations);
    }
    expect(violations).toEqual([]);
  });
});
