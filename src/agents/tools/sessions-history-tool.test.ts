// sessions_history tool tests cover recall redaction and input validation for
// session transcript history returned to models.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { callGateway as gatewayCall } from "../../gateway/call.js";
import { deleteTestEnvValue, setTestEnvValue } from "../../test-utils/env.js";

type CallGatewayRequest = Parameters<typeof gatewayCall>[0];
type HistoryMessage = {
  role: string;
  content: string;
  __openclaw: { seq: number };
};

let createSessionsHistoryTool: typeof import("./sessions-history-tool.js").createSessionsHistoryTool;
let previousConfigPath: string | undefined;
let tempDir: string | undefined;

function useLoggingConfig(name: string, logging: Record<string, unknown>): void {
  if (!tempDir) {
    throw new Error("tempDir not initialized");
  }
  const configPath = path.join(tempDir, name);
  fs.writeFileSync(configPath, `${JSON.stringify({ logging })}\n`, "utf8");
  setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
}

function createHistoryToolWithMessage(content: string) {
  return createSessionsHistoryTool({
    config: {},
    callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
      if (request.method === "chat.history") {
        return {
          messages: [
            {
              role: "user",
              content,
            },
          ],
        } as T;
      }
      return {} as T;
    },
  });
}

function readHistoryDetails(result: { details: unknown }) {
  return result.details as Record<string, unknown>;
}

function readMessageSeq(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const meta = (message as Record<string, unknown>)["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return undefined;
  }
  const seq = (meta as Record<string, unknown>).seq;
  return typeof seq === "number" ? seq : undefined;
}

function createHistoryToolWithMessages(messages: unknown[]) {
  return createSessionsHistoryTool({
    agentSessionKey: "agent:alfred:whatsapp:group:120363425559039020@g.us",
    config: {},
    callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
      if (request.method === "chat.history") {
        return { messages } as T;
      }
      return {} as T;
    },
  });
}

function extractVisibleText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  return content
    .map((block) =>
      block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
        ? (block as { text: string }).text
        : undefined,
    )
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

