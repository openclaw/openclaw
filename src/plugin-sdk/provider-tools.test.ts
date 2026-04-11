import { describe, expect, it } from "vitest";
import {
  applyXaiModelCompat,
  buildProviderToolCompatFamilyHooks,
  inspectGeminiToolSchemas,
  inspectOpenAIToolSchemas,
  normalizeGeminiToolSchemas,
  normalizeOpenAIToolSchemas,
  resolveXaiModelCompatPatch,
} from "./provider-tools.js";

describe("buildProviderToolCompatFamilyHooks", () => {
  it("covers the tool compat family matrix", () => {
    const cases = [
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
    ).toEqual([]);
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

  it("preserves nested empty property schemas and object annotations", () => {
    const hooks = buildProviderToolCompatFamilyHooks("openai");
    const parameters = {
      type: "object",
      properties: {
        payload: {},
        mode: {
          type: "string",
          default: {},
          const: {},
        },
      },
      required: ["payload", "mode"],
      additionalProperties: false,
    };
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

    expect(normalized[0]?.parameters).toEqual(parameters);
  });

  it("does not tighten permissive object schemas just to satisfy strict mode", () => {
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
    ).toEqual([
      {
        toolName: "cron",
        toolIndex: 0,
        violations: expect.arrayContaining([
          "cron.parameters.required.schedule",
          "cron.parameters.additionalProperties",
        ]),
      },
    ]);
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
    ).toEqual([]);
  });

  it("reports remaining strict-schema violations for the openai family", () => {
    const hooks = buildProviderToolCompatFamilyHooks("openai");

    const diagnostics = hooks.inspectToolSchemas({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      modelApi: "openai-codex-responses",
      model: {
        provider: "openai-codex",
        api: "openai-codex-responses",
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

    expect(diagnostics).toEqual([
      {
        toolName: "exec",
        toolIndex: 0,
        violations: expect.arrayContaining([
          "exec.parameters.additionalProperties",
          "exec.parameters.required.cwd",
          "exec.parameters.properties.mode.anyOf",
        ]),
      },
    ]);
  });

  it("covers the shared xAI tool compat patch", () => {
    const patch = resolveXaiModelCompatPatch();

    expect(patch).toMatchObject({
      toolSchemaProfile: "xai",
      nativeWebSearchTool: true,
      toolCallArgumentsEncoding: "html-entities",
    });
    expect(patch.unsupportedToolSchemaKeywords).toEqual(
      expect.arrayContaining(["minLength", "maxLength", "minItems", "maxItems"]),
    );

    expect(
      applyXaiModelCompat({
        id: "grok-4",
        compat: {
          supportsUsageInStreaming: true,
        },
      }),
    ).toMatchObject({
      compat: {
        supportsUsageInStreaming: true,
        toolSchemaProfile: "xai",
        nativeWebSearchTool: true,
        toolCallArgumentsEncoding: "html-entities",
      },
    });
  });
});
