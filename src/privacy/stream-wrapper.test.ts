import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { PrivacyDetector } from "./detector.js";
import { PrivacyReplacer } from "./replacer.js";
import {
  filterText,
  restoreText,
  createPrivacyFilterContext,
  filterMessages,
  wrapStreamFnPrivacyFilter,
} from "./stream-wrapper.js";

describe("stream-wrapper integration", () => {
  const now = Date.now();
  const usage: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };

  function userMessage(content: UserMessage["content"]): UserMessage {
    return { role: "user", content, timestamp: now };
  }

  function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
    return {
      role: "assistant",
      content,
      api: "openai-completions",
      provider: "openai",
      model: "gpt-test",
      usage,
      stopReason: "stop",
      timestamp: now,
    };
  }

  function toolResultMessage(content: ToolResultMessage["content"]): ToolResultMessage {
    return {
      role: "toolResult",
      toolCallId: "tool_1",
      toolName: "lookup",
      content,
      isError: false,
      timestamp: now,
    };
  }

  describe("createPrivacyFilterContext", () => {
    it("resolves tilde-prefixed mapping store paths", () => {
      const tmpHome = mkdtempSync(join(tmpdir(), "privacy-home-"));
      const prevOpenClawHome = process.env.OPENCLAW_HOME;
      process.env.OPENCLAW_HOME = tmpHome;

      try {
        const ctx = createPrivacyFilterContext("tilde-store", {
          mappings: { storePath: "~/.openclaw/privacy/custom-mappings.enc" },
        });

        filterText("email admin@company.com", ctx);

        const expectedStore = join(tmpHome, ".openclaw", "privacy", "custom-mappings.enc");
        expect(existsSync(expectedStore)).toBe(true);
      } finally {
        if (prevOpenClawHome === undefined) {
          delete process.env.OPENCLAW_HOME;
        } else {
          process.env.OPENCLAW_HOME = prevOpenClawHome;
        }
        rmSync(tmpHome, { recursive: true, force: true });
      }
    });

    it("rejects unsupported encryption algorithms", () => {
      expect(() =>
        createPrivacyFilterContext("bad-algo", {
          encryption: { algorithm: "aes-192-gcm" },
        }),
      ).toThrow(/Unsupported encryption algorithm/);
    });
  });

  describe("filterText + restoreText round-trip", () => {
    it("filters and restores email addresses", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const original = "Please email admin@company.com for access";
      const filtered = filterText(original, ctx);

      expect(filtered).not.toContain("admin@company.com");
      expect(filtered).toContain("@example.net");

      // Simulate LLM echoing back the replacement.
      const llmReply = `I'll contact ${filtered.match(/pf_e\d+@example\.net/)?.[0] ?? ""} right away`;
      const restored = restoreText(llmReply, ctx);
      expect(restored).toContain("admin@company.com");
    });

    it("filters and restores API keys", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const original = "Use this key: sk-proj1234567890abcdefghijklm";
      const filtered = filterText(original, ctx);
      expect(filtered).not.toContain("sk-proj1234567890abcdefghijklm");

      const restored = restoreText(filtered, ctx);
      expect(restored).toBe(original);
    });

    it("handles text with no sensitive content", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const text = "This is a normal message with no secrets.";
      expect(filterText(text, ctx)).toBe(text);
    });

    it("handles empty text", () => {
      const ctx = createPrivacyFilterContext("test-session");
      expect(filterText("", ctx)).toBe("");
    });
  });

  describe("filterMessages", () => {
    it("filters user message text content", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const messages: Message[] = [userMessage("My password=SecretPass123")];

      const filtered = filterMessages(messages, ctx);
      expect(filtered).not.toBe(messages);
      const msg = filtered[0] as { role: string; content: string };
      expect(msg.content).not.toContain("SecretPass123");
      expect(msg.content).toContain("PF_PWD_");
    });

    it("filters user message array content blocks", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const messages: Message[] = [
        userMessage([{ type: "text", text: "key: sk-abcdefghijklmnopqrstuvwxyz1234567890" }]),
      ];

      const filtered = filterMessages(messages, ctx);
      const msg = filtered[0] as { role: string; content: Array<{ type: string; text: string }> };
      expect(msg.content[0].text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
    });

    it("filters user input_text/output_text content blocks", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const messages: Message[] = [
        userMessage([
          { type: "input_text", text: "token sk-proj1234567890abcdefghijklm" } as never,
          { type: "output_text", text: "email admin@company.com" } as never,
        ]),
      ];

      const filtered = filterMessages(messages, ctx);
      const msg = filtered[0] as unknown as { content: Array<{ text?: string }> };
      expect(String(msg.content[0]?.text)).not.toContain("sk-proj1234567890abcdefghijklm");
      expect(String(msg.content[1]?.text)).not.toContain("admin@company.com");
    });

    it("filters assistant toolCall arguments before replay", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const messages: Message[] = [
        assistantMessage([
          {
            type: "toolCall",
            id: "call_1",
            name: "search",
            arguments: {
              query: "contact admin@company.com",
              nested: { token: "Bearer secret-token-123456" },
            },
          },
        ]),
      ];

      const filtered = filterMessages(messages, ctx);
      expect(filtered).not.toBe(messages);
      const msg = filtered[0] as AssistantMessage;
      const block = msg.content[0];
      if (block.type !== "toolCall") {
        throw new Error("expected toolCall block");
      }
      expect(String(block.arguments.query)).not.toContain("admin@company.com");
      expect(JSON.stringify(block.arguments)).not.toContain("secret-token-123456");
    });

    it("filters nested strings inside non-text assistant blocks", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const messages: Message[] = [
        {
          ...assistantMessage([{ type: "text", text: "placeholder" }]),
          content: [
            {
              type: "input_image",
              source: {
                type: "url",
                url: "https://example.test/image.png?token=sk-proj1234567890abcdefghijklm",
              },
            },
          ],
        } as unknown as AssistantMessage,
      ];

      const filtered = filterMessages(messages, ctx);
      const msg = filtered[0] as unknown as { content: unknown };
      expect(JSON.stringify(msg.content)).not.toContain("sk-proj1234567890abcdefghijklm");
    });

    it("returns same array if no changes needed", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const messages: Message[] = [userMessage("Hello there!")];

      const filtered = filterMessages(messages, ctx);
      expect(filtered).toBe(messages);
    });

    it("filters toolResult messages", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const messages: Message[] = [toolResultMessage([{ type: "text", text: "email a@b.com" }])];
      const filtered = filterMessages(messages, ctx);
      expect(filtered).not.toBe(messages);
    });

    it("handles legacy assistant string content without throwing", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const legacy = {
        ...assistantMessage([{ type: "text", text: "placeholder" }]),
        content: "legacy admin@company.com",
      };
      const messages = [legacy] as unknown as Message[];
      const filtered = filterMessages(messages, ctx) as unknown as Array<{ content: unknown }>;
      expect(typeof filtered[0]?.content).toBe("string");
      expect(String(filtered[0]?.content)).not.toContain("admin@company.com");
    });

    it("filters legacy toolResult string content", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const legacy = {
        ...toolResultMessage([{ type: "text", text: "placeholder" }]),
        content: "token sk-proj1234567890abcdefghijklm",
      };
      const messages = [legacy] as unknown as Message[];
      const filtered = filterMessages(messages, ctx) as unknown as Array<{ content: unknown }>;
      expect(typeof filtered[0]?.content).toBe("string");
      expect(String(filtered[0]?.content)).not.toContain("sk-proj1234567890abcdefghijklm");
    });
  });

  describe("disabled config", () => {
    it("passes through when disabled", () => {
      const ctx = createPrivacyFilterContext("test-session", { enabled: false });
      const text = "password=secret123";
      expect(filterText(text, ctx)).toBe(text);
    });
  });

  describe("multiple sensitive items in one text", () => {
    it("handles overlapping and adjacent matches", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const text = "Email: admin@test.com, Phone: 13900001234, Key: sk-abcdefghijklmnopqrstuvwxyz";
      const filtered = filterText(text, ctx);

      expect(filtered).not.toContain("admin@test.com");
      expect(filtered).not.toContain("13900001234");
      expect(filtered).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");

      const restored = restoreText(filtered, ctx);
      expect(restored).toBe(text);
    });
  });

  describe("end-to-end detector + replacer", () => {
    it("detects and replaces various types correctly", () => {
      const detector = new PrivacyDetector("extended");
      const replacer = new PrivacyReplacer("e2e-test");

      const inputs = [
        { text: "user@gmail.com", type: "email" },
        { text: "13812345678", type: "phone_cn" },
        { text: "password=MySecret123", type: "password_assignment" },
        { text: "ghp_1234567890abcdefghijklmnopqrstuvwxyz1234", type: "github_token" },
      ];

      for (const input of inputs) {
        const result = detector.detect(input.text);
        expect(result.hasPrivacyRisk).toBe(true);

        const { replaced } = replacer.replaceAll(input.text, result.matches);
        expect(replaced).not.toBe(input.text);

        const restored = replacer.restore(replaced);
        expect(restored).toBe(input.text);
      }
    });
  });

  describe("stream restore buffering", () => {
    it("restores placeholders when toolcall deltas split replacements across chunks", async () => {
      const ctx = createPrivacyFilterContext("test-session");
      const original = "admin@company.com";
      filterText(`contact ${original}`, ctx);
      const replacement = ctx.replacer.getMappings()[0]?.replacement;
      if (!replacement) {
        throw new Error("expected replacement mapping");
      }

      const splitAt = Math.max(1, Math.floor(replacement.length / 2));
      const baseEvents = [
        { type: "toolcall_delta", contentIndex: 0, delta: replacement.slice(0, splitAt) },
        { type: "toolcall_delta", contentIndex: 0, delta: replacement.slice(splitAt) },
      ];

      const baseFn: StreamFn = () =>
        ({
          async *[Symbol.asyncIterator]() {
            for (const event of baseEvents) {
              yield event;
            }
          },
        }) as unknown as ReturnType<StreamFn>;

      const wrapped = wrapStreamFnPrivacyFilter(baseFn, ctx);
      const stream = wrapped(
        {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-test",
        } as Parameters<StreamFn>[0],
        { messages: [] },
      );

      const deltas: string[] = [];
      for await (const event of stream as AsyncIterable<{ type?: string; delta?: unknown }>) {
        if (event.type === "toolcall_delta" && typeof event.delta === "string") {
          deltas.push(event.delta);
        }
      }
      expect(deltas.join("")).toBe(original);
    });

    it("preserves stream result method after wrapping", async () => {
      const ctx = createPrivacyFilterContext("test-session");
      const finalMessage = assistantMessage([{ type: "text", text: "done" }]);

      const baseFn: StreamFn = () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: "text_delta", delta: "ok" };
          },
          async result() {
            return finalMessage;
          },
        }) as unknown as ReturnType<StreamFn>;

      const wrapped = wrapStreamFnPrivacyFilter(baseFn, ctx);
      const stream = wrapped(
        {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-test",
        } as Parameters<StreamFn>[0],
        { messages: [] },
      );

      const streamWithResult = stream as { result?: () => Promise<AssistantMessage> };
      expect(typeof streamWithResult.result).toBe("function");
      await expect(streamWithResult.result?.()).resolves.toEqual(finalMessage);
    });

    it("restores placeholders in final stream result payloads", async () => {
      const ctx = createPrivacyFilterContext("test-session");
      const original = "admin@company.com";
      filterText(`contact ${original}`, ctx);
      const replacement = ctx.replacer.getMappings()[0]?.replacement;
      if (!replacement) {
        throw new Error("expected replacement mapping");
      }

      const baseFn: StreamFn = () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: "text_delta", delta: "partial" };
          },
          async result() {
            return assistantMessage([{ type: "text", text: `final ${replacement}` }]);
          },
        }) as unknown as ReturnType<StreamFn>;

      const wrapped = wrapStreamFnPrivacyFilter(baseFn, ctx);
      const stream = wrapped(
        {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-test",
        } as Parameters<StreamFn>[0],
        { messages: [] },
      );

      const final = await (stream as { result: () => Promise<AssistantMessage> }).result();
      const first = final.content[0];
      if (!first || first.type !== "text") {
        throw new Error("expected text content");
      }
      expect(first.text).toContain(original);
      expect(first.text).not.toContain("pf_");
    });

    it("restores placeholders in text_delta chunks", async () => {
      const ctx = createPrivacyFilterContext("test-session");
      const original = "admin@company.com";
      filterText(`contact ${original}`, ctx);
      const replacement = ctx.replacer.getMappings()[0]?.replacement;
      if (!replacement) {
        throw new Error("expected replacement mapping");
      }

      const baseFn: StreamFn = () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: "text_delta", contentIndex: 0, delta: replacement };
          },
          async result() {
            return assistantMessage([{ type: "text", text: "done" }]);
          },
        }) as unknown as ReturnType<StreamFn>;

      const wrapped = wrapStreamFnPrivacyFilter(baseFn, ctx);
      const stream = wrapped(
        {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-test",
        } as Parameters<StreamFn>[0],
        { messages: [] },
      );

      const deltas: string[] = [];
      for await (const event of stream as AsyncIterable<{ type?: string; delta?: unknown }>) {
        if (event.type === "text_delta" && typeof event.delta === "string") {
          deltas.push(event.delta);
        }
      }
      expect(deltas.join("")).toContain(original);
      expect(deltas.join("")).not.toContain("pf_");
    });

    it("restores placeholders in text_end content payloads", async () => {
      const ctx = createPrivacyFilterContext("test-session");
      const original = "admin@company.com";
      filterText(`contact ${original}`, ctx);
      const replacement = ctx.replacer.getMappings()[0]?.replacement;
      if (!replacement) {
        throw new Error("expected replacement mapping");
      }

      const baseFn: StreamFn = () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: "text_end", contentIndex: 0, content: replacement };
          },
        }) as unknown as ReturnType<StreamFn>;

      const wrapped = wrapStreamFnPrivacyFilter(baseFn, ctx);
      const stream = wrapped(
        {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-test",
        } as Parameters<StreamFn>[0],
        { messages: [] },
      );

      const events: Array<Record<string, unknown>> = [];
      for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(String(events[0].content)).toContain(original);
      expect(String(events[0].content)).not.toContain("pf_");
    });

    it("restores placeholders in toolcall_end payloads", async () => {
      const ctx = createPrivacyFilterContext("test-session");
      const original = "admin@company.com";
      filterText(`contact ${original}`, ctx);
      const replacement = ctx.replacer.getMappings()[0]?.replacement;
      if (!replacement) {
        throw new Error("expected replacement mapping");
      }

      const baseFn: StreamFn = () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: { arguments: { email: replacement } },
              partial: { arguments: JSON.stringify({ email: replacement }) },
              message: {
                role: "assistant",
                content: [
                  { type: "toolCall", id: "c1", name: "lookup", arguments: { email: replacement } },
                ],
              },
            };
          },
        }) as unknown as ReturnType<StreamFn>;

      const wrapped = wrapStreamFnPrivacyFilter(baseFn, ctx);
      const stream = wrapped(
        {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-test",
        } as Parameters<StreamFn>[0],
        { messages: [] },
      );

      const events: Array<Record<string, unknown>> = [];
      for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(JSON.stringify(event.toolCall)).toContain(original);
      expect(JSON.stringify(event.partial)).toContain(original);
      expect(JSON.stringify(event.message)).toContain(original);
      expect(JSON.stringify(event)).not.toContain("pf_");
    });

    it("restores placeholders in message_end assistant payloads", async () => {
      const ctx = createPrivacyFilterContext("test-session");
      const original = "admin@company.com";
      filterText(`contact ${original}`, ctx);
      const replacement = ctx.replacer.getMappings()[0]?.replacement;
      if (!replacement) {
        throw new Error("expected replacement mapping");
      }

      const baseFn: StreamFn = () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "message_end",
              message: assistantMessage([{ type: "text", text: `final ${replacement}` }]),
            };
          },
        }) as unknown as ReturnType<StreamFn>;

      const wrapped = wrapStreamFnPrivacyFilter(baseFn, ctx);
      const stream = wrapped(
        {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-test",
        } as Parameters<StreamFn>[0],
        { messages: [] },
      );

      const events: Array<Record<string, unknown>> = [];
      for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(JSON.stringify(event.message)).toContain(original);
      expect(JSON.stringify(event.message)).not.toContain("pf_");
    });

    it("restores placeholders in done message payloads", async () => {
      const ctx = createPrivacyFilterContext("test-session");
      const original = "admin@company.com";
      filterText(`contact ${original}`, ctx);
      const replacement = ctx.replacer.getMappings()[0]?.replacement;
      if (!replacement) {
        throw new Error("expected replacement mapping");
      }

      const baseFn: StreamFn = () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: "done",
              reason: "stop",
              message: assistantMessage([{ type: "text", text: `final ${replacement}` }]),
            };
          },
        }) as unknown as ReturnType<StreamFn>;

      const wrapped = wrapStreamFnPrivacyFilter(baseFn, ctx);
      const stream = wrapped(
        {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-test",
        } as Parameters<StreamFn>[0],
        { messages: [] },
      );

      const events: Array<Record<string, unknown>> = [];
      for await (const event of stream as AsyncIterable<Record<string, unknown>>) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      const event = events[0];
      expect(JSON.stringify(event.message)).toContain(original);
      expect(JSON.stringify(event.message)).not.toContain("pf_");
    });

    it("restores placeholders in streamed reasoning deltas", async () => {
      const ctx = createPrivacyFilterContext("test-session");
      const original = "admin@company.com";
      filterText(`contact ${original}`, ctx);
      const replacement = ctx.replacer.getMappings()[0]?.replacement;
      if (!replacement) {
        throw new Error("expected replacement mapping");
      }

      const splitAt = Math.max(1, Math.floor(replacement.length / 2));
      const baseFn: StreamFn = () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: "thinking_delta", contentIndex: 0, delta: replacement.slice(0, splitAt) };
            yield { type: "thinking_delta", contentIndex: 0, delta: replacement.slice(splitAt) };
          },
        }) as unknown as ReturnType<StreamFn>;

      const wrapped = wrapStreamFnPrivacyFilter(baseFn, ctx);
      const stream = wrapped(
        {
          api: "openai-completions",
          provider: "openai",
          id: "gpt-test",
        } as Parameters<StreamFn>[0],
        { messages: [] },
      );

      const deltas: string[] = [];
      for await (const event of stream as AsyncIterable<{ type?: string; delta?: unknown }>) {
        if (event.type === "thinking_delta" && typeof event.delta === "string") {
          deltas.push(event.delta);
        }
      }
      expect(deltas.join("")).toContain(original);
      expect(deltas.join("")).not.toContain("pf_");
    });
  });
});
