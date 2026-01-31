import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateSlugViaLLM } from "./llm-slug-generator.js";
import type { OpenClawConfig } from "../config/config.js";
import type { EmbeddedPiRunResult } from "../agents/pi-embedded.js";

const runEmbeddedPiAgentMock = vi.fn<
  Parameters<typeof import("../agents/pi-embedded.js").runEmbeddedPiAgent>,
  Promise<EmbeddedPiRunResult>
>();

vi.mock("../agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: (...args: unknown[]) => runEmbeddedPiAgentMock(...args),
}));

describe("generateSlugViaLLM", () => {
  beforeEach(() => {
    runEmbeddedPiAgentMock.mockReset();
  });

  describe("model resolution", () => {
    it("uses configured default model from agents.defaults.model.primary", async () => {
      // Arrange: Config with custom default model (Sonnet instead of Opus)
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-sonnet-4-5",
            },
          },
        },
      };

      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: "test-slug" }],
        meta: { runId: "test-run", sessionId: "test-session" },
      });

      // Act
      await generateSlugViaLLM({
        sessionContent: "Some conversation about testing",
        cfg,
      });

      // Assert: Should use Sonnet, not hardcoded Opus
      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const callArgs = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(callArgs).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        config: cfg,
      });
    });

    it("uses configured default model with custom provider", async () => {
      // Arrange: Config with OpenRouter model
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: {
              primary: "openrouter/anthropic/claude-3.5-sonnet",
            },
          },
        },
      };

      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: "custom-provider-slug" }],
        meta: { runId: "test-run", sessionId: "test-session" },
      });

      // Act
      await generateSlugViaLLM({
        sessionContent: "Testing custom provider",
        cfg,
      });

      // Assert: Should use OpenRouter provider
      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const callArgs = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(callArgs).toMatchObject({
        provider: "openrouter",
        model: "anthropic/claude-3.5-sonnet",
        config: cfg,
      });
    });

    it("falls back to DEFAULT_MODEL when no model.primary is configured", async () => {
      // Arrange: Empty config (no custom model)
      const cfg: OpenClawConfig = {};

      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: "default-model-slug" }],
        meta: { runId: "test-run", sessionId: "test-session" },
      });

      // Act
      await generateSlugViaLLM({
        sessionContent: "Testing default fallback",
        cfg,
      });

      // Assert: Should fall back to DEFAULT_MODEL (claude-opus-4-5)
      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const callArgs = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(callArgs).toMatchObject({
        provider: "anthropic",
        model: "claude-opus-4-5",
        config: cfg,
      });
    });

    it("uses Haiku when configured as default model", async () => {
      // Arrange: Config with Haiku as default
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-3-5-haiku-20241022",
            },
          },
        },
      };

      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: "haiku-slug" }],
        meta: { runId: "test-run", sessionId: "test-session" },
      });

      // Act
      await generateSlugViaLLM({
        sessionContent: "Budget-friendly slug generation",
        cfg,
      });

      // Assert: Should use Haiku
      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const callArgs = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      expect(callArgs).toMatchObject({
        provider: "anthropic",
        model: "claude-3-5-haiku-20241022",
        config: cfg,
      });
    });
  });

  describe("slug generation", () => {
    it("generates valid slug from LLM response", async () => {
      const cfg: OpenClawConfig = {};

      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: "api-design" }],
        meta: { runId: "test-run", sessionId: "test-session" },
      });

      const slug = await generateSlugViaLLM({
        sessionContent: "Discussion about API design patterns",
        cfg,
      });

      expect(slug).toBe("api-design");
    });

    it("cleans up LLM response with extra characters", async () => {
      const cfg: OpenClawConfig = {};

      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: "  Bug Fix!  " }],
        meta: { runId: "test-run", sessionId: "test-session" },
      });

      const slug = await generateSlugViaLLM({
        sessionContent: "Bug fix discussion",
        cfg,
      });

      expect(slug).toBe("bug-fix");
    });

    it("truncates long slugs to 30 characters", async () => {
      const cfg: OpenClawConfig = {};

      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: "this-is-a-very-long-slug-that-should-be-truncated-significantly" }],
        meta: { runId: "test-run", sessionId: "test-session" },
      });

      const slug = await generateSlugViaLLM({
        sessionContent: "Long discussion",
        cfg,
      });

      // Verify length is enforced (implementation slices before final cleanup)
      expect(slug?.length).toBeLessThanOrEqual(30);
      expect(slug).toMatch(/^this-is-a-very-long-slug/);
    });

    it("returns null when LLM returns no payloads", async () => {
      const cfg: OpenClawConfig = {};

      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [],
        meta: { runId: "test-run", sessionId: "test-session" },
      });

      const slug = await generateSlugViaLLM({
        sessionContent: "Test content",
        cfg,
      });

      expect(slug).toBeNull();
    });

    it("returns null when LLM returns empty text", async () => {
      const cfg: OpenClawConfig = {};

      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: "" }],
        meta: { runId: "test-run", sessionId: "test-session" },
      });

      const slug = await generateSlugViaLLM({
        sessionContent: "Test content",
        cfg,
      });

      expect(slug).toBeNull();
    });

    it("returns null when embedded agent throws error", async () => {
      const cfg: OpenClawConfig = {};

      runEmbeddedPiAgentMock.mockRejectedValue(new Error("LLM timeout"));

      const slug = await generateSlugViaLLM({
        sessionContent: "Test content",
        cfg,
      });

      expect(slug).toBeNull();
    });
  });

  describe("embedded agent parameters", () => {
    it("passes correct parameters to runEmbeddedPiAgent", async () => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-sonnet-4-5",
            },
          },
        },
      };

      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: "test-slug" }],
        meta: { runId: "test-run", sessionId: "test-session" },
      });

      await generateSlugViaLLM({
        sessionContent: "Testing parameters",
        cfg,
      });

      expect(runEmbeddedPiAgentMock).toHaveBeenCalledTimes(1);
      const callArgs = runEmbeddedPiAgentMock.mock.calls[0]?.[0];

      // Verify all expected parameters are present
      expect(callArgs).toMatchObject({
        config: cfg,
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        timeoutMs: 15_000,
      });

      // Verify prompt includes session content
      expect(callArgs?.prompt).toContain("Testing parameters");
      expect(callArgs?.prompt).toContain("1-2 word filename slug");

      // Verify session parameters
      expect(callArgs?.sessionId).toMatch(/^slug-generator-\d+$/);
      expect(callArgs?.sessionKey).toBe("temp:slug-generator");
      expect(callArgs?.runId).toMatch(/^slug-gen-\d+$/);

      // Verify temp session file path
      expect(callArgs?.sessionFile).toContain("openclaw-slug-");
      expect(callArgs?.sessionFile).toContain("session.jsonl");
    });

    it("truncates session content to 2000 characters in prompt", async () => {
      const cfg: OpenClawConfig = {};
      const longContent = "a".repeat(3000);

      runEmbeddedPiAgentMock.mockResolvedValue({
        payloads: [{ text: "truncated-slug" }],
        meta: { runId: "test-run", sessionId: "test-session" },
      });

      await generateSlugViaLLM({
        sessionContent: longContent,
        cfg,
      });

      const callArgs = runEmbeddedPiAgentMock.mock.calls[0]?.[0];
      const promptContentMatch = callArgs?.prompt.match(
        /Conversation summary:\n([\s\S]+)\n\nReply/,
      );
      const extractedContent = promptContentMatch?.[1] ?? "";

      expect(extractedContent.length).toBeLessThanOrEqual(2000);
    });
  });
});
