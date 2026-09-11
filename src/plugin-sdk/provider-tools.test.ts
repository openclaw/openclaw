import { validateToolArguments } from "@openclaw/llm-core/validation";
import { expectDefined } from "@openclaw/normalization-core";
// Provider tool tests cover tool schema conversion and provider payload compatibility.
import { describe, expect, it } from "vitest";
import { findSourceImportBackedges } from "../../test/helpers/source-import-closure.js";
import {
  buildProviderToolCompatFamilyHooks,
  inspectDeepSeekToolSchemas,
  findOpenAIStrictSchemaViolations,
  inspectGeminiToolSchemas,
  inspectLlamacppGbnfToolSchemas,
  inspectOpenAIToolSchemas,
  normalizeDeepSeekToolSchemas,
  normalizeGeminiToolSchemas,
  normalizeLlamacppGbnfToolSchemas,
  normalizeOpenAIToolSchemas,
} from "./provider-tools.js";

describe("buildProviderToolCompatFamilyHooks", () => {
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

  function strictObject(overrides: Record<string, unknown> = {}) {
    return {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
      ...overrides,
    };
  }

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

  function normalizeOpenAIParameters(parameters: unknown): unknown {
    return normalizeOpenAITools([tool(parameters)])[0]?.parameters;
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

  it("covers the tool compat family matrix", () => {
    const cases = [
      ["deepseek", normalizeDeepSeekToolSchemas, inspectDeepSeekToolSchemas],
      ["gemini", normalizeGeminiToolSchemas, inspectGeminiToolSchemas],
      ["llamacpp-gbnf", normalizeLlamacppGbnfToolSchemas, inspectLlamacppGbnfToolSchemas],
      ["openai", normalizeOpenAIToolSchemas, inspectOpenAIToolSchemas],
    ] as const;

    for (const [family, normalizeToolSchemas, inspectToolSchemas] of cases) {
      const hooks = buildProviderToolCompatFamilyHooks(family);

      expect(hooks.normalizeToolSchemas).toBe(normalizeToolSchemas);
      expect(hooks.inspectToolSchemas).toBe(inspectToolSchemas);
    }
  });

  it("removes llama.cpp GBNF-hostile constraints from nested tool schemas", () => {
    const hooks = buildProviderToolCompatFamilyHooks("llamacpp-gbnf");
    const tools = [
      tool(
        objectSchema({
          job: objectSchema({
            declarationKey: {
              type: "string",
              maxLength: 1999,
              pattern: "^\\S+$",
            },
            trigger: {
              anyOf: [
                objectSchema({
                  script: { type: "string", minLength: 1, maxLength: 65_536 },
                  boundary: { type: "string", maxLength: 2000 },
                }),
                { type: "null" },
              ],
            },
          }),
        }),
        "cron",
      ),
    ];

    const normalized = hooks.normalizeToolSchemas({
      provider: "ollama",
      modelId: "qwen3.5",
      tools,
    });

    expect(normalized[0]?.parameters).toEqual(
      objectSchema({
        job: objectSchema({
          declarationKey: { type: "string", maxLength: 1999 },
          trigger: {
            anyOf: [
              objectSchema({
                script: { type: "string", minLength: 1 },
                boundary: { type: "string" },
              }),
              { type: "null" },
            ],
          },
        }),
      }),
    );
    expect(hooks.inspectToolSchemas({ provider: "ollama", tools: normalized })).toEqual([]);
  });

  it.each([
    {
      title: "normalizes canonical OpenAI Codex Responses tool schemas",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    },
    {
      title: "applies ChatGPT Responses strict compat on first-party OpenAI API hosts",
      baseUrl: "https://api.openai.com/v1",
    },
  ])("$title", ({ baseUrl }) => {
    const normalized = normalizeOpenAITools([tool({})], {
      modelApi: "openai-chatgpt-responses",
      baseUrl,
    });
    expect(normalized[0]?.parameters).toEqual(strictObject());
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

  it("collapses anyOf and oneOf unions for the deepseek family", () => {
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const tools = [
      tool(
        objectSchema(
          {
            date: {
              description: "Balance sheet date",
              anyOf: [{ type: "string" }, { type: "integer" }],
            },
            ticker: {
              oneOf: [{ type: "string" }, { type: "null" }],
            },
          },
          { required: ["date"] },
        ),
        "unusual-whales__get_balance_sheet_screener",
      ),
    ];

    const normalized = hooks.normalizeToolSchemas(deepSeekContext(tools));

    expect(normalized[0]?.parameters).toEqual(
      objectSchema(
        {
          date: {
            description: "Balance sheet date",
            type: "string",
          },
          ticker: {
            type: "string",
            nullable: true,
          },
        },
        { required: ["date"] },
      ),
    );
    expect(hooks.inspectToolSchemas(deepSeekContext(normalized as never))).toStrictEqual([]);
  });

  it("preserves string-const unions as a flat enum for the deepseek family", () => {
    // Regression for https://github.com/openclaw/openclaw/issues/86468.
    // Typebox `Type.Union([Type.Literal(...)])` collapses to anyOf of consts;
    // the previous normalizer kept only the first const, hiding every other
    // literal from the model.
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const tools = [
      tool(
        objectSchema(
          {
            mode: {
              description: "更新模式（必填）",
              anyOf: [
                { const: "overwrite", type: "string" },
                { const: "append", type: "string" },
                { const: "replace_range", type: "string" },
              ],
            },
            optional_mode: {
              anyOf: [
                { const: "a", type: "string" },
                { const: "b", type: "string" },
                { type: "null" },
              ],
            },
            single_const: {
              anyOf: [{ const: "only", type: "string" }],
            },
          },
          { required: ["mode"] },
        ),
        "feishu_update_doc",
      ),
    ];

    const normalized = hooks.normalizeToolSchemas(deepSeekContext(tools));

    expect(normalized[0]?.parameters).toEqual(
      objectSchema(
        {
          mode: {
            description: "更新模式（必填）",
            type: "string",
            enum: ["overwrite", "append", "replace_range"],
          },
          optional_mode: {
            type: "string",
            enum: ["a", "b"],
            nullable: true,
          },
          single_const: {
            const: "only",
            type: "string",
          },
        },
        { required: ["mode"] },
      ),
    );
    expect(hooks.inspectToolSchemas(deepSeekContext(normalized as never))).toStrictEqual([]);
  });

  it("keeps every object variant of a union expressible for the deepseek family", () => {
    // Regression for https://github.com/openclaw/openclaw/issues/143790.
    // Notion's create-pages `parent` is an anyOf of three object variants.
    // Keeping only the first variant narrowed the schema to `page_id`, so the
    // model could not express a database or data-source parent and every such
    // call was rejected by our own argument validator before it reached the
    // server.
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const tools = [
      tool(
        objectSchema(
          {
            pages: { type: "array", items: { type: "object" } },
            parent: {
              description: "The parent under which the new pages will be created.",
              anyOf: [
                {
                  type: "object",
                  properties: {
                    page_id: { type: "string" },
                    type: { type: "string", enum: ["page_id"] },
                  },
                  required: ["page_id"],
                  additionalProperties: {},
                },
                {
                  type: "object",
                  properties: {
                    database_id: { type: "string" },
                    type: { type: "string", enum: ["database_id"] },
                  },
                  required: ["database_id"],
                  additionalProperties: {},
                },
                {
                  type: "object",
                  properties: {
                    data_source_id: { type: "string" },
                    type: { type: "string", enum: ["data_source_id"] },
                  },
                  required: ["data_source_id"],
                  additionalProperties: {},
                },
              ],
            },
          },
          { required: ["pages"] },
        ),
        "notion__notion-create-pages",
      ),
    ];

    const normalized = hooks.normalizeToolSchemas(deepSeekContext(tools));
    const parameters = normalized[0]?.parameters as {
      properties: Record<string, unknown>;
      required?: string[];
    };

    // Every branch stays expressible, and the discriminator pools its values so
    // the model can name any of them. The per-branch keys stay unconstrained:
    // each is declared by one variant and permitted by the others through
    // `additionalProperties`, so constraining one would reject a call those
    // variants accepted. The live Notion schema documents each of them, and any
    // annotation survives here.
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
    // No branch's key is required any more, because no key is required by all
    // of them. The root's own `required` is untouched.
    expect(parameters.required).toEqual(["pages"]);
    // The provider still sees no union keyword.
    expect(hooks.inspectToolSchemas(deepSeekContext(normalized as never))).toStrictEqual([]);
  });

  it("does not narrow a key that an open variant accepts without declaring", () => {
    // Review finding on #143819: taking a property from a later variant can
    // narrow the first one. Branch A permits arbitrary extras through
    // `additionalProperties` and accepts `{a: "x", b: {nested: true}}`; branch B
    // declares `b` as a string. Imposing that constraint would reject a call the
    // first variant accepted, so the key has to stay unconstrained, and the
    // assertion runs through the real argument validator rather than the shape.
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const tools = [
      tool(
        objectSchema({
          parent: {
            anyOf: [
              {
                type: "object",
                properties: { a: { type: "string" } },
                required: ["a"],
                additionalProperties: {},
              },
              {
                type: "object",
                properties: { b: { type: "string" } },
                required: ["b"],
              },
            ],
          },
        }),
        "open-variant",
      ),
    ];

    const normalized = hooks.normalizeToolSchemas(deepSeekContext(tools));
    const validate = (args: Record<string, unknown>) =>
      validateToolArguments(normalized[0] as never, {
        type: "toolCall",
        id: "call-open-variant",
        name: "open-variant",
        arguments: args,
      });

    // Accepted by branch A before this change, so it must stay accepted.
    expect(() => validate({ parent: { a: "x", b: { nested: true } } })).not.toThrow();
    // And the variant that first-variant selection made unreachable is callable.
    expect(() => validate({ parent: { b: "y" } })).not.toThrow();
  });

  it("keeps a property whose name collides with Object.prototype", () => {
    // Review finding on #143819: the accumulator was a plain object, so reading
    // `properties["constructor"]` returned the inherited function, enum pooling
    // failed, and the real definition was dropped while the name stayed in
    // `required`. Both variants are closed here, so nothing is relaxed and the
    // assertions are purely about own-property accumulation.
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const tools = [
      tool(
        objectSchema({
          options: {
            anyOf: [
              {
                type: "object",
                properties: {
                  constructor: { type: "string" },
                  toString: { type: "string" },
                },
                required: ["constructor", "toString"],
                additionalProperties: false,
              },
              {
                type: "object",
                properties: {
                  constructor: { type: "string" },
                  toString: { type: "string" },
                },
                required: ["constructor"],
                additionalProperties: false,
              },
            ],
          },
        }),
        "prototype-keys",
      ),
    ];

    const normalized = hooks.normalizeToolSchemas(deepSeekContext(tools));
    const parameters = normalized[0]?.parameters as {
      properties: {
        options: { properties: Record<string, unknown>; required?: string[] };
      };
    };

    const props = parameters.properties.options.properties;
    expect(props["constructor"]).toEqual({ type: "string" });
    expect(props["toString"]).toEqual({ type: "string" });
    expect(parameters.properties.options.required).toEqual(["constructor"]);
  });

  it("does not narrow a key a variant accepts through patternProperties", () => {
    // Review finding on #143819: `additionalProperties: false` does not make a
    // variant reject an undeclared key that its `patternProperties` cover.
    // Branch A accepts an object-valued `b` that way, and branch B declares `b`
    // as a string. Copying B's constraint would reject a call A accepted.
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const tools = [
      tool(
        objectSchema({
          parent: {
            anyOf: [
              {
                type: "object",
                properties: { a: { type: "string" } },
                required: ["a"],
                additionalProperties: false,
                patternProperties: { "^b$": { type: "object" } },
              },
              {
                type: "object",
                properties: { b: { type: "string" } },
                required: ["b"],
                additionalProperties: false,
              },
            ],
          },
        }),
        "patterned-variant",
      ),
    ];

    const normalized = hooks.normalizeToolSchemas(deepSeekContext(tools));
    const parameters = normalized[0]?.parameters as {
      properties: { parent: { properties: Record<string, unknown> } };
    };
    const props = parameters.properties.parent.properties;

    // A key the pattern covers stays unconstrained, while a declared key keeps
    // its own definition.
    expect(props["b"]).toEqual({});
    expect(props["a"]).toEqual({ type: "string" });

    const validate = (args: Record<string, unknown>) =>
      validateToolArguments(normalized[0] as never, {
        type: "toolCall",
        id: "call-patterned-variant",
        name: "patterned-variant",
        arguments: args,
      });

    // Accepted by branch A before this change, so it must stay accepted.
    expect(() => validate({ parent: { a: "x", b: { nested: true } } })).not.toThrow();
    // And the branch that declares `b` is still callable.
    expect(() => validate({ parent: { b: "y" } })).not.toThrow();
  });

  it.each([
    { name: "unchanged sibling", mode: { type: "string" } },
    {
      name: "normalized sibling",
      mode: { anyOf: [{ type: "string" }, { type: "integer" }] },
    },
  ])("keeps an own __proto__ property with a $name", ({ mode }) => {
    // A changing child forces the recursive walker to return its copied record,
    // so own-key preservation must hold before object-union accumulation too.
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const branch = (description: string) => ({
      type: "object",
      properties: Object.fromEntries<unknown>([
        ["__proto__", { type: "string", description }],
        ["mode", mode],
      ]),
      required: ["__proto__"],
      additionalProperties: false,
    });
    const input = objectSchema({
      options: { anyOf: [branch("first"), branch("second")] },
    });
    const before = structuredClone(input);
    const normalized = hooks.normalizeToolSchemas(deepSeekContext([tool(input, "proto-keys")]));
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
    expect(hooks.inspectToolSchemas(deepSeekContext(normalized as never))).toStrictEqual([]);

    const valid = JSON.parse('{"options":{"__proto__":"literal","mode":"x"}}');
    expect(validateDeepSeekTool(normalized, valid)).toEqual(valid);
    expect(() =>
      validateDeepSeekTool(
        normalized,
        JSON.parse('{"options":{"__proto__":{"wrong":"shape"},"mode":"x"}}'),
      ),
    ).toThrow(/Validation failed for tool "proto-keys"/);
  });

  it.each([
    {
      union: "anyOf",
      name: "intersecting const and enum",
      middle: { const: "database", enum: ["database", "excluded"] },
      expectedKinds: ["page", "database", "data_source"],
      validParents: [
        { kind: "page", page_id: "page-1" },
        { kind: "database", database_id: "database-1" },
        { kind: "data_source", data_source_id: "data-source-1" },
      ],
      invalidKinds: ["excluded"],
    },
    {
      union: "oneOf",
      name: "disjoint const and enum",
      middle: { const: "discarded", enum: ["excluded"] },
      expectedKinds: ["page", "data_source"],
      validParents: [
        { kind: "page", page_id: "page-1" },
        { kind: "data_source", data_source_id: "data-source-1" },
      ],
      invalidKinds: ["discarded", "excluded"],
    },
  ])("pools literal discriminators in $union with $name", (testCase) => {
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const branch = (kind: Record<string, unknown>, id: string) => ({
      type: "object",
      properties: { kind: { type: "string", ...kind }, [id]: { type: "string" } },
      required: ["kind", id],
      additionalProperties: false,
    });
    const normalized = hooks.normalizeToolSchemas(
      deepSeekContext([
        tool(
          objectSchema({
            parent: {
              [testCase.union]: [
                branch({ const: "page", description: "First category" }, "page_id"),
                branch({ ...testCase.middle, description: "Second category" }, "database_id"),
                branch({ enum: ["data_source"], description: "Third category" }, "data_source_id"),
              ],
            },
          }),
          "literal-parent",
        ),
      ]),
    );

    expect(normalized[0]?.parameters).toMatchObject({
      properties: {
        parent: {
          properties: {
            kind: {
              type: "string",
              description: "First category",
              enum: testCase.expectedKinds,
            },
          },
          required: ["kind"],
        },
      },
    });
    expect(hooks.inspectToolSchemas(deepSeekContext(normalized as never))).toStrictEqual([]);
    for (const parent of testCase.validParents) {
      expect(validateDeepSeekTool(normalized, { parent })).toEqual({ parent });
    }
    for (const kind of testCase.invalidKinds) {
      expect(() =>
        validateDeepSeekTool(normalized, { parent: { kind, database_id: "database-1" } }),
      ).toThrow(/Validation failed for tool "literal-parent"/);
    }
  });

  it("keeps the first conflicting property definition while merging the other properties", () => {
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const firstKind = { type: "string", enum: ["page"], description: "First category" };
    const normalized = hooks.normalizeToolSchemas(
      deepSeekContext([
        tool(
          objectSchema({
            parent: {
              anyOf: [
                {
                  type: "object",
                  properties: { kind: firstKind, page_id: { type: "string" } },
                  required: ["kind", "page_id"],
                  additionalProperties: false,
                },
                {
                  type: "object",
                  properties: {
                    kind: { type: "integer", enum: [7] },
                    database_id: { type: "string" },
                  },
                  required: ["kind", "database_id"],
                  additionalProperties: false,
                },
              ],
            },
          }),
          "conflicting-parent",
        ),
      ]),
    );

    expect(normalized[0]?.parameters).toMatchObject({
      properties: {
        parent: {
          properties: {
            kind: firstKind,
            page_id: { type: "string" },
            database_id: { type: "string" },
          },
          required: ["kind"],
        },
      },
    });
    expect(hooks.inspectToolSchemas(deepSeekContext(normalized as never))).toStrictEqual([]);
    const first = { parent: { kind: "page", page_id: "page-1" } };
    expect(validateDeepSeekTool(normalized, first)).toEqual(first);
    expect(() =>
      validateDeepSeekTool(normalized, { parent: { kind: 7, database_id: "database-1" } }),
    ).toThrow(/Validation failed for tool "conflicting-parent"/);
  });

  it("falls back when object variants cannot be flattened into one schema", () => {
    // Object/scalar mixtures retain the existing first-variant selection.
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const tools = [
      tool(
        objectSchema({
          mixed: {
            anyOf: [
              { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
              { type: "string" },
            ],
          },
        }),
        "mixed-union",
      ),
    ];

    const normalized = hooks.normalizeToolSchemas(deepSeekContext(tools));
    const parameters = normalized[0]?.parameters as { properties: Record<string, unknown> };

    expect(parameters.properties.mixed).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
    expect(hooks.inspectToolSchemas(deepSeekContext(normalized as never))).toStrictEqual([]);
  });

  it("normalizes parameter-free and typed-object schemas for the openai family", () => {
    const tools = [tool({}, "ping"), tool({ type: "object" }, "exec")];
    const normalized = normalizeOpenAITools(tools);

    expect(normalized.map((entry) => entry.parameters)).toEqual([strictObject(), strictObject()]);
    expect(inspectOpenAITools(tools)).toStrictEqual([]);
  });

  it.each([
    {
      title: "repairs null and inferred OpenAI tool schema types",
      input: {
        type: null,
        description: null,
        default: null,
        properties: {
          payload: {
            properties: { value: { type: "string", format: null } },
          },
          tags: {
            items: { type: "string" },
          },
        },
      },
      expected: {
        type: "object",
        properties: {
          payload: {
            type: "object",
            properties: { value: { type: "string" } },
          },
          tags: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
    {
      title: "keeps unrepairable null schema constraints for downstream quarantine",
      // Null constraint keywords must stay so projection quarantines the tool
      // instead of silently widening the accepted argument schema.
      input: {
        type: "object",
        properties: {
          payload: { type: null, description: "no shape hints" },
          config: { type: "object", properties: {}, additionalProperties: null },
        },
      },
      expected: {
        type: "object",
        properties: {
          payload: { type: null, description: "no shape hints" },
          config: { type: "object", properties: {}, required: [], additionalProperties: null },
        },
      },
    },
    {
      title: "preserves explicit empty properties maps when normalizing strict openai schemas",
      input: { type: "object", properties: {} },
      expected: strictObject(),
    },
  ])("$title", ({ input, expected }) => {
    expect(normalizeOpenAIParameters(input)).toEqual(expected);
  });

  it("preserves nested schemas and annotation objects while normalizing strict openai schemas", () => {
    const cases = [
      {
        name: "property schema",
        parameters: strictObject({
          properties: { payload: {} },
          required: ["payload"],
        }),
      },
      {
        name: "schema maps",
        parameters: strictObject({
          properties: { mode: { $defs: { nested: {} }, dependentSchemas: { flag: {} } } },
          required: ["mode"],
        }),
      },
      {
        name: "nested schema arrays",
        parameters: strictObject({
          properties: { mode: { anyOf: [{}], prefixItems: [{}] } },
          required: ["mode"],
        }),
      },
      {
        name: "annotation objects",
        parameters: strictObject({
          properties: { mode: { type: "string", default: {}, const: {}, examples: [{}] } },
          required: ["mode"],
        }),
      },
    ];

    for (const testCase of cases) {
      expect(normalizeOpenAIParameters(testCase.parameters), testCase.name).toEqual(
        testCase.parameters,
      );
    }
  });

  it("repairs legacy and content schema applicators without changing property dependencies", () => {
    expect(
      normalizeOpenAIParameters(
        strictObject({
          dependencies: {
            mode: ["payload"],
            payload: { type: "object" },
          },
          additionalItems: { type: "object" },
          contentSchema: { type: "object" },
        }),
      ),
    ).toEqual(
      strictObject({
        dependencies: {
          mode: ["payload"],
          payload: strictObject(),
        },
        additionalItems: strictObject(),
        contentSchema: strictObject(),
      }),
    );
  });

  it("does not tighten or warn for permissive object schemas that use strict:false", () => {
    const permissiveParameters = {
      type: "object",
      properties: {
        action: { type: "string" },
        schedule: { type: "string" },
      },
      required: ["action"],
      additionalProperties: true,
    };
    const permissiveTool = tool(permissiveParameters, "cron");
    const normalized = normalizeOpenAITools([permissiveTool]);

    expect(normalized[0]?.parameters).toEqual(permissiveParameters);
    const strictSchemaViolations = findOpenAIStrictSchemaViolations(
      permissiveParameters,
      "cron.parameters",
    );
    expect(strictSchemaViolations).toContain("cron.parameters.required.schedule");
    expect(strictSchemaViolations).toContain("cron.parameters.additionalProperties");
    expect(inspectOpenAITools([permissiveTool])).toStrictEqual([]);
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

  it("suppresses openai strict-schema diagnostics because transport falls back to strict false", () => {
    const diagnostics = inspectOpenAITools(
      [
        tool(
          {
            type: "object",
            properties: {
              mode: {
                anyOf: [{ type: "string" }, { type: "number" }],
              },
              cwd: { type: "string" },
            },
            required: ["mode"],
            additionalProperties: true,
          },
          "exec",
        ),
      ],
      {
        modelApi: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
      },
    );

    expect(diagnostics).toStrictEqual([]);
  });
});
