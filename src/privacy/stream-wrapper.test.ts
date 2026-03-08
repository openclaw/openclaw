import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Message, Context as PiContext } from "@mariozechner/pi-ai";
import { describe, expect, it, vi } from "vitest";
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

    it("does not replace high-entropy or bare-password heuristic matches in stream filter", () => {
      const ctx = createPrivacyFilterContext("test-session");
      // mkdtemp-style path with random suffix — should NOT be replaced.
      const text =
        'Call the read tool on "/tmp/openclaw-gw-mock-home-5OPWk6/openclaw/' +
        '.openclaw-tool-probe.7f283e86-a8ff-45fa-80d5-d0326264b8dd.txt"';
      const filtered = filterText(text, ctx);
      expect(filtered).toContain("7f283e86-a8ff-45fa-80d5-d0326264b8dd");
      expect(filtered).not.toContain("pf_ent_");
    });

    it("handles empty text", () => {
      const ctx = createPrivacyFilterContext("test-session");
      expect(filterText("", ctx)).toBe("");
    });

    it("warns when mapping persistence fails", () => {
      const ctx = createPrivacyFilterContext(`test-session-${Date.now()}`);
      const appendSpy = vi.spyOn(ctx.store, "append").mockImplementation(() => {
        throw new Error("disk full");
      });
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      try {
        const filtered = filterText("Please email admin@company.com", ctx);
        expect(filtered).not.toContain("admin@company.com");
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("[privacy] Failed to persist mappings for session test-session"),
        );
      } finally {
        appendSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });
  });

  describe("filterMessages", () => {
    it("filters user message text content", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const messages: Message[] = [
        { role: "user", content: "My password=SecretPass123", timestamp: Date.now() },
      ];

      const filtered = filterMessages(messages, ctx);
      expect(filtered).not.toBe(messages);
      const msg = filtered[0] as { role: string; content: string };
      expect(msg.content).not.toContain("SecretPass123");
      expect(msg.content).toContain("PF_PWD_");
    });

    it("filters user message array content blocks", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const messages: Message[] = [
        {
          role: "user",
          content: [{ type: "text", text: "key: sk-abcdefghijklmnopqrstuvwxyz1234567890" }],
          timestamp: Date.now(),
        },
      ];

      const filtered = filterMessages(messages, ctx);
      const msg = filtered[0] as { role: string; content: Array<{ type: string; text: string }> };
      expect(msg.content[0].text).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
    });

    it("does not modify system messages", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const messages = [
        { role: "system", content: "password=admin123456" },
      ] as unknown as Message[];

      const filtered = filterMessages(messages, ctx);
      expect(filtered).toBe(messages);
    });

    it("returns same array if no changes needed", () => {
      const ctx = createPrivacyFilterContext("test-session");
      const messages: Message[] = [
        { role: "user", content: "Hello there!", timestamp: Date.now() },
      ];

      const filtered = filterMessages(messages, ctx);
      expect(filtered).toBe(messages);
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

  describe("stream wrapper behavior", () => {
    it("preserves original stream methods like result()", async () => {
      const ctx = createPrivacyFilterContext("stream-methods-session");
      const streamLike = {
        async result() {
          return { ok: true };
        },
        [Symbol.asyncIterator]() {
          let done = false;
          return {
            async next() {
              if (done) {
                return { done: true, value: undefined };
              }
              done = true;
              return { done: false, value: { text: "admin@company.com" } };
            },
          };
        },
      };

      const baseFn = () => streamLike;
      const wrappedFn = wrapStreamFnPrivacyFilter(baseFn as unknown as StreamFn, ctx);
      const wrapped = (await Promise.resolve(
        wrappedFn(
          {} as unknown as Parameters<StreamFn>[0],
          { messages: [] } as unknown as PiContext,
          undefined,
        ),
      )) as unknown as typeof streamLike;

      const result = await wrapped.result();
      expect(result.ok).toBe(true);
    });
  });
});
