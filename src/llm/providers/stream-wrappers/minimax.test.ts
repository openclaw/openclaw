import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import type { ThinkLevel } from "../../../auto-reply/thinking.js";
import {
  createMinimaxFastModeWrapper,
  createMinimaxThinkingDisabledWrapper,
  type ResolveMinimaxFastLaneCost,
} from "./minimax.js";

function captureThinkingPayload(params: {
  provider: string;
  api: string;
  modelId: string;
  thinkingLevel?: ThinkLevel;
}): unknown {
  let capturedThinking: unknown = undefined;
  const baseStreamFn: StreamFn = (model, context, options) => {
    const payload: Record<string, unknown> = {};
    options?.onPayload?.(payload, model);
    capturedThinking = payload.thinking;
    return {} as ReturnType<StreamFn>;
  };

  const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn, params.thinkingLevel);
  void wrapped(
    {
      api: params.api,
      provider: params.provider,
      id: params.modelId,
    } as Model<"anthropic-messages">,
    { messages: [] } as Context,
    {},
  );

  return capturedThinking;
}

describe("createMinimaxThinkingDisabledWrapper", () => {
  it("disables thinking for minimax anthropic-messages provider", () => {
    expect(
      captureThinkingPayload({
        provider: "minimax",
        api: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      }),
    ).toEqual({ type: "disabled" });
  });

  it("disables thinking for minimax-portal anthropic-messages provider", () => {
    expect(
      captureThinkingPayload({
        provider: "minimax-portal",
        api: "anthropic-messages",
        modelId: "MiniMax-M2.7",
      }),
    ).toEqual({ type: "disabled" });
  });

  it("does not affect non-minimax providers", () => {
    expect(
      captureThinkingPayload({
        provider: "anthropic",
        api: "anthropic-messages",
        modelId: "claude-sonnet-4-6",
      }),
    ).toBeUndefined();
  });

  it("does not affect minimax with non-anthropic-messages api", () => {
    expect(
      captureThinkingPayload({
        provider: "minimax",
        api: "openai-completions",
        modelId: "MiniMax-M2.7",
      }),
    ).toBeUndefined();
  });

  it("does NOT disable thinking for MiniMax-M3 on anthropic-messages", () => {
    // M3 emits Anthropic-shape thinking blocks and returns empty content
    // when thinking is disabled; see isMinimaxModelRequiringThinking.
    expect(
      captureThinkingPayload({
        provider: "minimax",
        api: "anthropic-messages",
        modelId: "MiniMax-M3",
      }),
    ).toBeUndefined();
  });

  it("does NOT disable thinking for MiniMax-M3 on minimax-portal", () => {
    expect(
      captureThinkingPayload({
        provider: "minimax-portal",
        api: "anthropic-messages",
        modelId: "MiniMax-M3",
      }),
    ).toBeUndefined();
  });

  it("removes implicit disabled thinking for MiniMax-M3", () => {
    let capturedThinking: unknown = undefined;
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "disabled" },
      };
      options?.onPayload?.(payload, model);
      capturedThinking = payload.thinking;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M3",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedThinking).toBeUndefined();
  });

  it("preserves explicit off thinking for MiniMax-M3", () => {
    let capturedThinking: unknown = undefined;
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "disabled" },
      };
      options?.onPayload?.(payload, model);
      capturedThinking = payload.thinking;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn, "off");
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M3",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedThinking).toEqual({ type: "disabled" });
  });

  it("rewrites MiniMax-M3 default budget thinking to adaptive", () => {
    let capturedThinking: unknown = undefined;
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "enabled", budget_tokens: 1024 },
      };
      options?.onPayload?.(payload, model);
      capturedThinking = payload.thinking;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn, "adaptive");
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M3",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedThinking).toEqual({ type: "adaptive" });
  });

  it("restores explicit MiniMax-M3 maxTokens when rewriting budget thinking", () => {
    let capturedPayload: Record<string, unknown> | undefined;
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        max_tokens: 8692,
        thinking: { type: "enabled", budget_tokens: 8192 },
      };
      options?.onPayload?.(payload, model);
      capturedPayload = payload;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn, "adaptive");
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M3",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      { maxTokens: 500 },
    );

    expect(capturedPayload).toMatchObject({
      max_tokens: 500,
      thinking: { type: "adaptive" },
    });
  });

  it("preserves explicit enabled thinking for MiniMax-M3", () => {
    let capturedThinking: unknown = undefined;
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "disabled" },
      };
      options?.onPayload?.(payload, model);
      capturedThinking = payload.thinking;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M3",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {
        onPayload: (payload) => {
          (payload as Record<string, unknown>).thinking = {
            type: "enabled",
            budget_tokens: 1024,
          };
        },
      },
    );

    expect(capturedThinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  it("preserves an already-set thinking value", () => {
    let capturedThinking: unknown = undefined;
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = {
        thinking: { type: "enabled", budget_tokens: 1024 },
      };
      options?.onPayload?.(payload, model);
      capturedThinking = payload.thinking;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxThinkingDisabledWrapper(baseStreamFn);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedThinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });
});

