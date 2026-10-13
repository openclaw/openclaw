import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { createOpenAIAnthropicToolPayloadCompatibilityWrapper } from "./anthropic-family-tool-payload-compat.js";

function emptySchema() {
  return { type: "object", properties: {} };
}
function querySchema() {
  return { type: "object", properties: { query: { type: "string" } } };
}
function lookupTool() {
  return { name: "lookup", parameters: querySchema() };
}
function lookupFunction() {
  return { type: "function", function: lookupTool() };
}

function unreadableTool(name = "bad_schema") {
  return {
    name,
    get parameters(): never {
      throw new Error("parameters getter exploded");
    },
  };
}

const model = {
  api: "anthropic-messages",
  provider: "openai-compatible-anthropic",
  id: "claude-compatible",
  compat: { requiresOpenAiAnthropicToolPayload: true },
} as unknown as Model<"anthropic-messages">;

function runWrapper(payload: Record<string, unknown>, nextModel = model) {
  const payloads: Array<Record<string, unknown>> = [];
  const baseStreamFn: StreamFn = (streamModel, context, options) => {
    options?.onPayload?.(payload, streamModel);
    payloads.push(structuredClone(payload));
    return createAssistantMessageEventStream();
  };
  const wrapped = createOpenAIAnthropicToolPayloadCompatibilityWrapper(baseStreamFn);
  void wrapped(nextModel, { messages: [] }, {});
  return payloads[0];
}

