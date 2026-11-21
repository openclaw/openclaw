import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveBlockStreamingChunking,
  resolveEffectiveBlockStreamingConfig,
} from "./block-streaming.js";

describe("resolveEffectiveBlockStreamingConfig", () => {
  it.each([64, 1800])("applies ACP maxChunkChars=%i while preserving bounds", (maxChunkChars) => {
    const cfg: OpenClawConfig =
      maxChunkChars === 64 ? {} : { channels: { discord: { textChunkLimit: 4096 } } };
    const baseChunking = resolveBlockStreamingChunking(cfg, "discord");
    const resolved = resolveEffectiveBlockStreamingConfig({
      cfg,
      provider: "discord",
      maxChunkChars,
      coalesceIdleMs: maxChunkChars === 64 ? 25 : undefined,
    });

    if (maxChunkChars === 64) {
      expect(baseChunking.maxChars).toBeGreaterThanOrEqual(64);
      expect(resolved.coalescing.idleMs).toBe(25);
    } else {
      expect(baseChunking.maxChars).toBeLessThan(1800);
    }
    expect(resolved.chunking.maxChars).toBe(maxChunkChars);
    expect(resolved.chunking.minChars).toBeLessThanOrEqual(resolved.chunking.maxChars);
    expect(resolved.coalescing.maxChars).toBeLessThanOrEqual(resolved.chunking.maxChars);
    expect(resolved.coalescing.minChars).toBeLessThanOrEqual(resolved.coalescing.maxChars);
  });

  it("reuses caller-provided chunking for shared main/subagent/ACP config resolution", () => {
    const chunking = { minChars: 10, maxChars: 20, breakPreference: "paragraph" as const };
    const resolved = resolveEffectiveBlockStreamingConfig({
      cfg: undefined,
      chunking,
      coalesceIdleMs: 0,
    });
    expect(resolved.chunking).toEqual(chunking);
    expect(resolved.coalescing).toMatchObject({ maxChars: 20, idleMs: 0 });
  });

  it("honors newline chunkMode for plugin channels even before the plugin registry is loaded", () => {
    const cfg = {
      channels: { imessage: { streaming: { chunkMode: "newline" } } },
      agents: {
        defaults: {
          blockStreamingChunk: { minChars: 1, maxChars: 4000, breakPreference: "paragraph" },
        },
      },
    } as OpenClawConfig;

    expect(resolveEffectiveBlockStreamingConfig({ cfg, provider: "imessage" })).toMatchObject({
      chunking: { flushOnParagraph: true },
      coalescing: { joiner: "\n\n" },
    });
  });

  it("honors channel and account scoped nested block coalescing", () => {
    const cfg = {
      channels: {
        imessage: {
          streaming: { block: { coalesce: { minChars: 25, maxChars: 80, idleMs: 5 } } },
          accounts: {
            personal: {
              streaming: { block: { coalesce: { minChars: 10, maxChars: 40, idleMs: 2 } } },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(
      resolveEffectiveBlockStreamingConfig({ cfg, provider: "imessage" }).coalescing,
    ).toMatchObject({ minChars: 25, maxChars: 80, idleMs: 5 });
    expect(
      resolveEffectiveBlockStreamingConfig({
        cfg,
        provider: "imessage",
        accountId: "personal",
      }).coalescing,
    ).toMatchObject({ minChars: 10, maxChars: 40, idleMs: 2 });
  });
});