describe("sessions_history redaction", () => {
  beforeAll(async () => {
    previousConfigPath = process.env.OPENCLAW_CONFIG_PATH;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sessions-history-redact-"));
    useLoggingConfig("redaction-off.json", { redactSensitive: "off" });
    ({ createSessionsHistoryTool } = await import("./sessions-history-tool.js"));
  });

  afterAll(() => {
    if (previousConfigPath === undefined) {
      deleteTestEnvValue("OPENCLAW_CONFIG_PATH");
    } else {
      setTestEnvValue("OPENCLAW_CONFIG_PATH", previousConfigPath);
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("redacts recalled session text even when log redaction is disabled", async () => {
    // Recalled transcript content is model-visible, so it is always redacted
    // even when normal logging redaction is configured off.
    useLoggingConfig("redaction-off.json", { redactSensitive: "off" });
    const tool = createHistoryToolWithMessage("OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789");

    const result = await tool.execute("call-1", { sessionKey: "main" });
    const serialized = JSON.stringify(result.details);

    expect(serialized).not.toContain("sk-or-v1-abcdef0123456789");
    expect(serialized).toContain("OPENROUTER_API_KEY=");
    expect((result.details as { contentRedacted?: unknown }).contentRedacted).toBe(true);
  });

  it("applies custom redaction patterns to recalled session text", async () => {
    useLoggingConfig("custom-patterns.json", {
      redactSensitive: "off",
      redactPatterns: [String.raw`\binternal-ticket-[A-Za-z0-9]+\b`],
    });
    const tool = createHistoryToolWithMessage("follow up on internal-ticket-AbC12345");

    const result = await tool.execute("call-1", { sessionKey: "main" });
    const serialized = JSON.stringify(result.details);

    expect(serialized).not.toContain("internal-ticket-AbC12345");
    expect(serialized).toContain("intern");
    expect((result.details as { contentRedacted?: unknown }).contentRedacted).toBe(true);
  });

  it.each([0, 1.5])("rejects invalid limit value %s", async (limit) => {
    const tool = createHistoryToolWithMessage("hello");

    await expect(tool.execute("call-1", { sessionKey: "main", limit })).rejects.toThrow(
      "limit must be a positive integer",
    );
  });

  it.each([-1, 1.5])("rejects invalid offset value %s", async (offset) => {
    const tool = createHistoryToolWithMessage("hello");

    await expect(tool.execute("call-1", { sessionKey: "main", offset })).rejects.toThrow(
      "offset must be a non-negative integer",
    );
  });

  it("preserves the bounded default history request", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        return { messages: [{ role: "assistant", content: "latest" }] } as T;
      },
    });

    const result = await tool.execute("call-1", { sessionKey: "main", limit: 2 });

    expect(requests[0]).toMatchObject({
      method: "chat.history",
      params: { sessionKey: "main", limit: 2 },
    });
    expect((requests[0].params as Record<string, unknown>).offset).toBeUndefined();
    expect((result.details as Record<string, unknown>).offset).toBeUndefined();
  });

  it("requests explicit offset pages and returns continuation metadata", async () => {
    const requests: CallGatewayRequest[] = [];
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
        requests.push(request);
        return {
          messages: [
            { role: "user", content: "newer" },
            { role: "assistant", content: "latest" },
          ],
          offset: 0,
          nextOffset: 2,
          hasMore: true,
          totalMessages: 4,
        } as T;
      },
    });

    const result = await tool.execute("call-1", { sessionKey: "main", limit: 2, offset: 0 });

    expect(requests[0]).toMatchObject({
      method: "chat.history",
      params: { sessionKey: "main", limit: 2, offset: 0 },
    });
    expect(result.details).toMatchObject({
      offset: 0,
      nextOffset: 2,
      hasMore: true,
      totalMessages: 4,
    });
  });

  it("recomputes pagination after the tool byte cap drops older returned messages", async () => {
    const messages: HistoryMessage[] = Array.from({ length: 30 }, (_, index) => ({
      role: "assistant",
      content: `message-${index + 1} ${"x".repeat(10_000)}`,
      __openclaw: { seq: index + 1 },
    }));
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(): Promise<T> =>
        ({
          messages,
          offset: 0,
          nextOffset: 30,
          hasMore: false,
          totalMessages: 30,
        }) as T,
    });

    const result = await tool.execute("call-1", { sessionKey: "main", offset: 0 });
    const details = readHistoryDetails(result);
    const returnedMessages = details.messages as unknown[];
    const oldestReturnedSeq = readMessageSeq(returnedMessages[0]);

    expect(returnedMessages.length).toBeGreaterThan(0);
    expect(returnedMessages.length).toBeLessThan(messages.length);
    expect(typeof oldestReturnedSeq).toBe("number");
    const expectedNextOffset = 30 - oldestReturnedSeq! + 1;
    expect(oldestReturnedSeq).toBeGreaterThan(1);
    expect(details).toMatchObject({
      offset: 0,
      nextOffset: expectedNextOffset,
      hasMore: true,
      totalMessages: 30,
      truncated: true,
      droppedMessages: true,
    });
    expect(details.nextOffset).not.toBe(30);
  });

  it("uses the oldest visible message for pagination after tool messages are filtered", async () => {
    const tool = createSessionsHistoryTool({
      config: {},
      callGateway: async <T = Record<string, unknown>>(): Promise<T> =>
        ({
          messages: [
            { role: "tool", content: "hidden", __openclaw: { seq: 6 } },
            { role: "assistant", content: "visible", __openclaw: { seq: 7 } },
            { role: "assistant", content: "latest", __openclaw: { seq: 8 } },
          ],
          offset: 0,
          nextOffset: 5,
          hasMore: true,
          totalMessages: 10,
        }) as T,
    });

    const result = await tool.execute("call-1", { sessionKey: "main", offset: 0 });
    const details = readHistoryDetails(result);

    expect(details.messages).toEqual([
      { role: "assistant", content: "visible", __openclaw: { seq: 7 } },
      { role: "assistant", content: "latest", __openclaw: { seq: 8 } },
    ]);
    expect(details).toMatchObject({
      offset: 0,
      nextOffset: 4,
      hasMore: true,
      totalMessages: 10,
    });
  });

  it("projects visible WhatsApp group sends without delivery artifacts by default", async () => {
    const deliveredText = "Here is the Amazon link: https://example.test/item";
    const rawMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "Can you send the Amazon link?" }],
      },
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: deliveredText }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-message-wa",
            name: "message",
            arguments: {
              action: "send",
              message: deliveredText,
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "message",
        toolCallId: "call-message-wa",
        content: { ok: true, messageId: "wamid.1", chatId: "120363425559039020@g.us" },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Sent the Amazon link in WhatsApp." }],
      },
    ];
    const tool = createHistoryToolWithMessages(rawMessages);

    const result = await tool.execute("call-wa-history", {
      sessionKey: "agent:alfred:whatsapp:group:120363425559039020@g.us",
    });
    const details = result.details as { messages?: unknown[] };

    expect(details.messages?.map(extractVisibleText)).toEqual([
      "Can you send the Amazon link?",
      deliveredText,
    ]);
    expect(details.messages).toContainEqual(
      expect.objectContaining({
        role: "assistant",
        openclawMessageToolMirror: expect.objectContaining({ toolName: "message" }),
      }),
    );
    expect(details.messages).not.toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "delivery-mirror" }),
    );
    expect(JSON.stringify(details.messages)).not.toContain('"type":"toolCall"');
    expect(JSON.stringify(details.messages)).not.toContain("Sent the Amazon link in WhatsApp.");

    const withTools = await tool.execute("call-wa-history-tools", {
      sessionKey: "agent:alfred:whatsapp:group:120363425559039020@g.us",
      includeTools: true,
    });
    const withToolsDetails = withTools.details as { messages?: unknown[] };
    expect(withToolsDetails.messages).toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "delivery-mirror" }),
    );
    expect(JSON.stringify(withToolsDetails.messages)).toContain("toolCall");
  });

  it("keeps bounded standalone WhatsApp delivery mirrors when the synthetic mirror is outside the window", async () => {
    const deliveredText = "Here is the redacted account update.";
    const tool = createHistoryToolWithMessages([
      {
        role: "user",
        content: [{ type: "text", text: "Please send the redacted update." }],
      },
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: deliveredText }],
      },
    ]);

    const result = await tool.execute("call-wa-history-bounded", {
      sessionKey: "agent:alfred:whatsapp:group:120363425559039020@g.us",
      limit: 2,
    });
    const details = result.details as { messages?: unknown[] };

    expect(details.messages?.map(extractVisibleText)).toEqual([
      "Please send the redacted update.",
      deliveredText,
    ]);
    expect(details.messages).toContainEqual(
      expect.objectContaining({ provider: "openclaw", model: "delivery-mirror" }),
    );
  });

  it("keeps standalone delivery mirrors when a later synthetic mirror has identical text", async () => {
    const repeatedText = "Done.";
    const tool = createHistoryToolWithMessages([
      {
        role: "user",
        content: [{ type: "text", text: "Send the first redacted update." }],
      },
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: repeatedText }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Send the second redacted update." }],
      },
      {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: [{ type: "text", text: repeatedText }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-message-repeated",
            name: "message",
            arguments: {
              action: "send",
              message: repeatedText,
            },
          },
        ],
      },
      {
        role: "toolResult",
        toolName: "message",
        toolCallId: "call-message-repeated",
        content: { ok: true, messageId: "wamid.2", chatId: "120363425559039020@g.us" },
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Sent the update in WhatsApp." }],
      },
    ]);

    const result = await tool.execute("call-wa-history-repeated", {
      sessionKey: "agent:alfred:whatsapp:group:120363425559039020@g.us",
    });
    const details = result.details as { messages?: unknown[] };
    const messages = details.messages ?? [];

    expect(messages.map(extractVisibleText)).toEqual([
      "Send the first redacted update.",
      repeatedText,
      "Send the second redacted update.",
      repeatedText,
    ]);
    expect(
      messages.filter(
        (message) =>
          message &&
          typeof message === "object" &&
          (message as { provider?: unknown }).provider === "openclaw" &&
          (message as { model?: unknown }).model === "delivery-mirror",
      ),
    ).toHaveLength(1);
    expect(
      messages.filter(
        (message) =>
          message &&
          typeof message === "object" &&
          Boolean((message as { openclawMessageToolMirror?: unknown }).openclawMessageToolMirror),
      ),
    ).toHaveLength(1);
  });
});
