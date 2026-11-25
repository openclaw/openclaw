import { normalizeToolParameterSchema } from "@openclaw/ai/internal/tool-schema";
import { validateToolArguments } from "@openclaw/llm-core/validation";
import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../../packages/ai/src/host.js";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";
import { inspectOpenDictionaryToolSchemas } from "../plugins/tool-schema-diagnostics.js";
import { freezeJsonSnapshot } from "../shared/immutable-data.js";
import {
  buildProviderToolCompatFamilyHooks,
  inspectDeepSeekToolSchemas,
  findOpenAIStrictSchemaViolations,
  inspectGeminiToolSchemas,
  normalizeDeepSeekToolSchemas,
} from "./provider-tools.js";
import { openRecord } from "./tool-plugin.js";

it("preserves truncation when a provider rewrites a sibling union", () => {
  const definitions: Record<string, unknown> = { leaf: { type: "string" } };
  let target = "leaf";
  for (let depth = 0; depth < 5000; depth++) {
    const name = `node${depth}`;
    definitions[name] = { $ref: `#/$defs/${target}` };
    target = name;
  }
  const parameters = normalizeToolParameterSchema({
    type: "object",
    properties: {
      value: { $ref: `#/$defs/${target}` },
      choice: stringUnion("a", "b"),
    },
    required: ["value", "choice"],
    additionalProperties: false,
    $defs: definitions,
  });
  const rewritten = expectDefined(
    normalizeDeepSeekToolSchemas(deepSeekContext([tool(parameters)]))[0],
    "rewritten tool",
  );
  expect(rewritten.parameters).toMatchObject({
    properties: { value: {}, choice: { enum: ["a", "b"] } },
  });
  expect(findOpenAIStrictSchemaViolations(rewritten.parameters, "tool.parameters")).toEqual([
    "tool.parameters.depth",
  ]);
});
type ProviderContextOptions = {
  provider?: string;
  modelId?: string;
  modelApi?: string;
  baseUrl?: string | null;
};

function tool(parameters: unknown, name = "demo") {
  return { name, description: "", parameters } as never;
}

function objectSchema(properties: Record<string, unknown>, overrides = {}) {
  return { type: "object", properties, ...overrides };
}

const string = { type: "string" };
const stringUnion = (...values: string[]) => ({
  anyOf: values.map((value) => ({ const: value, type: "string" })),
});
const objectVariant = (properties: Record<string, unknown>, required: string[], overrides = {}) =>
  objectSchema(properties, { required, additionalProperties: false, ...overrides });

function providerContext(tools: never[], options: ProviderContextOptions = {}) {
  const provider = options.provider ?? "openai";
  const modelId = options.modelId ?? "gpt-5.4";
  const modelApi = options.modelApi ?? "openai-responses";
  const baseUrl = options.baseUrl === undefined ? "https://api.openai.com/v1" : options.baseUrl;
  return {
    provider,
    modelId,
    modelApi,
    model: {
      provider,
      api: modelApi,
      ...(baseUrl ? { baseUrl } : {}),
      id: modelId,
    } as never,
    tools,
  };
}

const openAIHooks = buildProviderToolCompatFamilyHooks("openai");

it("normalizes a frozen schema once across requests while keeping the current tool and route", () => {
  const parameters = freezeJsonSnapshot(objectSchema({ payload: { type: "object" } }));
  const first = normalizeOpenAITools([tool(parameters)])[0]!;
  const expected = objectSchema({ payload: objectVariant({}, []) });
  expect(first.parameters).toEqual(expected);
  using entries = vi.spyOn(Object, "entries");
  for (let request = 0; request < 10; request++) {
    const name = `tool_${request}`;
    const execute = async () => ({ content: [], details: request });
    const current = Object.assign(tool(parameters, name), { execute });
    const next = normalizeOpenAITools([current])[0]!;
    expect(next.parameters).toBe(first.parameters);
    expect(next.name).toBe(name);
    expect(next.execute).toBe(execute);
    expect(JSON.stringify(next.parameters)).toBe(JSON.stringify(expected));
    expect(normalizeOpenAITools([current], { baseUrl: "https://proxy.example/v1" })[0]).toBe(
      current,
    );
  }
  expect(entries.mock.calls.filter(([source]) => source === parameters)).toHaveLength(0);
});