describe("createMinimaxFastModeWrapper", () => {
  it("rewrites MiniMax-M2.7 to highspeed variant in fast mode", () => {
    let capturedId = "";
    const baseStreamFn: StreamFn = (model) => {
      capturedId = model.id;
      return {} as ReturnType<StreamFn>;
    };

    const wrapped = createMinimaxFastModeWrapper(baseStreamFn, true);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: "MiniMax-M2.7",
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );

    expect(capturedId).toBe("MiniMax-M2.7-highspeed");
  });

  it("resolves dynamic fast mode for each stream call", () => {
    const capturedIds: string[] = [];
    const baseStreamFn: StreamFn = (model) => {
      capturedIds.push(model.id);
      return {} as ReturnType<StreamFn>;
    };

    let enabled = true;
    const wrapped = createMinimaxFastModeWrapper(baseStreamFn, () => enabled);
    const model = {
      api: "anthropic-messages",
      provider: "minimax",
      id: "MiniMax-M2.7",
    } as Model<"anthropic-messages">;

    void wrapped(model, { messages: [] } as Context, {});
    enabled = false;
    void wrapped(model, { messages: [] } as Context, {});

    expect(capturedIds).toEqual(["MiniMax-M2.7-highspeed", "MiniMax-M2.7"]);
  });
});

describe("createMinimaxFastModeWrapper service_tier", () => {
  function capturePayload(params: {
    modelId: string;
    fastMode: boolean | (() => boolean | undefined);
    initialPayload?: Record<string, unknown>;
  }): Record<string, unknown> {
    let captured: Record<string, unknown> = {};
    const baseStreamFn: StreamFn = (model, context, options) => {
      const payload: Record<string, unknown> = { ...params.initialPayload };
      options?.onPayload?.(payload, model);
      captured = payload;
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = createMinimaxFastModeWrapper(baseStreamFn, params.fastMode);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: params.modelId,
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );
    return captured;
  }

  it("injects service_tier priority for MiniMax-M3 when fast mode is on", () => {
    expect(capturePayload({ modelId: "MiniMax-M3", fastMode: true }).service_tier).toBe("priority");
  });

  it("resolves function-based fast mode (e.g. /fast auto) for M3 priority", () => {
    // Auto fast mode passes fastMode as a resolver function; the wrapper must
    // call it per stream rather than only honoring a literal `true`.
    expect(capturePayload({ modelId: "MiniMax-M3", fastMode: () => true }).service_tier).toBe(
      "priority",
    );
    expect(
      capturePayload({ modelId: "MiniMax-M3", fastMode: () => false }).service_tier,
    ).toBeUndefined();
  });

  it("does not inject service_tier for MiniMax-M3 when fast mode is off", () => {
    expect(capturePayload({ modelId: "MiniMax-M3", fastMode: false }).service_tier).toBeUndefined();
  });

  it("does not inject service_tier for M2.x even in fast mode (no priority benefit)", () => {
    // M2.7 routes to the highspeed model variant instead, so the captured
    // payload carries no service_tier.
    expect(
      capturePayload({ modelId: "MiniMax-M2.7", fastMode: true }).service_tier,
    ).toBeUndefined();
  });

  it("preserves an already-set service_tier", () => {
    // "standard" is MiniMax's own tier value; the wrapper must not clobber a
    // service_tier an earlier wrapper/caller already chose.
    expect(
      capturePayload({
        modelId: "MiniMax-M3",
        fastMode: true,
        initialPayload: { service_tier: "standard" },
      }).service_tier,
    ).toBe("standard");
  });
});

describe("createMinimaxFastModeWrapper fast-lane cost", () => {
  const M27_STANDARD_COST = { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 };
  const M3_STANDARD_COST = { input: 0.6, output: 2.4, cacheRead: 0.12, cacheWrite: 0 };

  function captureModel(params: {
    modelId: string;
    baseCost: Model<"anthropic-messages">["cost"];
    resolveFastLaneCost?: ResolveMinimaxFastLaneCost;
  }): Model<"anthropic-messages"> {
    let captured = {} as Model<"anthropic-messages">;
    const baseStreamFn: StreamFn = (model) => {
      captured = model as Model<"anthropic-messages">;
      return {} as ReturnType<StreamFn>;
    };
    const wrapped = createMinimaxFastModeWrapper(baseStreamFn, true, params.resolveFastLaneCost);
    void wrapped(
      {
        api: "anthropic-messages",
        provider: "minimax",
        id: params.modelId,
        cost: params.baseCost,
      } as Model<"anthropic-messages">,
      { messages: [] } as Context,
      {},
    );
    return captured;
  }

  it("bills the highspeed variant's cost for M2.7 fast mode", () => {
    const captured = captureModel({
      modelId: "MiniMax-M2.7",
      baseCost: M27_STANDARD_COST,
      // Stand-in for the plugin resolver: highspeed variant id -> its own rate.
      resolveFastLaneCost: ({ requestModelId, priority }) => {
        expect(requestModelId).toBe("MiniMax-M2.7-highspeed");
        expect(priority).toBe(false);
        return { input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 };
      },
    });
    expect(captured.id).toBe("MiniMax-M2.7-highspeed");
    expect(captured.cost).toEqual({ input: 0.6, output: 2.4, cacheRead: 0.06, cacheWrite: 0.375 });
  });

  it("bills the 1.5x priority cost for M3 fast mode", () => {
    const captured = captureModel({
      modelId: "MiniMax-M3",
      baseCost: M3_STANDARD_COST,
      resolveFastLaneCost: ({ requestModelId, priority }) => {
        expect(requestModelId).toBe("MiniMax-M3");
        expect(priority).toBe(true);
        return { input: 0.9, output: 3.6, cacheRead: 0.18, cacheWrite: 0 };
      },
    });
    expect(captured.id).toBe("MiniMax-M3");
    expect(captured.cost).toEqual({ input: 0.9, output: 3.6, cacheRead: 0.18, cacheWrite: 0 });
  });

  it("leaves the base cost untouched when no resolver is supplied", () => {
    const captured = captureModel({ modelId: "MiniMax-M3", baseCost: M3_STANDARD_COST });
    expect(captured.cost).toEqual(M3_STANDARD_COST);
  });
});
