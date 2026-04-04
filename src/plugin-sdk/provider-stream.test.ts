import type { StreamFn } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
  buildProviderStreamFamilyHooks,
  composeProviderStreamWrappers,
} from "./provider-stream.js";

describe("composeProviderStreamWrappers", () => {
  it("applies wrappers left to right", async () => {
    const order: string[] = [];
    const baseStreamFn: StreamFn = (_model, _context, _options) => {
      order.push("base");
      return {} as never;
    };

    const wrap =
      (label: string) =>
      (streamFn: StreamFn | undefined): StreamFn =>
      (model, context, options) => {
        order.push(`${label}:before`);
        const result = (streamFn ?? baseStreamFn)(model, context, options);
        order.push(`${label}:after`);
        return result;
      };

    const composed = composeProviderStreamWrappers(baseStreamFn, wrap("a"), undefined, wrap("b"));

    expect(typeof composed).toBe("function");
    void composed?.({} as never, {} as never, {});

    expect(order).toEqual(["b:before", "a:before", "base", "a:after", "b:after"]);
  });

  it("returns the original stream when no wrappers are provided", () => {
    const baseStreamFn: StreamFn = () => ({}) as never;
    expect(composeProviderStreamWrappers(baseStreamFn)).toBe(baseStreamFn);
  });
});

describe("buildProviderStreamFamilyHooks", () => {
  it("covers the stream family matrix", () => {
    let capturedPayload: Record<string, unknown> | undefined;
    let capturedModelId: string | undefined;

    const baseStreamFn: StreamFn = (model, _context, options) => {
      capturedModelId = String(model.id);
      const payload = { config: { thinkingConfig: { thinkingBudget: -1 } } } as Record<
        string,
        unknown
      >;
      options?.onPayload?.(payload as never, model as never);
      capturedPayload = payload;
      return {} as never;
    };

    const googleHooks = buildProviderStreamFamilyHooks("google-thinking");
    googleHooks.wrapStreamFn?.({
      streamFn: baseStreamFn,
      thinkingLevel: "high",
    } as never)(
      { api: "google-generative-ai", id: "gemini-3.1-pro-preview" } as never,
      {} as never,
      {},
    );
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingLevel: "HIGH" } },
    });
    const googleThinkingConfig = (
      (capturedPayload as Record<string, unknown>).config as Record<string, unknown>
    ).thinkingConfig as Record<string, unknown>;
    expect(googleThinkingConfig).not.toHaveProperty("thinkingBudget");

    const minimaxHooks = buildProviderStreamFamilyHooks("minimax-fast-mode");
    minimaxHooks.wrapStreamFn?.({
      streamFn: baseStreamFn,
      extraParams: { fastMode: true },
    } as never)(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
      } as never,
      {} as never,
      {},
    );
    expect(capturedModelId).toBe("MiniMax-M2.7-highspeed");

    const moonshotHooks = buildProviderStreamFamilyHooks("moonshot-thinking");
    moonshotHooks.wrapStreamFn?.({
      streamFn: baseStreamFn,
      thinkingLevel: "off",
    } as never)(
      { api: "openai-completions", id: "kimi-k2.5" } as never,
      {} as never,
      {},
    );
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      thinking: { type: "disabled" },
    });

    const toolStreamHooks = buildProviderStreamFamilyHooks("tool-stream-default-on");
    toolStreamHooks.wrapStreamFn?.({
      streamFn: baseStreamFn,
      extraParams: {},
    } as never)({ id: "glm-4.7" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
      tool_stream: true,
    });

    toolStreamHooks.wrapStreamFn?.({
      streamFn: baseStreamFn,
      extraParams: { tool_stream: false },
    } as never)({ id: "glm-4.7" } as never, {} as never, {});
    expect(capturedPayload).toMatchObject({
      config: { thinkingConfig: { thinkingBudget: -1 } },
    });
    expect(capturedPayload).not.toHaveProperty("tool_stream");
  });
});
