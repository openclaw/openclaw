// Provider tool tests cover tool schema conversion and provider payload compatibility.
import { describe, expect, it } from "vitest";
import {
  buildProviderToolCompatFamilyHooks,
  inspectDeepSeekToolSchemas,
  findOpenAIStrictSchemaViolations,
  inspectGeminiToolSchemas,
  inspectOpenAIToolSchemas,
  normalizeDeepSeekToolSchemas,
  normalizeGeminiToolSchemas,
  normalizeOpenAIToolSchemas,
} from "./provider-tools.js";

describe("buildProviderToolCompatFamilyHooks", () => {
  function createToolWithUnreadableField(field: "name" | "parameters") {
    const tool = {
      name: "revoked_tool",
      description: "",
      parameters: {
        type: "object",
        properties: {
          mode: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
      },
    };
    Object.defineProperty(tool, field, {
      enumerable: true,
      get() {
        throw new Error(`${field} revoked`);
      },
    });
    return tool as never;
  }

  function normalizeOpenAIParameters(parameters: unknown): unknown {
    const hooks = buildProviderToolCompatFamilyHooks("openai");
    const tools = [{ name: "demo", description: "", parameters }] as never;
    const normalized = hooks.normalizeToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      model: {
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
      } as never,
      tools,
    });
    return normalized[0]?.parameters;
  }

  it("covers the tool compat family matrix", () => {
    const cases = [
      {
        family: "deepseek" as const,
        normalizeToolSchemas: normalizeDeepSeekToolSchemas,
        inspectToolSchemas: inspectDeepSeekToolSchemas,
      },
      {
        family: "gemini" as const,
        normalizeToolSchemas: normalizeGeminiToolSchemas,
        inspectToolSchemas: inspectGeminiToolSchemas,
      },
      {
        family: "openai" as const,
        normalizeToolSchemas: normalizeOpenAIToolSchemas,
        inspectToolSchemas: inspectOpenAIToolSchemas,
      },
    ];

    for (const testCase of cases) {
      const hooks = buildProviderToolCompatFamilyHooks(testCase.family);

      expect(hooks.normalizeToolSchemas).toBe(testCase.normalizeToolSchemas);
      expect(hooks.inspectToolSchemas).toBe(testCase.inspectToolSchemas);
    }
  });

  it("normalizes canonical OpenAI Codex Responses tool schemas", () => {
    const hooks = buildProviderToolCompatFamilyHooks("openai");
    const tools = [{ name: "demo", description: "", parameters: {} }] as never;

    const normalized = hooks.normalizeToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-chatgpt-responses",
      model: {
        provider: "openai",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        id: "gpt-5.4",
      } as never,
      tools,
    });

    expect(normalized[0]?.parameters).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it("collapses anyOf and oneOf unions for the deepseek family", () => {
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const tools = [
      {
        name: "unusual-whales__get_balance_sheet_screener",
        description: "",
        parameters: {
          type: "object",
          properties: {
            date: {
              description: "Balance sheet date",
              anyOf: [{ type: "string" }, { type: "integer" }],
            },
            ticker: {
              oneOf: [{ type: "string" }, { type: "null" }],
            },
          },
          required: ["date"],
        },
      },
    ] as never;

    const normalized = hooks.normalizeToolSchemas({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      modelApi: "openai-completions",
      model: {
        provider: "deepseek",
        api: "openai-completions",
        id: "deepseek-v4-pro",
      } as never,
      tools,
    });

    expect(normalized[0]?.parameters).toEqual({
      type: "object",
      properties: {
        date: {
          description: "Balance sheet date",
          type: "string",
        },
        ticker: {
          type: "string",
          nullable: true,
        },
      },
      required: ["date"],
    });
    expect(
      hooks.inspectToolSchemas({
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        modelApi: "openai-completions",
        model: {
          provider: "deepseek",
          api: "openai-completions",
          id: "deepseek-v4-pro",
        } as never,
        tools: normalized,
      }),
    ).toStrictEqual([]);
  });

  it("isolates unreadable provider tool schemas during normalize hooks", () => {
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const healthyTool = {
      name: "healthy_tool",
      description: "",
      displaySummary: "healthy summary",
      parameters: {
        type: "object",
        properties: {
          mode: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
      },
      async execute() {
        return "ok";
      },
    };

    const normalized = hooks.normalizeToolSchemas({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      modelApi: "openai-completions",
      model: {
        provider: "deepseek",
        api: "openai-completions",
        id: "deepseek-v4-pro",
      } as never,
      tools: [createToolWithUnreadableField("parameters"), healthyTool] as never,
    });

    expect(normalized.map((tool) => tool.name)).toEqual(["healthy_tool"]);
    expect(normalized[0]?.parameters).toEqual({
      type: "object",
      properties: {
        mode: { type: "string" },
      },
    });
    expect(Object.keys(normalized[0] as object)).toEqual([
      "description",
      "displaySummary",
      "execute",
      "name",
      "parameters",
    ]);
    expect({ ...normalized[0] }).toMatchObject({
      name: "healthy_tool",
      description: "",
      displaySummary: "healthy summary",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string" },
        },
      },
    });
    expect(typeof normalized[0]?.execute).toBe("function");
  });

  it("reports unreadable provider tool schema metadata during inspect hooks", () => {
    const hooks = buildProviderToolCompatFamilyHooks("gemini");

    const diagnostics = hooks.inspectToolSchemas({
      provider: "google",
      modelId: "gemini-3-pro",
      modelApi: "google",
      model: {
        provider: "google",
        api: "google",
        id: "gemini-3-pro",
      } as never,
      tools: [
        createToolWithUnreadableField("name"),
        createToolWithUnreadableField("parameters"),
        {
          name: "healthy_tool",
          description: "",
          parameters: {
            type: "object",
            properties: { count: { type: "integer", minimum: 1 } },
          },
        },
      ] as never,
    });

    expect(diagnostics).toEqual([
      {
        toolName: "tool[0]",
        toolIndex: 0,
        violations: ["tool.name is unreadable"],
      },
      {
        toolName: "revoked_tool",
        toolIndex: 1,
        violations: ["revoked_tool.parameters is unreadable"],
      },
      {
        toolName: "healthy_tool",
        toolIndex: 2,
        violations: ["healthy_tool.parameters.properties.count.minimum"],
      },
    ]);
  });

  it("preserves string-const unions as a flat enum for the deepseek family", () => {
    // Regression for https://github.com/openclaw/openclaw/issues/86468 —
    // Typebox `Type.Union([Type.Literal(...)])` collapses to anyOf of consts;
    // the previous normalizer kept only the first const, hiding every other
    // literal from the model.
    const hooks = buildProviderToolCompatFamilyHooks("deepseek");
    const tools = [
      {
        name: "feishu_update_doc",
        description: "",
        parameters: {
          type: "object",
          properties: {
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
          required: ["mode"],
        },
      },
    ] as never;

    const normalized = hooks.normalizeToolSchemas({
      provider: "deepseek",
      modelId: "deepseek-v4-pro",
      modelApi: "openai-completions",
      model: {
        provider: "deepseek",
        api: "openai-completions",
        id: "deepseek-v4-pro",
      } as never,
      tools,
    });

    expect(normalized[0]?.parameters).toEqual({
      type: "object",
      properties: {
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
      required: ["mode"],
    });
    expect(
      hooks.inspectToolSchemas({
        provider: "deepseek",
        modelId: "deepseek-v4-pro",
        modelApi: "openai-completions",
        model: {
          provider: "deepseek",
          api: "openai-completions",
          id: "deepseek-v4-pro",
        } as never,
        tools: normalized,
      }),
    ).toStrictEqual([]);
  });

  it("normalizes parameter-free and typed-object schemas for the openai family", () => {
    const hooks = buildProviderToolCompatFamilyHooks("openai");
    const tools = [
      { name: "ping", description: "", parameters: {} },
      { name: "exec", description: "", parameters: { type: "object" } },
    ] as never;

    const normalized = hooks.normalizeToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      model: {
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
      } as never,
      tools,
    });

    expect(normalized.map((tool) => tool.parameters)).toEqual([
      { type: "object", properties: {}, required: [], additionalProperties: false },
      { type: "object", properties: {}, required: [], additionalProperties: false },
    ]);
    expect(
      hooks.inspectToolSchemas({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        model: {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          id: "gpt-5.4",
        } as never,
        tools,
      }),
    ).toStrictEqual([]);
  });

  it("preserves explicit empty properties maps when normalizing strict openai schemas", () => {
    const hooks = buildProviderToolCompatFamilyHooks("openai");
    const parameters = {
      type: "object",
      properties: {},
    };
    const tools = [{ name: "ping", description: "", parameters }] as never;

    const normalized = hooks.normalizeToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      model: {
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
      } as never,
      tools,
    });

    expect(normalized[0]?.parameters).toEqual({
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    });
  });

  it("preserves nested schemas and annotation objects while normalizing strict openai schemas", () => {
    const cases = [
      {
        name: "property schema",
        parameters: {
          type: "object",
          properties: { payload: {} },
          required: ["payload"],
          additionalProperties: false,
        },
      },
      {
        name: "schema maps",
        parameters: {
          type: "object",
          properties: { mode: { $defs: { nested: {} }, dependentSchemas: { flag: {} } } },
          required: ["mode"],
          additionalProperties: false,
        },
      },
      {
        name: "nested schema arrays",
        parameters: {
          type: "object",
          properties: { mode: { anyOf: [{}], prefixItems: [{}] } },
          required: ["mode"],
          additionalProperties: false,
        },
      },
      {
        name: "annotation objects",
        parameters: {
          type: "object",
          properties: { mode: { type: "string", default: {}, const: {}, examples: [{}] } },
          required: ["mode"],
          additionalProperties: false,
        },
      },
    ];

    for (const testCase of cases) {
      expect(normalizeOpenAIParameters(testCase.parameters), testCase.name).toEqual(
        testCase.parameters,
      );
    }
  });

  it("does not tighten or warn for permissive object schemas that use strict:false", () => {
    const hooks = buildProviderToolCompatFamilyHooks("openai");
    const permissiveParameters = {
      type: "object",
      properties: {
        action: { type: "string" },
        schedule: { type: "string" },
      },
      required: ["action"],
      additionalProperties: true,
    };
    const permissiveTool = {
      name: "cron",
      description: "",
      parameters: permissiveParameters,
    } as never;

    const normalized = hooks.normalizeToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      model: {
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        id: "gpt-5.4",
      } as never,
      tools: [permissiveTool],
    });

    expect(normalized[0]?.parameters).toEqual(permissiveParameters);
    const strictSchemaViolations = findOpenAIStrictSchemaViolations(
      permissiveParameters,
      "cron.parameters",
    );
    expect(strictSchemaViolations).toContain("cron.parameters.required.schedule");
    expect(strictSchemaViolations).toContain("cron.parameters.additionalProperties");
    expect(
      hooks.inspectToolSchemas({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        model: {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          id: "gpt-5.4",
        } as never,
        tools: [permissiveTool],
      }),
    ).toStrictEqual([]);
  });

  it("skips openai strict-tool normalization on non-native routes", () => {
    const hooks = buildProviderToolCompatFamilyHooks("openai");
    const tools = [{ name: "ping", description: "", parameters: {} }] as never;

    expect(
      hooks.normalizeToolSchemas({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-completions",
        model: {
          provider: "openai",
          api: "openai-completions",
          baseUrl: "https://example.com/v1",
          id: "gpt-5.4",
        } as never,
        tools,
      }),
    ).toBe(tools);
    expect(
      hooks.inspectToolSchemas({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-completions",
        model: {
          provider: "openai",
          api: "openai-completions",
          baseUrl: "https://example.com/v1",
          id: "gpt-5.4",
        } as never,
        tools,
      }),
    ).toStrictEqual([]);
  });

  it("suppresses openai strict-schema diagnostics because transport falls back to strict false", () => {
    const hooks = buildProviderToolCompatFamilyHooks("openai");

    const diagnostics = hooks.inspectToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-chatgpt-responses",
      model: {
        provider: "openai",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        id: "gpt-5.4",
      } as never,
      tools: [
        {
          name: "exec",
          description: "",
          parameters: {
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
        } as never,
      ],
    });

    expect(diagnostics).toStrictEqual([]);
  });
});
