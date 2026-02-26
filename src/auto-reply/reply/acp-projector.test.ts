import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createAcpReplyProjector } from "./acp-projector.js";

function createCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    acp: {
      enabled: true,
      stream: {
        coalesceIdleMs: 0,
        maxChunkChars: 50,
      },
    },
    ...overrides,
  } as OpenClawConfig;
}

describe("createAcpReplyProjector", () => {
  it("coalesces text deltas into bounded block chunks", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg(),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({
      type: "text_delta",
      text: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    await projector.onEvent({
      type: "text_delta",
      text: "bbbbbbbbbb",
    });
    await projector.flush(true);

    expect(deliveries).toEqual([
      {
        kind: "block",
        text: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
      { kind: "block", text: "aabbbbbbbbbb" },
    ]);
  });

  it("buffers tiny token deltas and flushes once at turn end", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 256,
          },
        },
      }),
      shouldSendToolSummaries: true,
      provider: "discord",
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({ type: "text_delta", text: "What" });
    await projector.onEvent({ type: "text_delta", text: " do" });
    await projector.onEvent({ type: "text_delta", text: " you want to work on?" });

    expect(deliveries).toEqual([]);

    await projector.flush(true);

    expect(deliveries).toEqual([{ kind: "block", text: "What do you want to work on?" }]);
  });

  it("filters thought stream text and suppresses tool summaries when disabled", async () => {
    const deliver = vi.fn(async () => true);
    const projector = createAcpReplyProjector({
      cfg: createCfg(),
      shouldSendToolSummaries: false,
      deliver,
    });

    await projector.onEvent({ type: "text_delta", text: "internal", stream: "thought" });
    await projector.onEvent({ type: "status", text: "running tool" });
    await projector.onEvent({ type: "tool_call", text: "ls" });
    await projector.flush(true);

    expect(deliver).not.toHaveBeenCalled();
  });

  it("emits status and tool_call summaries when enabled", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg(),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({ type: "status", text: "planning" });
    await projector.onEvent({ type: "tool_call", text: "exec ls" });

    expect(deliveries).toEqual([
      { kind: "tool", text: "⚙️ planning" },
      { kind: "tool", text: "🧰 exec ls" },
    ]);
  });

  it("flushes pending streamed text before tool/status updates", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 256,
          },
        },
      }),
      shouldSendToolSummaries: true,
      provider: "discord",
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({ type: "text_delta", text: "Hello" });
    await projector.onEvent({ type: "text_delta", text: " world" });
    await projector.onEvent({ type: "status", text: "running tool" });

    expect(deliveries).toEqual([
      { kind: "block", text: "Hello world" },
      { kind: "tool", text: "⚙️ running tool" },
    ]);
  });
});