it.each(["mutable", "shallow-frozen", "accessor"])(
  "rechecks %s schemas when their contents change",
  (kind) => {
    const properties = { payload: { type: "object" } };
    const parameters =
      kind === "accessor"
        ? Object.freeze({
            type: "object",
            get properties() {
              return properties;
            },
          })
        : { type: "object", properties };
    if (kind === "shallow-frozen") {
      Object.freeze(parameters);
    }
    const before = normalizeOpenAITools([tool(parameters)])[0]!;
    properties.payload = { type: "string" };
    expect(normalizeOpenAITools([tool(parameters)])[0]?.parameters).toEqual(
      objectSchema({ payload: { type: "string" } }),
    );
    expect(before.parameters).toEqual(objectSchema({ payload: objectVariant({}, []) }));
  },
);

it("keeps depth warnings bound to each tool name when a frozen schema is reused", () => {
  let schema = objectSchema({});
  for (let depth = 0; depth < 150; depth++) {
    schema = objectSchema({ nested: schema });
  }
  const parameters = freezeJsonSnapshot(schema);
  const logWarn = vi.fn();
  configureAiTransportHost({ logWarn });
  try {
    for (const name of ["first", "second", "first", "second"]) {
      normalizeOpenAITools([tool(parameters, name)]);
    }
    expect(logWarn).toHaveBeenCalledTimes(2);
    expect(logWarn.mock.calls.map((call) => call[1])).toEqual([
      expect.stringContaining('Tool "first"'),
      expect.stringContaining('Tool "second"'),
    ]);
  } finally {
    configureAiTransportHost({});
  }
});

function normalizeOpenAITools(tools: never[], options?: ProviderContextOptions) {
  return openAIHooks.normalizeToolSchemas(providerContext(tools, options));
}

function inspectOpenAITools(tools: never[], options?: ProviderContextOptions) {
  return openAIHooks.inspectToolSchemas(providerContext(tools, options));
}

function deepSeekContext(tools: never[]) {
  return providerContext(tools, {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
    modelApi: "openai-completions",
    baseUrl: null,
  });
}

function normalizeDeepSeek(parameters: unknown, name = "demo") {
  return normalizeDeepSeekToolSchemas(deepSeekContext([tool(parameters, name)]));
}

function validateDeepSeekTool(
  normalized: ReturnType<typeof normalizeDeepSeekToolSchemas>,
  args: Record<string, unknown>,
) {
  const normalizedTool = expectDefined(normalized[0], "normalized DeepSeek tool");
  return validateToolArguments(normalizedTool, {
    type: "toolCall",
    id: "call-deepseek-probe",
    name: normalizedTool.name,
    arguments: args,
  });
}

it("keeps schema helpers outside eager AI transports", () => {
  expect(
    findSourceImportBackedges("src/plugin-sdk/provider-tools.ts", [
      "packages/ai/src/providers/azure-openai-responses.ts",
      "packages/ai/src/providers/openai-completions.ts",
      "packages/ai/src/providers/openai-responses.ts",
      "packages/ai/src/transports/openai-completions-transport.ts",
      "packages/ai/src/transports/openai-responses-transport.ts",
    ]),
  ).toEqual([]);
});

