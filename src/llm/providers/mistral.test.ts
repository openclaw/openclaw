// Mistral provider tests cover request mapping and stream conversion.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context, Model } from "../types.js";

const mistralMockState = vi.hoisted(() => ({
  payloads: [] as unknown[],
}));

vi.mock("@mistralai/mistralai", () => ({
  Mistral: class MockMistral {
    chat = {
      stream: vi.fn(async (payload: unknown) => {
        mistralMockState.payloads.push(payload);
        throw new Error("stop before network");
      }),
    };
  },
}));

import { streamMistral, streamSimpleMistral } from "./mistral.js";

function makeMistralModel(): Model<"mistral-conversations"> {
  return {
    id: "mistral-large-latest",
    name: "Mistral Large",
    api: "mistral-conversations",
    provider: "mistral",
    baseUrl: "https://api.mistral.ai",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} satisfies Context;

function makeUnreadableParameterTool() {
  const tool = {
    name: "broken_tool",
    description: "broken tool",
    parameters: { type: "object", properties: {} },
    async execute() {
      return { content: [{ type: "text", text: "broken" }] };
    },
  };
  Object.defineProperty(tool, "parameters", {
    enumerable: true,
    get() {
      throw new Error("fuzzplugin parameters getter exploded");
    },
  });
  return tool;
}

describe("Mistral provider", () => {
  beforeEach(() => {
    mistralMockState.payloads = [];
  });

  it("forwards simple stop sequences to Mistral stop", async () => {
    const stream = streamSimpleMistral(makeMistralModel(), context, {
      apiKey: "sk-mistral-provider",
      stop: ["STOP"],
    });

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect((mistralMockState.payloads[0] as { stop?: unknown }).stop).toEqual(["STOP"]);
  });

  it("skips unreadable tool schemas while preserving healthy Mistral tools", async () => {
    const stream = streamMistral(
      makeMistralModel(),
      {
        ...context,
        tools: [
          makeUnreadableParameterTool(),
          {
            name: "healthy_tool",
            description: "healthy tool",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string" },
              },
            },
            async execute() {
              return { content: [{ type: "text", text: "ok" }] };
            },
          },
        ] as never,
      },
      {
        apiKey: "sk-mistral-provider",
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect((mistralMockState.payloads[0] as { tools?: unknown[] }).tools).toEqual([
      {
        type: "function",
        function: {
          name: "healthy_tool",
          description: "healthy tool",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
            },
          },
          strict: false,
        },
      },
    ]);
  });

  it("omits tools and automatic tool choice when every schema is unreadable", async () => {
    const stream = streamMistral(
      makeMistralModel(),
      {
        ...context,
        tools: [makeUnreadableParameterTool()] as never,
      },
      {
        apiKey: "sk-mistral-provider",
        toolChoice: "auto",
      },
    );

    const result = await stream.result();
    const payload = mistralMockState.payloads[0] as Record<string, unknown>;

    expect(result.stopReason).toBe("error");
    expect(payload).not.toHaveProperty("tools");
    expect(payload).not.toHaveProperty("toolChoice");
  });

  it("fails locally when a pinned Mistral tool choice is skipped", async () => {
    const stream = streamMistral(
      makeMistralModel(),
      {
        ...context,
        tools: [
          makeUnreadableParameterTool(),
          {
            name: "healthy_tool",
            description: "healthy tool",
            parameters: { type: "object", properties: {} },
            async execute() {
              return { content: [{ type: "text", text: "ok" }] };
            },
          },
        ] as never,
      },
      {
        apiKey: "sk-mistral-provider",
        toolChoice: { type: "function", function: { name: "broken_tool" } },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
      'Mistral tool_choice requested unavailable tool "broken_tool"',
    );
    expect(mistralMockState.payloads).toHaveLength(0);
  });

  it("validates and emits one snapshot of a pinned Mistral tool name", async () => {
    let nameReads = 0;
    const stream = streamMistral(
      makeMistralModel(),
      {
        ...context,
        tools: [
          {
            name: "healthy_tool",
            description: "healthy tool",
            parameters: { type: "object", properties: {} },
            async execute() {
              return { content: [{ type: "text", text: "ok" }] };
            },
          },
        ] as never,
      },
      {
        apiKey: "sk-mistral-provider",
        toolChoice: {
          type: "function",
          function: {
            get name() {
              nameReads += 1;
              return nameReads === 1 ? "healthy_tool" : "broken_tool";
            },
          },
        },
      },
    );

    const result = await stream.result();

    expect(result.stopReason).toBe("error");
    expect(nameReads).toBe(1);
    expect((mistralMockState.payloads[0] as { toolChoice?: unknown }).toolChoice).toEqual({
      type: "function",
      function: { name: "healthy_tool" },
    });
  });
});
