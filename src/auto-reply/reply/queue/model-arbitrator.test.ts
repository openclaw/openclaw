import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import { resolveQueueArbitratorProvider, resolveQueueModelArbitrator } from "./model-arbitrator.js";

describe("resolveQueueModelArbitrator", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns undefined when disabled", () => {
    expect(resolveQueueModelArbitrator({} as OpenClawConfig)).toBeUndefined();
    expect(resolveQueueArbitratorProvider({} as OpenClawConfig)).toBeUndefined();
  });

  it("defaults the arbitrator provider to lmstudio when enabled", () => {
    expect(
      resolveQueueArbitratorProvider({
        messages: { queue: { arbitrator: { enabled: true } } },
      } as OpenClawConfig),
    ).toBe("lmstudio");
  });

  it("uses LM Studio by default when enabled", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ decision: "steer", confidence: 0.9 }) } },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as typeof fetch;

    const arbitrator = resolveQueueModelArbitrator({
      messages: { queue: { arbitrator: { enabled: true } } },
    } as OpenClawConfig);

    await expect(
      arbitrator?.({
        body: "补充下，我是指 Agent 方向",
        configuredMode: "collect",
        isActive: true,
        isStreaming: true,
      }),
    ).resolves.toBe("steer");
  });

  it("supports Ollama as an explicit fallback provider", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            response: JSON.stringify({ decision: "collect", confidence: 0.8 }),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as typeof fetch;

    const arbitrator = resolveQueueModelArbitrator({
      messages: { queue: { arbitrator: { enabled: true, provider: "ollama" } } },
    } as OpenClawConfig);

    await expect(
      arbitrator?.({
        body: "另外还有个点",
        configuredMode: "collect",
        isActive: true,
        isStreaming: false,
      }),
    ).resolves.toBe("collect");
  });

  it("falls back conservatively to interrupt on low confidence", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ decision: "collect", confidence: 0.2 }) } },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as typeof fetch;

    const arbitrator = resolveQueueModelArbitrator({
      messages: { queue: { arbitrator: { enabled: true, provider: "lmstudio" } } },
    } as OpenClawConfig);

    await expect(
      arbitrator?.({
        body: "我再说一下",
        configuredMode: "collect",
        isActive: true,
        isStreaming: false,
      }),
    ).resolves.toBe("interrupt");
  });
});