it("removes llama.cpp GBNF-hostile constraints from nested tool schemas", () => {
  const hooks = buildProviderToolCompatFamilyHooks("llamacpp-gbnf");
  const cronSchema = (declarationKey: object, script: object, boundary: object) =>
    objectSchema({
      job: objectSchema({
        declarationKey,
        trigger: { anyOf: [objectSchema({ script, boundary }), { type: "null" }] },
      }),
    });
  const tools = [
    tool(
      cronSchema(
        { ...string, maxLength: 1999, pattern: "^\\S+$" },
        { ...string, minLength: 1, maxLength: 65_536 },
        { ...string, maxLength: 2000 },
      ),
      "cron",
    ),
  ];

  const normalized = hooks.normalizeToolSchemas({
    provider: "ollama",
    modelId: "qwen3.5",
    tools,
  });

  expect(normalized[0]?.parameters).toEqual(
    cronSchema(
      { type: "string", maxLength: 1999 },
      { type: "string", minLength: 1 },
      { type: "string" },
    ),
  );
  expect(hooks.inspectToolSchemas({ provider: "ollama", tools: normalized })).toEqual([]);
});

it.each(["gemini", "llamacpp-gbnf", "openai"] as const)(
  "retains a callable deep tool through the %s provider hooks",
  async (family) => {
    let parameters: unknown = { type: "string" };
    for (let depth = 0; depth < 5_000; depth++) {
      parameters = objectSchema({ nested: parameters });
    }
    const execute = async () => ({ content: [], details: { called: true } });
    const source = Object.assign(tool(parameters, "deep_tool"), { execute });
    const sibling = tool(objectSchema({}), "healthy_tool");
    const hooks = buildProviderToolCompatFamilyHooks(family);
    const context = providerContext([source, sibling]);

    expect(hooks.inspectToolSchemas(context)).toEqual([]);
    const normalized = hooks.normalizeToolSchemas(context);
    expect(normalized.map((entry) => entry.name)).toEqual(["deep_tool", "healthy_tool"]);
    const normalizedTool = expectDefined(normalized[0], "normalized deep tool");
    let leaf: unknown = normalizedTool.parameters;
    let levels = 0;
    while (isRecord(leaf) && isRecord(leaf.properties) && "nested" in leaf.properties) {
      leaf = leaf.properties.nested;
      levels++;
    }
    expect(levels).toBeGreaterThan(0);
    expect(levels).toBeLessThan(5_000);
    expect(leaf).toEqual({});
    expect(() => JSON.stringify(normalizedTool.parameters)).not.toThrow();
    expect(normalizedTool.execute).toBe(execute);
    await expect(normalizedTool.execute("depth-proof", {})).resolves.toMatchObject({
      details: { called: true },
    });
  },
);

it("preserves deep literal data while normalizing and inspecting schema keywords", () => {
  let literal: unknown = { anyOf: [{ const: "first" }, { const: "second" }], pattern: "data" };
  for (let depth = 0; depth < 5_000; depth++) {
    literal = { nested: literal };
  }
  const parameters = objectSchema(
    { choice: { const: literal } },
    { default: literal, examples: [literal] },
  );
  const source = tool(parameters);
  const context = deepSeekContext([source]);

  expect(normalizeDeepSeekToolSchemas(context)[0]).toBe(source);
  expect(inspectDeepSeekToolSchemas(context)).toEqual([]);
  expect(
    inspectGeminiToolSchemas(providerContext([tool(objectSchema({ choice: { const: literal } }))])),
  ).toEqual([]);
});

