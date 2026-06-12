import { describe, expect, it, vi } from "vitest";
import type { GetReplyOptions } from "../types.js";
import {
  classifyTurnTimingFailure,
  createTelegramTurnTimingContext,
  getTurnTimingContextFromReplyOptions,
  resolveTurnTimingRuntimeFamily,
  wrapTurnTimingReplyOptions,
} from "./turn-timing.js";

describe("turn timing helpers", () => {
  it("creates a Telegram-only correlation context from safe message metadata", () => {
    const timing = createTelegramTurnTimingContext({
      ctx: {
        Surface: "telegram",
        SessionKey: "agent:operator:main",
        MessageSid: "42",
        ChatType: "direct",
      },
      runId: "run-1",
    });

    expect(timing).toMatchObject({
      correlationId: "run-1",
      channel: "telegram",
      sessionKey: "agent:operator:main",
      messageId: "42",
      chatType: "direct",
      firstOutputLogged: false,
    });
  });

  it("does not create timing context for non-Telegram turns", () => {
    expect(
      createTelegramTurnTimingContext({
        ctx: { Surface: "discord", SessionKey: "agent:operator:main" },
      }),
    ).toBeUndefined();
  });

  it("attaches timing context to wrapped reply options and preserves partial callbacks", async () => {
    const onPartialReply = vi.fn();
    const timing = createTelegramTurnTimingContext({
      ctx: { Surface: "telegram", SessionKey: "agent:operator:main" },
      runId: "run-2",
    });

    const wrapped = wrapTurnTimingReplyOptions(timing, {
      onPartialReply,
    } satisfies Omit<GetReplyOptions, "onBlockReply">);

    expect(wrapped?.runId).toBe("run-2");
    expect(getTurnTimingContextFromReplyOptions(wrapped)).toBe(timing);

    await wrapped?.onPartialReply?.({ text: "hello" });

    expect(onPartialReply).toHaveBeenCalledWith({ text: "hello" });
    expect(timing?.firstOutputLogged).toBe(true);
  });

  it("classifies operational failure modes without logging raw error text", () => {
    expect(classifyTurnTimingFailure(new Error("refresh_token_invalidated"))).toBe("auth_refresh");
    expect(classifyTurnTimingFailure(new Error("GatewayDrainingError: gateway draining"))).toBe(
      "gateway_restart",
    );
    expect(
      classifyTurnTimingFailure(new Error("Cannot access 'providerId' before initialization")),
    ).toBe("bootstrap");
    expect(classifyTurnTimingFailure(new Error('No API key found for provider "openai"'))).toBe(
      "model_routing",
    );
    expect(classifyTurnTimingFailure(new Error("HTTP 429 rate limit"))).toBe("provider_api");
    expect(classifyTurnTimingFailure(new Error("Forbidden"), "telegram_send")).toBe(
      "telegram_send",
    );
  });

  it("resolves runtime families for Codex subscription, direct OpenAI, and provider routes", () => {
    expect(
      resolveTurnTimingRuntimeFamily({
        provider: "openai-codex",
        runtime: "codex",
        requestProvider: "openai-codex",
      }),
    ).toBe("codex-subscription");
    expect(
      resolveTurnTimingRuntimeFamily({
        provider: "openai",
        runtime: "pi",
        requestProvider: "openai",
      }),
    ).toBe("direct-openai-api");
    expect(
      resolveTurnTimingRuntimeFamily({
        provider: "anthropic",
        runtime: "pi",
        requestProvider: "anthropic",
      }),
    ).toBe("provider-runtime");
  });
});
