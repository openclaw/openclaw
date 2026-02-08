import { describe, expect, it, vi } from "vitest";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/config.js")>();
  return {
    ...actual,
    loadConfig: () =>
      ({
        session: { scope: "per-sender", mainKey: "main" },
        tools: { agentToAgent: { enabled: false } },
      }) as never,
  };
});

import { sanitizeAndCapSessionMessages, SESSIONS_HISTORY_MAX_BYTES } from "./sessions-helpers.js";
import { createSessionsHistoryTool } from "./sessions-history-tool.js";
import { createSessionsListTool } from "./sessions-list-tool.js";

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

describe("sessions_list sanitization", () => {
  it("drops thinking blocks by default (includeThinking=false)", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const method = (opts as { method?: unknown }).method;
      if (method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: "agent:main:main", kind: "direct" }],
        };
      }
      if (method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: "secret",
                  thinkingSignature: "abc123",
                },
                { type: "text", text: "hello" },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected gateway method: ${String(method)}`);
    });

    const tool = createSessionsListTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call1", { messageLimit: 1 });
    const messages =
      (result.details as { sessions: Array<{ messages?: unknown[] }> }).sessions[0].messages ?? [];
    expect(messages).toHaveLength(1);
    const content = (messages[0] as { content?: unknown }).content as unknown[];
    expect(Array.isArray(content)).toBe(true);
    expect(content.some((b) => (b as { type?: unknown }).type === "thinking")).toBe(false);
  });

  it("strips thinkingSignature when includeThinking=true", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const method = (opts as { method?: unknown }).method;
      if (method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: "agent:main:main", kind: "direct" }],
        };
      }
      if (method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: "secret",
                  thinkingSignature: "a".repeat(50_000),
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected gateway method: ${String(method)}`);
    });

    const tool = createSessionsListTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call1", { messageLimit: 1, includeThinking: true });
    const messages =
      (result.details as { sessions: Array<{ messages?: unknown[] }> }).sessions[0].messages ?? [];
    const content = (messages[0] as { content?: unknown }).content as unknown[];
    expect(content.some((b) => (b as { type?: unknown }).type === "thinking")).toBe(true);
    const thinking = content.find((b) => (b as { type?: unknown }).type === "thinking") as Record<
      string,
      unknown
    >;
    expect("thinkingSignature" in thinking).toBe(false);
  });

  it("truncates text + partialJson to 4000 chars", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const method = (opts as { method?: unknown }).method;
      if (method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: "agent:main:main", kind: "direct" }],
        };
      }
      if (method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                { type: "text", text: "x".repeat(5000) },
                { type: "json", partialJson: "y".repeat(5000) },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected gateway method: ${String(method)}`);
    });

    const tool = createSessionsListTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call1", { messageLimit: 1 });
    const messages =
      (result.details as { sessions: Array<{ messages?: unknown[] }> }).sessions[0].messages ?? [];
    const content = (messages[0] as { content?: unknown }).content as Array<
      Record<string, unknown>
    >;

    const textBlock = content.find((b) => (b as { type?: unknown }).type === "text") as {
      text?: unknown;
    };
    expect(typeof textBlock.text).toBe("string");
    expect(String(textBlock.text)).toContain("…(truncated)…");
    expect(String(textBlock.text).length).toBeLessThanOrEqual(4000);

    const jsonBlock = content.find((b) => (b as { type?: unknown }).type === "json") as {
      partialJson?: unknown;
    };
    expect(typeof jsonBlock.partialJson).toBe("string");
    expect(String(jsonBlock.partialJson)).toContain("…(truncated)…");
    expect(String(jsonBlock.partialJson).length).toBeLessThanOrEqual(4000);
  });

  it("treats includeThinking='false' (string) as false", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const method = (opts as { method?: unknown }).method;
      if (method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: "agent:main:main", kind: "direct" }],
        };
      }
      if (method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: "secret",
                  thinkingSignature: "abc123",
                },
                { type: "text", text: "hello" },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected gateway method: ${String(method)}`);
    });

    const tool = createSessionsListTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call1", {
      messageLimit: 1,
      includeThinking: "false" as never,
    });
    const messages =
      (result.details as { sessions: Array<{ messages?: unknown[] }> }).sessions[0].messages ?? [];
    const content = (messages[0] as { content?: unknown }).content as unknown[];
    expect(content.some((b) => (b as { type?: unknown }).type === "thinking")).toBe(false);
  });

  it("strips thinkingSignature regardless of content block type, and drops signature-bearing blocks when includeThinking=false", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const method = (opts as { method?: unknown }).method;
      if (method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: "agent:main:main", kind: "direct" }],
        };
      }
      if (method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "reasoning",
                  thinking: "secret",
                  thinkingSignature: "abc123",
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected gateway method: ${String(method)}`);
    });

    const tool = createSessionsListTool({ agentSessionKey: "agent:main:main" });

    const included = await tool.execute("call1", { messageLimit: 1, includeThinking: true });
    {
      const messages =
        (included.details as { sessions: Array<{ messages?: unknown[] }> }).sessions[0].messages ??
        [];
      const content = (messages[0] as { content?: unknown }).content as Array<
        Record<string, unknown>
      >;
      expect(content).toHaveLength(1);
      expect("thinkingSignature" in content[0]).toBe(false);
    }

    const omitted = await tool.execute("call1", { messageLimit: 1 });
    {
      const messages =
        (omitted.details as { sessions: Array<{ messages?: unknown[] }> }).sessions[0].messages ??
        [];
      const content = (messages[0] as { content?: unknown }).content as Array<
        Record<string, unknown>
      >;
      expect(content).toHaveLength(0);
    }
  });

  it("does not mark url-only image blocks as omitted", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const method = (opts as { method?: unknown }).method;
      if (method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: "agent:main:main", kind: "direct" }],
        };
      }
      if (method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [{ type: "image", url: "https://example.com/foo.png" }],
            },
          ],
        };
      }
      throw new Error(`unexpected gateway method: ${String(method)}`);
    });

    const tool = createSessionsListTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call1", { messageLimit: 1 });
    const messages =
      (result.details as { sessions: Array<{ messages?: unknown[] }> }).sessions[0].messages ?? [];
    const content = (messages[0] as { content?: unknown }).content as Array<
      Record<string, unknown>
    >;
    const image =
      content.find((b) => (b as { type?: unknown }).type === "image") ??
      ({} as Record<string, unknown>);
    expect("omitted" in image).toBe(false);
  });

  it("applies the 80KB cap to sessions_list message payloads", async () => {
    const bigMessages = Array.from({ length: 20 }, () => ({
      role: "assistant",
      // 20 messages with a single 4000-char block can fit under ~80KB; use multiple blocks per message
      // so we reliably exceed the cap and validate message dropping.
      content: Array.from({ length: 5 }, () => ({ type: "text", text: "a".repeat(4000) })),
    }));

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const method = (opts as { method?: unknown }).method;
      if (method === "sessions.list") {
        return {
          path: "/tmp/sessions.json",
          sessions: [{ key: "agent:main:main", kind: "direct" }],
        };
      }
      if (method === "chat.history") {
        return { messages: bigMessages };
      }
      throw new Error(`unexpected gateway method: ${String(method)}`);
    });

    const tool = createSessionsListTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call1", { messageLimit: 20 });
    const messages = (result.details as { sessions: Array<{ messages?: unknown[] }> }).sessions[0]
      .messages;
    expect(Array.isArray(messages)).toBe(true);
    expect(jsonBytes(messages)).toBeLessThanOrEqual(SESSIONS_HISTORY_MAX_BYTES);
    expect(messages?.length).toBeLessThan(bigMessages.length);
  });
});

describe("sessions_history sanitization", () => {
  it("drops thinking blocks by default (includeThinking=false)", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const method = (opts as { method?: unknown }).method;
      if (method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: "secret",
                  thinkingSignature: "abc123",
                },
                { type: "text", text: "hello" },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected gateway method: ${String(method)}`);
    });

    const tool = createSessionsHistoryTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call1", { sessionKey: "main", limit: 1 });
    const messages = (result.details as { messages: unknown[] }).messages;
    const content = (messages[0] as { content?: unknown }).content as unknown[];
    expect(content.some((b) => (b as { type?: unknown }).type === "thinking")).toBe(false);
  });

  it("includeThinking=true preserves thinking blocks but strips thinkingSignature", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const method = (opts as { method?: unknown }).method;
      if (method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "thinking",
                  thinking: "x".repeat(5000),
                  thinkingSignature: "a".repeat(50_000),
                },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected gateway method: ${String(method)}`);
    });

    const tool = createSessionsHistoryTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call1", {
      sessionKey: "main",
      limit: 1,
      includeThinking: true,
    });
    const messages = (result.details as { messages: unknown[] }).messages;
    const content = (messages[0] as { content?: unknown }).content as Array<
      Record<string, unknown>
    >;
    expect(content.some((b) => (b as { type?: unknown }).type === "thinking")).toBe(true);
    const thinking =
      content.find((b) => (b as { type?: unknown }).type === "thinking") ??
      ({} as Record<string, unknown>);
    expect("thinkingSignature" in thinking).toBe(false);
    const thinkingText = (thinking as { thinking?: unknown }).thinking;
    expect(typeof thinkingText).toBe("string");
    expect(String(thinkingText)).toContain("…(truncated)…");
    expect(String(thinkingText).length).toBeLessThanOrEqual(4000);
  });

  it("treats includeThinking='false' and includeTools='false' (string) as false", async () => {
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const method = (opts as { method?: unknown }).method;
      if (method === "chat.history") {
        return {
          messages: [
            { role: "toolResult", content: "tool stuff" },
            {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "secret", thinkingSignature: "abc123" },
                { type: "text", text: "hello" },
              ],
            },
          ],
        };
      }
      throw new Error(`unexpected gateway method: ${String(method)}`);
    });

    const tool = createSessionsHistoryTool({ agentSessionKey: "agent:main:main" });
    const result = await tool.execute("call1", {
      sessionKey: "main",
      limit: 10,
      includeThinking: "false" as never,
      includeTools: "false" as never,
    });
    const messages = (result.details as { messages: Array<{ role?: unknown; content?: unknown }> })
      .messages;
    expect(messages.some((m) => m.role === "toolResult")).toBe(false);
    const content = (messages[0] as { content?: unknown }).content as unknown[];
    expect(content.some((b) => (b as { type?: unknown }).type === "thinking")).toBe(false);
  });

  it("returns a placeholder when a single message exceeds 80KB after sanitization", async () => {
    const bigMessage = {
      role: "assistant",
      content: Array.from({ length: 40 }, () => ({ type: "text", text: "a".repeat(4000) })),
    };
    const res = sanitizeAndCapSessionMessages({
      messages: [bigMessage],
      includeThinking: false,
      maxBytes: SESSIONS_HISTORY_MAX_BYTES,
      placeholderText: "[sessions_history omitted: message too large]",
    });
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0]).toEqual({
      role: "assistant",
      content: "[sessions_history omitted: message too large]",
    });
    expect(res.bytes).toBeLessThanOrEqual(SESSIONS_HISTORY_MAX_BYTES);
  });

  it("handles empty message arrays and empty/undefined/null content blocks", async () => {
    {
      const res = sanitizeAndCapSessionMessages({
        messages: [],
        includeThinking: false,
        maxBytes: SESSIONS_HISTORY_MAX_BYTES,
        placeholderText: "[sessions_history omitted: message too large]",
      });
      expect(res.messages).toEqual([]);
    }

    const res = sanitizeAndCapSessionMessages({
      messages: [
        { role: "assistant" },
        { role: "assistant", content: [] },
        { role: "assistant", content: [undefined, null, { type: "text", text: "ok" }] },
      ],
      includeThinking: false,
      maxBytes: SESSIONS_HISTORY_MAX_BYTES,
      placeholderText: "[sessions_history omitted: message too large]",
    });
    expect(res.messages).toHaveLength(3);
    const third = res.messages[2] as { content?: unknown };
    expect(Array.isArray(third.content)).toBe(true);
    expect((third.content as unknown[]).length).toBe(1);
  });
});