it("preserves copy-on-write tool identities for deepseek", () => {
  const schema = { anyOf: [{ type: "string" }, { type: "null" }] };
  const expected = { type: "string", nullable: true };
  const stable = { type: "string" };
  const parameters = objectSchema({ stable, changed: schema });
  const originalParameters = structuredClone(parameters);
  const requiredClientCaps = ["fixture-capability"];
  const execute = async () => ({ content: [], details: {} });
  const changedTool = Object.assign(tool(parameters, "changed"), {
    requiredClientCaps,
    execute,
  });
  const tools = [tool(undefined, "absent"), tool(7, "primitive"), tool(stable), changedTool];

  const normalized = normalizeDeepSeekToolSchemas(providerContext(tools));

  expect(normalized).not.toBe(tools);
  expect(normalized).toHaveLength(tools.length);
  for (let index = 0; index < 3; index++) {
    expect(normalized[index]).toBe(tools[index]);
  }
  const normalizedTool = expectDefined(normalized[3], "normalized changed tool");
  expect(normalizedTool).not.toBe(changedTool);
  expect(normalizedTool.parameters).not.toBe(parameters);
  expect(normalizedTool.parameters).toEqual(objectSchema({ stable, changed: expected }));
  const normalizedParameters = normalizedTool.parameters as typeof parameters;
  expect(normalizedParameters.properties.stable).toBe(stable);
  expect(normalizedTool.requiredClientCaps).toBe(requiredClientCaps);
  expect(normalizedTool.execute).toBe(execute);
  expect(parameters).toEqual(originalParameters);
});

it("preserves diagnostic paths and tool indices for gemini", () => {
  const violations = [
    "duplicate.parameters.properties.nested.items[0].oneOf[0].format",
    "duplicate.parameters.properties.nested.items[1].pattern",
    "duplicate.parameters.anyOf[0].pattern",
    "duplicate.parameters.pattern",
  ];
  const parameters = {
    anyOf: [{ pattern: "^outer$" }],
    pattern: "^root$",
    properties: {
      anyOf: { type: "string" },
      nested: {
        type: "array",
        items: [{ oneOf: [{ type: "string", format: "date" }] }, { pattern: "^inner$" }],
      },
    },
  };
  const tools = [
    tool(parameters, "duplicate"),
    tool(objectSchema({ pattern: { type: "string" }, anyOf: { type: "string" } }), "clean"),
    tool({ pattern: "^last$", anyOf: [] }, "duplicate"),
  ];
  const originalTools = structuredClone(tools);

  expect(inspectGeminiToolSchemas(providerContext(tools))).toEqual([
    { toolName: "duplicate", toolIndex: 0, violations },
    { toolName: "duplicate", toolIndex: 2, violations: ["duplicate.parameters.pattern"] },
  ]);
  expect(tools).toEqual(originalTools);
});

it.each([
  ["gemini", "pattern", "^value$"],
  ["deepseek", "oneOf", [{ type: "string" }]],
] as const)(
  "bounds each %s inspection once and checks changed inputs again",
  (family, keyword, value) => {
    let enumerations = 0;
    const schema: Record<string, unknown> = { type: "string" };
    const parameters = new Proxy(schema, {
      ownKeys(target) {
        enumerations++;
        return Reflect.ownKeys(target);
      },
    });
    const context = providerContext([tool(parameters)]);
    const hooks = buildProviderToolCompatFamilyHooks(family);

    expect(hooks.inspectToolSchemas(context)).toEqual([]);
    // One depth-bound walk and one diagnostic walk, with no intermediate revalidation.
    expect(enumerations).toBe(2);
    schema[keyword] = value;
    enumerations = 0;
    expect(hooks.inspectToolSchemas(context)).toEqual([
      { toolName: "demo", toolIndex: 0, violations: [`demo.parameters.${keyword}`] },
    ]);
    expect(enumerations).toBe(2);
    schema.items = parameters;
    expect(() => hooks.inspectToolSchemas(context)).toThrow("circular reference");
  },
);

it("normalizes canonical OpenAI Codex Responses tool schemas", () => {
  const normalized = normalizeOpenAITools([tool({})], {
    modelApi: "openai-chatgpt-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
  });
  expect(normalized[0]?.parameters).toEqual(objectVariant({}, []));
});

it("leaves non-openai providers untouched by OpenAI strict compat", () => {
  const tools = [tool({ type: "string" })];
  const normalized = normalizeOpenAITools(tools, {
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    modelApi: "anthropic-messages",
    baseUrl: null,
  });
  expect(normalized).toBe(tools);
});