describe("createOpenAIAnthropicToolPayloadCompatibilityWrapper", () => {
  it("disables GPT-5.6 reasoning when projecting function tools", () => {
    const payload = runWrapper(
      {
        reasoning_effort: "low",
        tools: [
          {
            name: "lookup",
            parameters: emptySchema(),
          },
        ],
      },
      { ...model, id: "gpt-5.6-luna" },
    );

    expect(payload?.reasoning_effort).toBe("none");
  });

  it("skips unreadable schemas while preserving a healthy pinned tool", () => {
    const payload = runWrapper({
      tools: [
        unreadableTool(),
        {
          name: "lookup",
          description: "Lookup",
          parameters: querySchema(),
        },
      ],
      tool_choice: { type: "tool", name: "lookup" },
    });

    expect(payload?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup",
          parameters: querySchema(),
        },
      },
    ]);
    expect(payload?.tool_choice).toEqual({ type: "function", function: { name: "lookup" } });
  });

  it("uses input_schema without reading a poisoned parameters fallback", () => {
    const payload = runWrapper({
      tools: [
        {
          name: "lookup",
          input_schema: querySchema(),
          get parameters(): never {
            throw new Error("parameters fallback getter exploded");
          },
        },
      ],
    });

    expect(payload?.tools).toEqual([lookupFunction()]);
  });

  it("skips unreadable and structurally invalid schemas while preserving healthy siblings", () => {
    const circularSchema: Record<string, unknown> = {
      type: "object",
      properties: {},
    };
    circularSchema.self = circularSchema;
    const payload = runWrapper({
      tools: [
        {
          name: "circular_schema",
          parameters: circularSchema,
        },
        {
          type: "function",
          function: {
            name: "nested_getter",
            parameters: {
              type: "object",
              properties: {
                get value(): never {
                  throw new Error("nested schema getter exploded");
                },
              },
            },
          },
        },
        {
          name: "invalid_properties",
          parameters: {
            type: "object",
            properties: false,
          },
        },
        {
          name: "invalid_required",
          parameters: {
            type: "object",
            required: "query",
          },
        },
        {
          name: "invalid_root",
          input_schema: [],
        },
        lookupTool(),
      ],
    });

    expect(payload?.tools).toEqual([lookupFunction()]);
  });

  it("preserves JSON-serializable dynamic schema references", () => {
    const payload = runWrapper({
      tools: [
        {
          name: "lookup",
          input_schema: {
            type: "object",
            properties: {
              query: { $dynamicRef: "#query" },
            },
          },
        },
      ],
    });

    expect(payload?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: {
            type: "object",
            properties: {
              query: { $dynamicRef: "#query" },
            },
          },
        },
      },
    ]);
  });

  it("normalizes null object schema keywords", () => {
    const payload = runWrapper({
      tools: [
        {
          name: "lookup",
          parameters: {
            type: "object",
            properties: null,
            required: null,
          },
        },
      ],
    });

    expect(payload?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: {
            type: "object",
          },
        },
      },
    ]);
  });

  it("preserves provider metadata on existing OpenAI function tools", () => {
    const payload = runWrapper({
      tools: [
        {
          type: "function",
          cache_control: { type: "ephemeral" },
          function: {
            name: "lookup",
            parameters: emptySchema(),
            get description(): never {
              throw new Error("description getter exploded");
            },
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "lookup" } },
    });

    expect(payload).toEqual({
      tools: [
        {
          type: "function",
          cache_control: { type: "ephemeral" },
          function: {
            name: "lookup",
            parameters: emptySchema(),
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "lookup" } },
    });
  });

  it("projects custom tools and named custom choices as OpenAI functions", () => {
    const payload = runWrapper({
      tools: [
        {
          type: "custom",
          custom: {
            name: "shell",
            description: "Run a shell command.",
            input_schema: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        },
      ],
      tool_choice: {
        type: "custom",
        custom: { name: "shell" },
      },
    });

    expect(payload).toEqual({
      tools: [
        {
          type: "function",
          function: {
            name: "shell",
            description: "Run a shell command.",
            parameters: {
              type: "object",
              properties: { command: { type: "string" } },
              required: ["command"],
            },
          },
        },
      ],
      tool_choice: {
        type: "function",
        function: { name: "shell" },
      },
    });
  });

  it("preserves free-form custom tools and named custom choices", () => {
    const original = {
      tools: [
        {
          type: "custom",
          custom: {
            name: "shell",
            description: "Run a shell command.",
            format: { type: "text" },
          },
        },
      ],
      tool_choice: {
        type: "custom",
        custom: { name: "shell" },
      },
    };
    expect(runWrapper(structuredClone(original))).toEqual(original);
  });

  it("projects allowed custom tool choices against surviving functions", () => {
    const payload = runWrapper({
      tools: [
        unreadableTool("broken"),
        {
          type: "custom",
          custom: {
            name: "shell",
            input_schema: emptySchema(),
          },
        },
      ],
      tool_choice: {
        type: "allowed_tools",
        allowed_tools: {
          mode: "required",
          tools: [
            { type: "function", function: { name: "broken" } },
            { type: "custom", custom: { name: "shell" } },
          ],
        },
      },
    });

    expect(payload?.tool_choice).toEqual({
      type: "allowed_tools",
      allowed_tools: {
        mode: "required",
        tools: [{ type: "function", function: { name: "shell" } }],
      },
    });
  });

  it("does not match allowed tools across tool kinds", () => {
    const payload = runWrapper({
      tools: [
        {
          type: "custom",
          custom: {
            name: "shell",
            input_schema: emptySchema(),
          },
        },
      ],
      tool_choice: {
        type: "allowed_tools",
        allowed_tools: {
          mode: "auto",
          tools: [{ type: "function", function: { name: "shell" } }],
        },
      },
    });

    expect(payload?.tool_choice).toBe("none");
  });

  it("disables tool calls when no auto-allowed tools survive", () => {
    const payload = runWrapper({
      tools: [
        unreadableTool("broken"),
        {
          type: "custom",
          custom: { name: "shell" },
        },
      ],
      tool_choice: {
        type: "allowed_tools",
        allowed_tools: {
          mode: "auto",
          tools: [{ type: "function", function: { name: "broken" } }],
        },
      },
    });

    expect(payload?.tool_choice).toBe("none");
  });

  it("keeps a usable schema when optional metadata getters throw", () => {
    const payload = runWrapper({
      tools: [
        {
          name: "lookup",
          parameters: emptySchema(),
          get description(): never {
            throw new Error("description getter exploded");
          },
          get strict(): never {
            throw new Error("strict getter exploded");
          },
        },
      ],
    });

    expect(payload?.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          parameters: emptySchema(),
        },
      },
    ]);
  });

  it.each([
    ["pinned", { type: "tool", name: "bad_schema" }, 'requested unavailable tool "bad_schema"'],
    ["required", { type: "any" }, "requires a tool, but no tools survived"],
    ["normalized required", "required", "requires a tool, but no tools survived"],
    [
      "required allowed tools",
      {
        type: "allowed_tools",
        allowed_tools: {
          mode: "required",
          tools: [{ type: "function", function: { name: "bad_schema" } }],
        },
      },
      "no allowed tools survived",
    ],
  ] as const)("rejects %s choices for unreadable tools", (name, tool_choice, error) => {
    expect(() =>
      runWrapper({
        tools: [
          unreadableTool(),
          ...(name === "pinned" ? [{ name: "lookup", parameters: emptySchema() }] : []),
        ],
        tool_choice,
      }),
    ).toThrow(error);
  });

  it.each([{ type: "auto" }, "auto"])(
    "omits %j choice when every tool is unreadable",
    (tool_choice) => {
      const payload = runWrapper({ tools: [unreadableTool()], tool_choice });
      expect(payload).not.toHaveProperty("tools");
      expect(payload).not.toHaveProperty("tool_choice");
    },
  );
});
