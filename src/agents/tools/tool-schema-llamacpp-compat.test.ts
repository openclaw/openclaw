import { normalizeToolParameterSchema } from "@openclaw/ai/internal/openai";
// Guards model-facing tool schemas against constructs that llama.cpp's
// JSON-schema -> GBNF grammar converter rejects (issue #108580). Canonical tool
// schemas keep server-side validation guidance; llama.cpp projection strips the
// incompatible keywords through provider-owned normalizeToolSchemas hooks or the
// explicit toolSchemaProfile: "llamacpp" compatibility opt-in.
import { describe, expect, it } from "vitest";
import { normalizeLlamacppGbnfToolSchemas } from "../../plugin-sdk/provider-tools.js";
import type { AnyAgentTool } from "./common.js";
import { createCronTool } from "./cron-tool.js";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import { createSessionsListTool } from "./sessions-list-tool.js";
import { createSessionsSearchTool } from "./sessions-search-tool.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";
import { createTaskSuggestionTools } from "./task-suggestion-tools.js";

const LLAMACPP_MAX_REPETITION_THRESHOLD = 2000;
const PCRE_SHORTHAND_ESCAPE = /\\[dDwWsSbB]/;

const SCHEMA_MAP_KEYS = new Set([
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
]);

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
  }
}

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

function propertyAt(
  schema: Record<string, unknown>,
  path: string,
): Record<string, unknown> | undefined {
  let cursor: Record<string, unknown> | undefined = schema;
  for (const segment of path.split(".")) {
    const props = cursor?.["properties"] as Record<string, Record<string, unknown>> | undefined;
    cursor = props?.[segment];
  }
  return cursor;
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

  it("canonical raw tool schemas retain server-side validation constraints", () => {
    const cron = tools.find((tool) => tool.name === "cron");
    expect(cron).toBeDefined();
    const cronSchema = cron!.parameters as Record<string, unknown>;

    expect(propertyAt(cronSchema, "job.trigger.script")).toMatchObject({
      type: "string",
      minLength: 1,
      maxLength: 65_536,
    });

    const spawnTask = tools.find((tool) => tool.name === "spawn_task");
    expect(spawnTask).toBeDefined();
    const spawnSchema = spawnTask!.parameters as {
      properties?: { prompt?: Record<string, unknown>; cwd?: Record<string, unknown> };
    };
    expect(spawnSchema.properties?.prompt).toMatchObject({ maxLength: 32_768 });
    expect(spawnSchema.properties?.cwd).toMatchObject({ maxLength: 4_096 });

    const sessionsSearch = tools.find((tool) => tool.name === "sessions_search");
    expect(sessionsSearch).toBeDefined();
    const searchSchema = sessionsSearch!.parameters as {
      properties?: { query?: Record<string, unknown> };
    };
    expect(searchSchema.properties?.query).toMatchObject({ maxLength: 4_096 });
  });

  it("llama.cpp provider-hook projection carries no GBNF-breaking pattern or maxLength", () => {
    const projectedTools = normalizeLlamacppGbnfToolSchemas({
      provider: "ollama",
      modelId: "llama3.2",
      tools,
    } as never);
    const violations: string[] = [];
    for (const tool of projectedTools) {
      collectGbnfViolations(tool.parameters, tool.name, violations);
    }
    expect(violations).toEqual([]);
  });

  it("explicit llamacpp profile projection carries no GBNF-breaking pattern or maxLength", () => {
    const violations: string[] = [];
    for (const tool of tools) {
      const projected = normalizeToolParameterSchema(tool.parameters, {
        modelCompat: { toolSchemaProfile: "llamacpp" },
      });
      collectGbnfViolations(projected, tool.name, violations);
    }
    expect(violations).toEqual([]);
  });

  it("openai projection keeps canonical constraints intact", () => {
    const cron = tools.find((tool) => tool.name === "cron");
    expect(cron).toBeDefined();
    const projected = normalizeToolParameterSchema(cron!.parameters, {
      modelProvider: "openai",
    }) as Record<string, unknown>;
    expect(propertyAt(projected, "job.trigger.script")).toMatchObject({
      maxLength: 65_536,
    });
  });
});