it("preserves string-const unions as a flat enum for the deepseek family", () => {
  // Regression for https://github.com/openclaw/openclaw/issues/86468.
  const normalized = normalizeDeepSeek(
    objectSchema(
      {
        mode: {
          description: "更新模式（必填）",
          ...stringUnion("overwrite", "append", "replace_range"),
        },
        optional_mode: {
          anyOf: [...stringUnion("a", "b").anyOf, { type: "null" }],
        },
        single_const: stringUnion("only"),
      },
      { required: ["mode"] },
    ),
    "feishu_update_doc",
  );

  expect(normalized[0]?.parameters).toEqual(
    objectSchema(
      {
        mode: {
          description: "更新模式（必填）",
          type: "string",
          enum: ["overwrite", "append", "replace_range"],
        },
        optional_mode: { type: "string", enum: ["a", "b"], nullable: true },
        single_const: { const: "only", type: "string" },
      },
      { required: ["mode"] },
    ),
  );
  expect(inspectDeepSeekToolSchemas(deepSeekContext(normalized as never))).toStrictEqual([]);
});

it("keeps every object variant of a union expressible for the deepseek family", () => {
  // Regression for https://github.com/openclaw/openclaw/issues/143790.
  const normalized = normalizeDeepSeek(
    objectSchema(
      {
        pages: { type: "array", items: { type: "object" } },
        parent: {
          description: "The parent under which the new pages will be created.",
          anyOf: ["page_id", "database_id", "data_source_id"].map((id) =>
            objectVariant({ [id]: string, type: { type: "string", enum: [id] } }, [id], {
              additionalProperties: {},
            }),
          ),
        },
      },
      { required: ["pages"] },
    ),
    "notion__notion-create-pages",
  );
  const parameters = normalized[0]?.parameters as {
    properties: Record<string, unknown>;
    required?: string[];
  };

  // Other variants accept undeclared keys, so those keys must stay unconstrained.
  expect(parameters.properties.parent).toEqual({
    description: "The parent under which the new pages will be created.",
    type: "object",
    properties: {
      page_id: {},
      database_id: {},
      data_source_id: {},
      type: { type: "string", enum: ["page_id", "database_id", "data_source_id"] },
    },
  });
  expect(parameters.required).toEqual(["pages"]);
  expect(inspectDeepSeekToolSchemas(deepSeekContext(normalized as never))).toStrictEqual([]);
});

it("does not narrow a key a variant accepts through patternProperties", () => {
  // #143819: patternProperties may accept a key another variant constrains.
  const normalized = normalizeDeepSeek(
    objectSchema({
      parent: {
        anyOf: [
          objectVariant({ a: string }, ["a"], {
            patternProperties: { "^b$": { type: "object" } },
          }),
          objectVariant({ b: string }, ["b"]),
        ],
      },
    }),
    "patterned-variant",
  );
  const parameters = normalized[0]?.parameters as {
    properties: { parent: { properties: Record<string, unknown> } };
  };
  const props = parameters.properties.parent.properties;

  expect(props["b"]).toEqual({});
  expect(props["a"]).toEqual({ type: "string" });

  const validate = (args: Record<string, unknown>) => validateDeepSeekTool(normalized, args);

  expect(() => validate({ parent: { a: "x", b: { nested: true } } })).not.toThrow();
  expect(() => validate({ parent: { b: "y" } })).not.toThrow();
});

