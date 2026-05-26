import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { callGateway as gatewayCall } from "../../gateway/call.js";

type CallGatewayRequest = Parameters<typeof gatewayCall>[0];

let createSessionsHistoryTool: typeof import("./sessions-history-tool.js").createSessionsHistoryTool;
let previousConfigPath: string | undefined;
let tempDir: string | undefined;

function useLoggingConfig(name: string, logging: Record<string, unknown>): void {
  if (!tempDir) {
    throw new Error("tempDir not initialized");
  }
  const configPath = path.join(tempDir, name);
  fs.writeFileSync(configPath, `${JSON.stringify({ logging })}\n`, "utf8");
  process.env.OPENCLAW_CONFIG_PATH = configPath;
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

function createHistoryToolWithMessages(messages: Array<Record<string, unknown>>) {
  return createSessionsHistoryTool({
    config: {},
    callGateway: async <T = Record<string, unknown>>(request: CallGatewayRequest): Promise<T> => {
      if (request.method === "chat.history") {
        return { messages } as T;
      }
      return {} as T;
    },
  });
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
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = previousConfigPath;
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("redacts recalled session text even when log redaction is disabled", async () => {
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

  it("filters delivery-mirror assistant turns so dashboards no longer see duplicated replies (issue #85669)", async () => {
    useLoggingConfig("filter-mirror.json", { redactSensitive: "off" });
    const tool = createHistoryToolWithMessages([
      { role: "user", content: "ping" },
      { role: "assistant", provider: "anthropic", model: "claude-opus-4-6", content: "pong" },
      { role: "assistant", provider: "openclaw", model: "delivery-mirror", content: "pong" },
    ]);

    const result = await tool.execute("call-1", { sessionKey: "main" });
    const messages = (result.details as { messages: Array<Record<string, unknown>> }).messages;

    expect(messages).toHaveLength(2);
    expect(messages.map((m) => `${m.role}:${m.provider ?? ""}`)).toEqual([
      "user:",
      "assistant:anthropic",
    ]);
  });

  it("filters gateway-injected assistant turns the same way", async () => {
    useLoggingConfig("filter-gateway-injected.json", { redactSensitive: "off" });
    const tool = createHistoryToolWithMessages([
      { role: "user", content: "hello" },
      { role: "assistant", provider: "openclaw", model: "gateway-injected", content: "noop" },
      { role: "assistant", provider: "openai", model: "gpt-5.5", content: "hi" },
    ]);

    const result = await tool.execute("call-1", { sessionKey: "main" });
    const messages = (result.details as { messages: Array<Record<string, unknown>> }).messages;

    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.model ?? null)).toEqual([null, "gpt-5.5"]);
  });

  it("keeps openclaw-provider assistant turns whose model is not a transcript-only marker", async () => {
    useLoggingConfig("filter-openclaw-other.json", { redactSensitive: "off" });
    const tool = createHistoryToolWithMessages([
      {
        role: "assistant",
        provider: "openclaw",
        model: "best-effort-summary",
        content: "summary",
      },
      { role: "assistant", provider: "openclaw", model: "delivery-mirror", content: "drop me" },
    ]);

    const result = await tool.execute("call-1", { sessionKey: "main" });
    const messages = (result.details as { messages: Array<Record<string, unknown>> }).messages;

    expect(messages).toHaveLength(1);
    expect(messages[0]?.model).toBe("best-effort-summary");
  });

  it("preserves turn order when delivery-mirror duplicates are interleaved with real assistant turns", async () => {
    useLoggingConfig("filter-interleaved.json", { redactSensitive: "off" });
    const tool = createHistoryToolWithMessages([
      { role: "user", content: "one" },
      { role: "assistant", provider: "anthropic", model: "claude-opus-4-6", content: "reply 1" },
      { role: "assistant", provider: "openclaw", model: "delivery-mirror", content: "reply 1" },
      { role: "user", content: "two" },
      { role: "assistant", provider: "anthropic", model: "claude-opus-4-6", content: "reply 2" },
      { role: "assistant", provider: "openclaw", model: "delivery-mirror", content: "reply 2" },
    ]);

    const result = await tool.execute("call-1", { sessionKey: "main" });
    const messages = (
      result.details as {
        messages: Array<Record<string, unknown>>;
      }
    ).messages;

    expect(messages.map((m) => `${m.role}:${m.content}`)).toEqual([
      "user:one",
      "assistant:reply 1",
      "user:two",
      "assistant:reply 2",
    ]);
  });
});
