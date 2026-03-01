import { describe, expect, it, vi } from "vitest";
import { prefixSystemMessage } from "../../infra/system-message.js";
import { createAcpReplyProjector } from "./acp-projector.js";
import { createAcpTestConfig as createCfg } from "./test-fixtures/acp-runtime.js";

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
      text: "a".repeat(70),
      tag: "agent_message_chunk",
    });
    await projector.flush(true);

    expect(deliveries).toEqual([
      { kind: "block", text: "a".repeat(64) },
      { kind: "block", text: "a".repeat(6) },
    ]);
  });

  it("does not suppress identical short text across terminal turn boundaries", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            deliveryMode: "live",
            coalesceIdleMs: 0,
            maxChunkChars: 64,
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({ type: "text_delta", text: "A", tag: "agent_message_chunk" });
    await projector.onEvent({ type: "done", stopReason: "end_turn" });
    await projector.onEvent({ type: "text_delta", text: "A", tag: "agent_message_chunk" });
    await projector.onEvent({ type: "done", stopReason: "end_turn" });

    expect(deliveries.filter((entry) => entry.kind === "block")).toEqual([
      { kind: "block", text: "A" },
      { kind: "block", text: "A" },
    ]);
  });

  it("flushes staggered live text deltas after idle gaps", async () => {
    vi.useFakeTimers();
    try {
      const deliveries: Array<{ kind: string; text?: string }> = [];
      const projector = createAcpReplyProjector({
        cfg: createCfg({
          acp: {
            enabled: true,
            stream: {
              deliveryMode: "live",
              coalesceIdleMs: 50,
              maxChunkChars: 64,
            },
          },
        }),
        shouldSendToolSummaries: true,
        deliver: async (kind, payload) => {
          deliveries.push({ kind, text: payload.text });
          return true;
        },
      });

      await projector.onEvent({ type: "text_delta", text: "A", tag: "agent_message_chunk" });
      await vi.advanceTimersByTimeAsync(760);
      await projector.flush(false);

      await projector.onEvent({ type: "text_delta", text: "B", tag: "agent_message_chunk" });
      await vi.advanceTimersByTimeAsync(760);
      await projector.flush(false);

      await projector.onEvent({ type: "text_delta", text: "C", tag: "agent_message_chunk" });
      await vi.advanceTimersByTimeAsync(760);
      await projector.flush(false);

      expect(deliveries.filter((entry) => entry.kind === "block")).toEqual([
        { kind: "block", text: "A" },
        { kind: "block", text: "B" },
        { kind: "block", text: "C" },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("splits oversized live text by maxChunkChars", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            deliveryMode: "live",
            coalesceIdleMs: 0,
            maxChunkChars: 50,
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    const text = `${"a".repeat(50)}${"b".repeat(50)}${"c".repeat(20)}`;
    await projector.onEvent({ type: "text_delta", text, tag: "agent_message_chunk" });
    await projector.flush(true);

    expect(deliveries.filter((entry) => entry.kind === "block")).toEqual([
      { kind: "block", text: "a".repeat(50) },
      { kind: "block", text: "b".repeat(50) },
      { kind: "block", text: "c".repeat(20) },
    ]);
  });

  it("does not flush short live fragments mid-phrase on idle", async () => {
    vi.useFakeTimers();
    try {
      const deliveries: Array<{ kind: string; text?: string }> = [];
      const projector = createAcpReplyProjector({
        cfg: createCfg({
          acp: {
            enabled: true,
            stream: {
              deliveryMode: "live",
              coalesceIdleMs: 100,
              maxChunkChars: 256,
            },
          },
        }),
        shouldSendToolSummaries: true,
        deliver: async (kind, payload) => {
          deliveries.push({ kind, text: payload.text });
          return true;
        },
      });

      await projector.onEvent({
        type: "text_delta",
        text: "Yes. Send me the term(s), and I’ll run ",
        tag: "agent_message_chunk",
      });

      await vi.advanceTimersByTimeAsync(1200);
      expect(deliveries).toEqual([]);

      await projector.onEvent({
        type: "text_delta",
        text: "`wd-cli` searches right away. ",
        tag: "agent_message_chunk",
      });
      await projector.flush(false);

      expect(deliveries).toEqual([
        {
          kind: "block",
          text: "Yes. Send me the term(s), and I’ll run `wd-cli` searches right away. ",
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports deliveryMode=final_only by buffering all projected output until done", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 512,
            deliveryMode: "final_only",
            tagVisibility: {
              available_commands_update: true,
              tool_call: true,
            },
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({
      type: "text_delta",
      text: "What",
      tag: "agent_message_chunk",
    });
    await projector.onEvent({
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_1",
      status: "in_progress",
      title: "List files",
      text: "List files (in_progress)",
    });
    await projector.onEvent({
      type: "text_delta",
      text: " now?",
      tag: "agent_message_chunk",
    });
    expect(deliveries).toEqual([]);

    await projector.onEvent({ type: "done" });
    expect(deliveries).toHaveLength(3);
    expect(deliveries[0]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated (7)"),
    });
    expect(deliveries[1]?.kind).toBe("tool");
    expect(deliveries[1]?.text).toContain("Tool Call");
    expect(deliveries[2]).toEqual({ kind: "block", text: "What now?" });
  });

  it("flushes buffered status/tool output on error in deliveryMode=final_only", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 512,
            deliveryMode: "final_only",
            tagVisibility: {
              available_commands_update: true,
              tool_call: true,
            },
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_2",
      status: "in_progress",
      title: "Run tests",
      text: "Run tests (in_progress)",
    });
    expect(deliveries).toEqual([]);

    await projector.onEvent({ type: "error", message: "turn failed" });
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated (7)"),
    });
    expect(deliveries[1]?.kind).toBe("tool");
    expect(deliveries[1]?.text).toContain("Tool Call");
  });

  it("suppresses usage_update by default and allows deduped usage when tag-visible", async () => {
    const hidden: Array<{ kind: string; text?: string }> = [];
    const hiddenProjector = createAcpReplyProjector({
      cfg: createCfg(),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        hidden.push({ kind, text: payload.text });
        return true;
      },
    });
    await hiddenProjector.onEvent({
      type: "status",
      text: "usage updated: 10/100",
      tag: "usage_update",
      used: 10,
      size: 100,
    });
    expect(hidden).toEqual([]);

    const shown: Array<{ kind: string; text?: string }> = [];
    const shownProjector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 64,
            deliveryMode: "live",
            tagVisibility: {
              usage_update: true,
            },
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        shown.push({ kind, text: payload.text });
        return true;
      },
    });

    await shownProjector.onEvent({
      type: "status",
      text: "usage updated: 10/100",
      tag: "usage_update",
      used: 10,
      size: 100,
    });
    await shownProjector.onEvent({
      type: "status",
      text: "usage updated: 10/100",
      tag: "usage_update",
      used: 10,
      size: 100,
    });
    await shownProjector.onEvent({
      type: "status",
      text: "usage updated: 11/100",
      tag: "usage_update",
      used: 11,
      size: 100,
    });

    expect(shown).toEqual([
      { kind: "tool", text: prefixSystemMessage("usage updated: 10/100") },
      { kind: "tool", text: prefixSystemMessage("usage updated: 11/100") },
    ]);
  });

  it("hides available_commands_update by default", async () => {
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
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });

    expect(deliveries).toEqual([]);
  });

  it("dedupes repeated tool lifecycle updates when repeatSuppression is enabled", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            deliveryMode: "live",
            tagVisibility: {
              tool_call: true,
              tool_call_update: true,
            },
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_1",
      status: "in_progress",
      title: "List files",
      text: "List files (in_progress)",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call_update",
      toolCallId: "call_1",
      status: "in_progress",
      title: "List files",
      text: "List files (in_progress)",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      title: "List files",
      text: "List files (completed)",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      title: "List files",
      text: "List files (completed)",
    });

    expect(deliveries.length).toBe(2);
    expect(deliveries[0]?.kind).toBe("tool");
    expect(deliveries[0]?.text).toContain("Tool Call");
    expect(deliveries[1]?.kind).toBe("tool");
    expect(deliveries[1]?.text).toContain("Tool Call");
  });

  it("keeps terminal tool updates even when rendered summaries are truncated", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            deliveryMode: "live",
            maxSessionUpdateChars: 48,
            tagVisibility: {
              tool_call: true,
              tool_call_update: true,
            },
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    const longTitle =
      "Run an intentionally long command title that truncates before lifecycle status is visible";
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_truncated_status",
      status: "in_progress",
      title: longTitle,
      text: `${longTitle} (in_progress)`,
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call_update",
      toolCallId: "call_truncated_status",
      status: "completed",
      title: longTitle,
      text: `${longTitle} (completed)`,
    });

    expect(deliveries.length).toBe(2);
    expect(deliveries[0]?.kind).toBe("tool");
    expect(deliveries[1]?.kind).toBe("tool");
  });

  it("renders fallback tool labels without leaking call ids as primary label", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            deliveryMode: "live",
            tagVisibility: {
              tool_call: true,
              tool_call_update: true,
            },
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_ABC123",
      status: "in_progress",
      text: "call_ABC123 (in_progress)",
    });

    expect(deliveries[0]?.text).toContain("Tool Call");
    expect(deliveries[0]?.text).not.toContain("call_ABC123 (");
  });

  it("allows repeated status/tool summaries when repeatSuppression is disabled", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 256,
            deliveryMode: "live",
            repeatSuppression: false,
            tagVisibility: {
              available_commands_update: true,
              tool_call: true,
              tool_call_update: true,
            },
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({
      type: "status",
      text: "available commands updated",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "status",
      text: "available commands updated",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "tool_call",
      text: "tool call",
      tag: "tool_call",
      toolCallId: "x",
      status: "in_progress",
    });
    await projector.onEvent({
      type: "tool_call",
      text: "tool call",
      tag: "tool_call_update",
      toolCallId: "x",
      status: "in_progress",
    });
    await projector.onEvent({
      type: "text_delta",
      text: "hello",
      tag: "agent_message_chunk",
    });
    await projector.flush(true);

    expect(deliveries.filter((entry) => entry.kind === "tool").length).toBe(4);
    expect(deliveries[0]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated"),
    });
    expect(deliveries[1]).toEqual({
      kind: "tool",
      text: prefixSystemMessage("available commands updated"),
    });
    expect(deliveries[2]?.text).toContain("Tool Call");
    expect(deliveries[3]?.text).toContain("Tool Call");
    expect(deliveries[4]).toEqual({ kind: "block", text: "hello" });
  });

  it("suppresses exact duplicate status updates when repeatSuppression is enabled", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 256,
            deliveryMode: "live",
            tagVisibility: {
              available_commands_update: true,
            },
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "status",
      text: "available commands updated (7)",
      tag: "available_commands_update",
    });
    await projector.onEvent({
      type: "status",
      text: "available commands updated (8)",
      tag: "available_commands_update",
    });

    expect(deliveries).toEqual([
      { kind: "tool", text: prefixSystemMessage("available commands updated (7)") },
      { kind: "tool", text: prefixSystemMessage("available commands updated (8)") },
    ]);
  });

  it("truncates oversized turns once and emits one truncation notice", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 256,
            deliveryMode: "live",
            maxOutputChars: 5,
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({
      type: "text_delta",
      text: "hello world",
      tag: "agent_message_chunk",
    });
    await projector.onEvent({
      type: "text_delta",
      text: "ignored tail",
      tag: "agent_message_chunk",
    });
    await projector.flush(true);

    expect(deliveries).toHaveLength(2);
    expect(deliveries).toContainEqual({ kind: "block", text: "hello" });
    expect(deliveries).toContainEqual({
      kind: "tool",
      text: prefixSystemMessage("output truncated"),
    });
  });

  it("supports tagVisibility overrides for tool updates", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 256,
            deliveryMode: "live",
            tagVisibility: {
              tool_call: true,
              tool_call_update: false,
            },
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "c1",
      status: "in_progress",
      title: "Run tests",
      text: "Run tests (in_progress)",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call_update",
      toolCallId: "c1",
      status: "completed",
      title: "Run tests",
      text: "Run tests (completed)",
    });

    expect(deliveries.length).toBe(1);
    expect(deliveries[0]?.text).toContain("Tool Call");
  });

  it("inserts a space boundary before visible text after hidden tool updates by default", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 256,
            deliveryMode: "live",
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({ type: "text_delta", text: "fallback.", tag: "agent_message_chunk" });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_hidden_1",
      status: "in_progress",
      title: "Run test",
      text: "Run test (in_progress)",
    });
    await projector.onEvent({ type: "text_delta", text: "I don't", tag: "agent_message_chunk" });
    await projector.flush(true);

    const combinedText = deliveries
      .filter((entry) => entry.kind === "block")
      .map((entry) => entry.text ?? "")
      .join("");
    expect(combinedText).toBe("fallback. I don't");
  });

  it("preserves hidden boundary across nonterminal hidden tool updates", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 256,
            deliveryMode: "live",
            tagVisibility: {
              tool_call: false,
              tool_call_update: false,
            },
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({ type: "text_delta", text: "fallback.", tag: "agent_message_chunk" });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "hidden_boundary_1",
      status: "in_progress",
      title: "Run test",
      text: "Run test (in_progress)",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call_update",
      toolCallId: "hidden_boundary_1",
      status: "in_progress",
      title: "Run test",
      text: "Run test (in_progress)",
    });
    await projector.onEvent({ type: "text_delta", text: "I don't", tag: "agent_message_chunk" });
    await projector.flush(true);

    const combinedText = deliveries
      .filter((entry) => entry.kind === "block")
      .map((entry) => entry.text ?? "")
      .join("");
    expect(combinedText).toBe("fallback. I don't");
  });

  it("supports hiddenBoundarySeparator=space", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 256,
            deliveryMode: "live",
            hiddenBoundarySeparator: "space",
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({ type: "text_delta", text: "fallback.", tag: "agent_message_chunk" });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_hidden_2",
      status: "in_progress",
      title: "Run test",
      text: "Run test (in_progress)",
    });
    await projector.onEvent({ type: "text_delta", text: "I don't", tag: "agent_message_chunk" });
    await projector.flush(true);

    const combinedText = deliveries
      .filter((entry) => entry.kind === "block")
      .map((entry) => entry.text ?? "")
      .join("");
    expect(combinedText).toBe("fallback. I don't");
  });

  it("supports hiddenBoundarySeparator=none", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 256,
            deliveryMode: "live",
            hiddenBoundarySeparator: "none",
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({ type: "text_delta", text: "fallback.", tag: "agent_message_chunk" });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_hidden_3",
      status: "in_progress",
      title: "Run test",
      text: "Run test (in_progress)",
    });
    await projector.onEvent({ type: "text_delta", text: "I don't", tag: "agent_message_chunk" });
    await projector.flush(true);

    const combinedText = deliveries
      .filter((entry) => entry.kind === "block")
      .map((entry) => entry.text ?? "")
      .join("");
    expect(combinedText).toBe("fallback.I don't");
  });

  it("does not duplicate newlines when previous visible text already ends with newline", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 256,
            deliveryMode: "live",
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({
      type: "text_delta",
      text: "fallback.\n",
      tag: "agent_message_chunk",
    });
    await projector.onEvent({
      type: "tool_call",
      tag: "tool_call",
      toolCallId: "call_hidden_4",
      status: "in_progress",
      title: "Run test",
      text: "Run test (in_progress)",
    });
    await projector.onEvent({ type: "text_delta", text: "I don't", tag: "agent_message_chunk" });
    await projector.flush(true);

    const combinedText = deliveries
      .filter((entry) => entry.kind === "block")
      .map((entry) => entry.text ?? "")
      .join("");
    expect(combinedText).toBe("fallback.\nI don't");
  });

  it("does not insert boundary separator for hidden non-tool status updates", async () => {
    const deliveries: Array<{ kind: string; text?: string }> = [];
    const projector = createAcpReplyProjector({
      cfg: createCfg({
        acp: {
          enabled: true,
          stream: {
            coalesceIdleMs: 0,
            maxChunkChars: 256,
            deliveryMode: "live",
          },
        },
      }),
      shouldSendToolSummaries: true,
      deliver: async (kind, payload) => {
        deliveries.push({ kind, text: payload.text });
        return true;
      },
    });

    await projector.onEvent({ type: "text_delta", text: "A", tag: "agent_message_chunk" });
    await projector.onEvent({
      type: "status",
      tag: "available_commands_update",
      text: "available commands updated",
    });
    await projector.onEvent({ type: "text_delta", text: "B", tag: "agent_message_chunk" });
    await projector.flush(true);

    const combinedText = deliveries
      .filter((entry) => entry.kind === "block")
      .map((entry) => entry.text ?? "")
      .join("");
    expect(combinedText).toBe("AB");
  });
});