it("keeps an own __proto__ property with a normalized sibling", () => {
  const mode = { anyOf: [{ type: "string" }, { type: "integer" }] };
  // A changing child forces the recursive walker to return its copied record,
  // so own-key preservation must hold before object-union accumulation too.
  const branch = (description: string) =>
    objectVariant(
      Object.fromEntries<unknown>([
        ["__proto__", { type: "string", description }],
        ["mode", mode],
      ]),
      ["__proto__"],
    );
  const input = objectSchema({
    options: { anyOf: [branch("first"), branch("second")] },
  });
  const before = structuredClone(input);
  const normalized = normalizeDeepSeek(input, "proto-keys");
  const parameters = normalized[0]?.parameters as {
    properties: { options: { properties: Record<string, unknown>; required?: string[] } };
  };
  const props = parameters.properties.options.properties;

  expect(Object.hasOwn(props, "__proto__")).toBe(true);
  expect(Object.getOwnPropertyDescriptor(props, "__proto__")?.value).toEqual({
    type: "string",
    description: "first",
  });
  expect(parameters.properties.options.required).toEqual(["__proto__"]);
  expect(JSON.stringify(parameters)).toContain('"__proto__"');
  expect(input).toEqual(before);
  expect(inspectDeepSeekToolSchemas(deepSeekContext(normalized as never))).toStrictEqual([]);

  const valid = JSON.parse('{"options":{"__proto__":"literal","mode":"x"}}');
  expect(validateDeepSeekTool(normalized, valid)).toEqual(valid);
  expect(() =>
    validateDeepSeekTool(
      normalized,
      JSON.parse('{"options":{"__proto__":{"wrong":"shape"},"mode":"x"}}'),
    ),
  ).toThrow(/Validation failed for tool "proto-keys"/);
});

it("pools literal discriminators in oneOf with disjoint const and enum", () => {
  const branch = (kind: Record<string, unknown>, id: string) =>
    objectVariant({ kind: { type: "string", ...kind }, [id]: string }, ["kind", id]);
  const normalized = normalizeDeepSeek(
    objectSchema({
      parent: {
        oneOf: [
          branch({ const: "page", description: "First category" }, "page_id"),
          branch(
            { const: "discarded", enum: ["excluded"], description: "Second category" },
            "database_id",
          ),
          branch({ enum: ["data_source"], description: "Third category" }, "data_source_id"),
        ],
      },
    }),
    "literal-parent",
  );

  expect(normalized[0]?.parameters).toMatchObject({
    properties: {
      parent: {
        properties: {
          kind: {
            type: "string",
            description: "First category",
            enum: ["page", "data_source"],
          },
        },
        required: ["kind"],
      },
    },
  });
  expect(inspectDeepSeekToolSchemas(deepSeekContext(normalized as never))).toStrictEqual([]);
  for (const parent of [
    { kind: "page", page_id: "page-1" },
    { kind: "data_source", data_source_id: "data-source-1" },
  ]) {
    expect(validateDeepSeekTool(normalized, { parent })).toEqual({ parent });
  }
  for (const kind of ["discarded", "excluded"]) {
    expect(() =>
      validateDeepSeekTool(normalized, { parent: { kind, database_id: "database-1" } }),
    ).toThrow(/Validation failed for tool "literal-parent"/);
  }
});

it("skips openai strict-tool normalization on non-native routes", () => {
  const tools = [tool({}, "ping")];
  const route = {
    modelApi: "openai-completions",
    baseUrl: "https://example.com/v1",
  };

  expect(normalizeOpenAITools(tools, route)).toBe(tools);
  expect(inspectOpenAITools(tools, route)).toStrictEqual([]);
});

it("leaves raw dictionary warnings to registration, not post-normalization inspection", () => {
  const tools = [tool(objectSchema({ payload: { type: "object" } }))];
  expect(inspectOpenDictionaryToolSchemas(tools)).toHaveLength(1);
  expect(inspectOpenAITools(tools)).toEqual([]);
  const normalized = normalizeOpenAITools(tools);
  expect(openAIHooks.inspectToolSchemas({ ...providerContext([]), tools: normalized })).toEqual([]);
});

