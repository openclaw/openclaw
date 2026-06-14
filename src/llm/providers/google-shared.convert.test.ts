// Google shared conversion tests cover runtime-to-Google payload conversion.
import { describe, expect, it } from "vitest";
import type { Context, Tool } from "../types.js";
import {
  buildGoogleGenerateContentParams,
  convertMessages,
  convertTools,
} from "./google-shared.js";
import {
  asRecord,
  expectConvertedRoles,
  getFirstToolParameters,
  makeGeminiCliAssistantMessage,
  makeGeminiCliModel,
  makeGoogleAssistantMessage,
  makeModel,
} from "./google-shared.test-helpers.js";

type GoogleSharedTestModel = ReturnType<typeof makeModel> | ReturnType<typeof makeGeminiCliModel>;
const convertMessagesForTest = convertMessages as unknown as (
  model: GoogleSharedTestModel,
  context: Context,
) => ReturnType<typeof convertMessages>;

function requireRecordProperty(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected object property ${key}`);
  }
  return value as Record<string, unknown>;
}

describe("google-shared convertTools", () => {
  it("preserves parameters when type is missing", () => {
    const tools = [
      {
        name: "noType",
        description: "Tool with properties but no type",
        parameters: {
          properties: {
            action: { type: "string" },
          },
          required: ["action"],
        },
      },
    ] as unknown as Tool[];

    const converted = convertTools(tools);
    const params = getFirstToolParameters(
      converted as Parameters<typeof getFirstToolParameters>[0],
    );

    expect(params.type).toBeUndefined();
    expect(params.properties).toEqual({
      action: { type: "string" },
    });
    expect(params.required).toEqual(["action"]);
  });

  it("keeps unsupported JSON Schema keywords intact", () => {
    const tools = [
      {
        name: "example",
        description: "Example tool",
        parameters: {
          type: "object",
          patternProperties: {
            "^x-": { type: "string" },
          },
          additionalProperties: false,
          properties: {
            mode: {
              type: "string",
              const: "fast",
            },
            options: {
              anyOf: [{ type: "string" }, { type: "number" }],
            },
            list: {
              type: "array",
              items: {
                type: "string",
                const: "item",
              },
            },
          },
          required: ["mode"],
        },
      },
    ] as unknown as Tool[];

    const converted = convertTools(tools);
    const params = getFirstToolParameters(
      converted as Parameters<typeof getFirstToolParameters>[0],
    );
    const properties = asRecord(params.properties);
    const mode = asRecord(properties.mode);
    const options = asRecord(properties.options);
    const list = asRecord(properties.list);
    const items = asRecord(list.items);

    expect(params.patternProperties).toEqual({ "^x-": { type: "string" } });
    expect(params.additionalProperties).toBe(false);
    expect(mode.const).toBe("fast");
    expect(options.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
    expect(items.const).toBe("item");
    expect(params.required).toEqual(["mode"]);
  });

  it("keeps supported schema fields", () => {
    const tools = [
      {
        name: "settings",
        description: "Settings tool",
        parameters: {
          type: "object",
          properties: {
            config: {
              type: "object",
              properties: {
                retries: { type: "number", minimum: 1 },
                tags: {
                  type: "array",
                  items: { type: "string" },
                },
              },
              required: ["retries"],
            },
          },
          required: ["config"],
        },
      },
    ] as unknown as Tool[];

    const converted = convertTools(tools);
    const params = getFirstToolParameters(
      converted as Parameters<typeof getFirstToolParameters>[0],
    );
    const config = asRecord(asRecord(params.properties).config);
    const configProps = asRecord(config.properties);
    const retries = asRecord(configProps.retries);
    const tags = asRecord(configProps.tags);
    const items = asRecord(tags.items);

    expect(params.type).toBe("object");
    expect(config.type).toBe("object");
    expect(retries.minimum).toBe(1);
    expect(tags.type).toBe("array");
    expect(items.type).toBe("string");
    expect(config.required).toEqual(["retries"]);
    expect(params.required).toEqual(["config"]);
  });

  it("preserves reserved JSON Schema property names", () => {
    const parameters = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}',
    ) as Record<string, unknown>;

    const converted = convertTools([
      {
        name: "lookup",
        description: "Lookup",
        parameters,
      },
    ] as unknown as Tool[]);

    const params = getFirstToolParameters(
      converted as Parameters<typeof getFirstToolParameters>[0],
    );
    const properties = asRecord(params.properties);
    expect(Object.hasOwn(properties, "__proto__")).toBe(true);
    expect(Reflect.get(properties, "__proto__")).toEqual({ type: "string" });
    expect(params.required).toEqual(["__proto__"]);
  });

  it("skips unreadable tool schemas while preserving healthy declarations", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();
    const cyclicSchema: Record<string, unknown> = { type: "object" };
    cyclicSchema.properties = { self: cyclicSchema };
    const sharedProperty = { type: "string" };

    const converted = convertTools([
      {
        get name(): string {
          throw new Error("tool name unavailable");
        },
        description: "Broken",
        parameters: {},
      } as Tool,
      {
        name: "revoked",
        description: "Broken",
        parameters: proxy,
      } as unknown as Tool,
      {
        name: "cyclic",
        description: "Broken",
        parameters: cyclicSchema,
      } as unknown as Tool,
      {
        name: "lookup",
        description: "Lookup",
        parameters: {
          type: "object",
          properties: {
            first: sharedProperty,
            second: sharedProperty,
          },
          required: ["first", "second"],
        },
      },
    ]);

    const declarations = converted?.[0]?.functionDeclarations ?? [];
    expect(declarations).toEqual([
      {
        name: "lookup",
        description: "Lookup",
        parametersJsonSchema: {
          type: "object",
          properties: {
            first: { type: "string" },
            second: { type: "string" },
          },
          required: ["first", "second"],
        },
      },
    ]);
  });

  it("keeps OpenAPI parameter cleanup while skipping unreadable schemas", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    const converted = convertTools(
      [
        {
          name: "revoked",
          description: "Broken",
          parameters: proxy,
        } as unknown as Tool,
        {
          name: "lookup",
          description: "Lookup",
          parameters: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
        } as unknown as Tool,
      ],
      true,
    );

    expect(converted?.[0]?.functionDeclarations).toEqual([
      {
        name: "lookup",
        description: "Lookup",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
        },
      },
    ]);
  });
});

describe("google-shared buildGoogleGenerateContentParams", () => {
  it("omits optional tools when every Google tool declaration is skipped", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    const params = buildGoogleGenerateContentParams(
      makeModel("gemini-2.5-pro"),
      {
        messages: [{ role: "user", content: "hello", timestamp: 0 }],
        tools: [
          {
            name: "revoked",
            description: "Broken",
            parameters: proxy,
          } as unknown as Tool,
        ],
      },
      { toolChoice: "auto" },
    );

    expect(params.config?.tools).toBeUndefined();
    expect(params.config?.toolConfig).toBeUndefined();
  });

  it("throws when forced Google tool choice has no valid declarations", () => {
    const { proxy, revoke } = Proxy.revocable({}, {});
    revoke();

    expect(() =>
      buildGoogleGenerateContentParams(
        makeModel("gemini-2.5-pro"),
        {
          messages: [{ role: "user", content: "hello", timestamp: 0 }],
          tools: [
            {
              name: "revoked",
              description: "Broken",
              parameters: proxy,
            } as unknown as Tool,
          ],
        },
        { toolChoice: "any" },
      ),
    ).toThrow("Google tool choice requires at least one valid tool declaration");
  });
});

describe("google-shared convertMessages", () => {
  function expectConsecutiveMessagesNotMerged(params: {
    modelId: string;
    first: string;
    second: string;
  }) {
    const model = makeModel(params.modelId);
    const context = {
      messages: [
        {
          role: "user",
          content: params.first,
        },
        {
          role: "user",
          content: params.second,
        },
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    expect(contents).toHaveLength(2);
    expect(contents[0].role).toBe("user");
    expect(contents[1].role).toBe("user");
    expect(contents[0].parts).toHaveLength(1);
    expect(contents[1].parts).toHaveLength(1);
  }

  it("keeps thinking blocks when provider/model match", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        makeGoogleAssistantMessage(model.id, [
          {
            type: "thinking",
            thinking: "hidden",
            thinkingSignature: "c2ln",
          },
        ]),
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe("model");
    const part = asRecord(contents[0].parts?.[0]);
    expect(part.thought).toBe(true);
    expect(part.thoughtSignature).toBe("c2ln");
  });

  it("keeps thought signatures for Claude models", () => {
    const model = makeModel("claude-3-opus");
    const context = {
      messages: [
        makeGoogleAssistantMessage(model.id, [
          {
            type: "thinking",
            thinking: "structured",
            thinkingSignature: "c2ln",
          },
        ]),
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    const parts = contents?.[0]?.parts ?? [];
    expect(parts).toHaveLength(1);
    const part = asRecord(parts[0]);
    expect(part.thought).toBe(true);
    expect(part.thoughtSignature).toBe("c2ln");
  });

  it("does not merge consecutive user messages for Gemini", () => {
    expectConsecutiveMessagesNotMerged({
      modelId: "gemini-1.5-pro",
      first: "Hello",
      second: "How are you?",
    });
  });

  it("does not merge consecutive user messages for non-Gemini Google models", () => {
    expectConsecutiveMessagesNotMerged({
      modelId: "claude-3-opus",
      first: "First",
      second: "Second",
    });
  });

  it("does not merge consecutive model messages for Gemini", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "user",
          content: "Hello",
        },
        makeGoogleAssistantMessage(model.id, [{ type: "text", text: "Hi there!" }]),
        makeGoogleAssistantMessage(model.id, [{ type: "text", text: "How can I help?" }]),
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    expectConvertedRoles(contents, ["user", "model", "model"]);
    expect(contents[1].parts).toHaveLength(1);
    expect(contents[2].parts).toHaveLength(1);
  });

  it("handles user message after tool result without model response in between", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "user",
          content: "Use a tool",
        },
        makeGoogleAssistantMessage(model.id, [
          {
            type: "toolCall",
            id: "call_1",
            name: "myTool",
            arguments: { arg: "value" },
          },
        ]),
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "myTool",
          content: [{ type: "text", text: "Tool result" }],
          isError: false,
          timestamp: 0,
        },
        {
          role: "user",
          content: "Now do something else",
        },
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    expect(contents).toHaveLength(4);
    expect(contents[0].role).toBe("user");
    expect(contents[1].role).toBe("model");
    expect(contents[2].role).toBe("user");
    expect(contents[3].role).toBe("user");
    const toolResponsePart = contents[2].parts?.find(
      (part) => typeof part === "object" && part !== null && "functionResponse" in part,
    );
    const toolResponse = asRecord(toolResponsePart);
    expect(requireRecordProperty(toolResponse, "functionResponse").name).toBe("myTool");
    expect(contents[3].role).toBe("user");
  });

  it("ensures function call comes after user turn, not after model turn", () => {
    const model = makeModel("gemini-1.5-pro");
    const context = {
      messages: [
        {
          role: "user",
          content: "Hello",
        },
        makeGoogleAssistantMessage(model.id, [{ type: "text", text: "Hi!" }]),
        makeGoogleAssistantMessage(model.id, [
          {
            type: "toolCall",
            id: "call_1",
            name: "myTool",
            arguments: {},
          },
        ]),
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    expectConvertedRoles(contents, ["user", "model", "model", "user"]);
    const toolCallPart = contents[2].parts?.find(
      (part) => typeof part === "object" && part !== null && "functionCall" in part,
    );
    const toolCall = asRecord(toolCallPart);
    expect(requireRecordProperty(toolCall, "functionCall").name).toBe("myTool");
  });

  it("strips tool call and response ids for google-gemini-cli", () => {
    const model = makeGeminiCliModel("gemini-3-flash");
    const context = {
      messages: [
        {
          role: "user",
          content: "Use a tool",
        },
        makeGeminiCliAssistantMessage(model.id, [
          {
            type: "toolCall",
            id: "call_1",
            name: "myTool",
            arguments: { arg: "value" },
            thoughtSignature: "dGVzdA==",
          },
        ]),
        {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "myTool",
          content: [{ type: "text", text: "Tool result" }],
          isError: false,
          timestamp: 0,
        },
      ],
    } as unknown as Context;

    const contents = convertMessagesForTest(model, context);
    const parts = contents.flatMap((content) => content.parts ?? []);
    const toolCallPart = parts.find(
      (part) => typeof part === "object" && part !== null && "functionCall" in part,
    );
    const toolResponsePart = parts.find(
      (part) => typeof part === "object" && part !== null && "functionResponse" in part,
    );

    const toolCall = asRecord(toolCallPart);
    const toolResponse = asRecord(toolResponsePart);

    expect(asRecord(toolCall.functionCall).id).toBeUndefined();
    expect(asRecord(toolResponse.functionResponse).id).toBeUndefined();
  });
});