it.each([
  ["bare", { type: "object" }, true],
  ["Type.Object({})", Type.Object({}), true],
  ["empty patterns", { type: "object", patternProperties: {} }, true],
  ["Type.Record", Type.Record(Type.String(), Type.String()), false],
  [
    "record with empty properties",
    { type: "object", properties: {}, patternProperties: { "^.*$": { type: "string" } } },
    false,
  ],
  ["fixed properties", Type.Object({ k: Type.String() }), false],
  ["explicitly open", { type: "object", additionalProperties: true }, false],
  ["explicitly closed", { type: "object", additionalProperties: false }, false],
  ["typed additional keys", { type: "object", additionalProperties: { type: "string" } }, false],
  ["nullable", { type: ["object", "null"] }, false],
] as const)(
  "flags %s exactly when keys stop validating after normalization",
  (_label, payload, losesKeys) => {
    const original = tool(objectSchema({ payload }));
    const normalized = normalizeOpenAITools([original])[0]!;
    const acceptsKeys = (candidate: typeof normalized) => {
      try {
        validateToolArguments(candidate, {
          type: "toolCall",
          id: "keys",
          name: "demo",
          arguments: { payload: { k: "v" } },
        });
        return true;
      } catch {
        return false;
      }
    };
    const stoppedValidating = acceptsKeys(original) && !acceptsKeys(normalized);
    expect(stoppedValidating).toBe(losesKeys);
    expect(inspectOpenDictionaryToolSchemas([original]).length > 0).toBe(stoppedValidating);
  },
);

it("preserves explicitly open dictionary keys through native OpenAI normalization and validation", () => {
  const parameters = objectSchema({ payload: openRecord("Arbitrary metadata") });
  const tools = [tool(parameters)];
  expect(inspectOpenDictionaryToolSchemas(tools)).toEqual([]);
  const normalized = normalizeOpenAITools(tools)[0]!;
  const args = { payload: { label: "kept", count: 2, nested: { enabled: true } } };
  expect(normalized.parameters).toMatchObject({
    properties: { payload: { description: "Arbitrary metadata", additionalProperties: true } },
  });
  expect(
    validateToolArguments(normalized, {
      type: "toolCall",
      id: "call",
      name: "demo",
      arguments: args,
    }),
  ).toEqual(args);
});

it.each([false, true])(
  "reuses schema-identity scans (open dictionary: %s) without caching tool names or indices",
  (open) => {
    let reads = 0;
    const payload = {
      get type() {
        reads++;
        return "object";
      },
      ...(open ? { additionalProperties: true } : {}),
    };
    const parameters = objectSchema({ payload });
    const tools = [tool(parameters, "first")];
    inspectOpenDictionaryToolSchemas(tools);
    const afterFirstScan = reads;
    expect(afterFirstScan).toBeGreaterThan(0);
    expect(
      inspectOpenDictionaryToolSchemas([
        tool(Type.Object({}), "clean"),
        tool(parameters, "second"),
      ]),
    ).toEqual(
      open
        ? []
        : [
            {
              toolName: "second",
              toolIndex: 1,
              violations: ["second.parameters.properties.payload"],
            },
          ],
    );
    expect(reads).toBe(afterFirstScan);
  },
);

it("combines schema paths into one diagnostic without inspecting literal data", () => {
  const tools = [
    tool(
      objectSchema({
        values: { type: "array", items: { anyOf: [{ type: "object" }, { type: "string" }] } },
        table: { type: "object", additionalProperties: { type: "object" } },
        closed: { type: "object", additionalProperties: false },
        empty: { type: "object", properties: {} },
        literal: { type: "string", default: { type: "object" }, examples: [{ type: "object" }] },
      }),
    ),
  ];
  expect(inspectOpenDictionaryToolSchemas(tools)).toEqual([
    {
      toolName: "demo",
      toolIndex: 0,
      violations: [
        "demo.parameters.properties.values.items.anyOf[0]",
        "demo.parameters.properties.table.additionalProperties",
        "demo.parameters.properties.empty",
      ],
    },
  ]);
  expect(inspectOpenDictionaryToolSchemas([tool({ type: "object" })])).toEqual([]);
});
