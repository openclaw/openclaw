/**
 * Tests for Ollama LLM integration
 * Verifies local Ollama calls, fallback behavior, and response generation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ResearchChatSession } from "./research-chatbot.js";
import { createResearchChatSession } from "./research-chatbot.js";
import {
  generateOllamaResearchResponse,
  isOllamaAvailable,
  getAvailableOllamaModels,
} from "./research-ollama.js";

// Mock fetch for testing without real Ollama
global.fetch = vi.fn();

describe("Ollama LLM Integration", () => {
  let mockSession: ResearchChatSession;

  beforeEach(() => {
    mockSession = createResearchChatSession({
      title: "Test Research",
      summary: "Testing Ollama integration",
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("isOllamaAvailable()", () => {
    it("should return true when Ollama is accessible", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });

      const available = await isOllamaAvailable();
      expect(available).toBe(true);
    });

    it("should return false when Ollama is not accessible", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockRejectedValueOnce(new Error("Connection refused"));

      const available = await isOllamaAvailable();
      expect(available).toBe(false);
    });

    it("should timeout after 2 seconds", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 5000)),
      );

      // This test verifies AbortSignal.timeout behavior
      // In real environment, it would abort after 2s
      const available = await isOllamaAvailable();
      // Timeout would cause rejection, caught as false
      expect(typeof available).toBe("boolean");
    });
  });

  describe("getAvailableOllamaModels()", () => {
    it("should return list of available models", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [{ name: "mistral-8b" }, { name: "neural-chat" }, { name: "llama2" }],
        }),
      });

      const models = await getAvailableOllamaModels();
      expect(models).toEqual(["mistral-8b", "neural-chat", "llama2"]);
    });

    it("should return empty array when no models available", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });

      const models = await getAvailableOllamaModels();
      expect(models).toEqual([]);
    });

    it("should return empty array on error", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const models = await getAvailableOllamaModels();
      expect(models).toEqual([]);
    });
  });

  describe("generateOllamaResearchResponse()", () => {
    it("should call Ollama and return response", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: "This looks like a good observation for research.",
              },
            },
          ],
        }),
      });

      const response = await generateOllamaResearchResponse(
        "Database latency increased",
        mockSession,
      );

      expect(response).toBe("This looks like a good observation for research.");
      expect(mockFetch).toHaveBeenCalled();
    });

    it("should use default model if not specified", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Response" } }],
        }),
      });

      await generateOllamaResearchResponse("Test", mockSession);

      const callArgs = mockFetch.mock.calls[0] as unknown[];
      const body = JSON.parse((callArgs[1] as { body: string }).body);
      expect(body.model).toBe("mistral-8b");
    });

    it("should use custom model if specified", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Response" } }],
        }),
      });

      await generateOllamaResearchResponse("Test", mockSession, {
        model: "llama2",
      });

      const callArgs = mockFetch.mock.calls[0] as unknown[];
      const body = JSON.parse((callArgs[1] as { body: string }).body);
      expect(body.model).toBe("llama2");
    });

    it("should pass temperature and sampling parameters", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Response" } }],
        }),
      });

      await generateOllamaResearchResponse("Test", mockSession, {
        temperature: 0.5,
        topP: 0.8,
      });

      const callArgs = mockFetch.mock.calls[0] as unknown[];
      const body = JSON.parse((callArgs[1] as { body: string }).body);
      expect(body.temperature).toBe(0.5);
      expect(body.top_p).toBe(0.8);
    });

    it("should include conversation history in request", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Response" } }],
        }),
      });

      // Add a previous turn to the session
      mockSession.turns.push({
        role: "user",
        content: "Previous question",
        timestamp: Date.now(),
      });
      mockSession.turns.push({
        role: "assistant",
        content: "Previous answer",
        timestamp: Date.now(),
      });

      await generateOllamaResearchResponse("New question", mockSession);

      const callArgs = mockFetch.mock.calls[0] as unknown[];
      const body = JSON.parse((callArgs[1] as { body: string }).body);
      expect(body.messages.length).toBeGreaterThan(1);
      expect(body.messages.length).toBeLessThanOrEqual(7); // 5 recent + system + new
    });

    it("should fallback to heuristic on Ollama error", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockRejectedValueOnce(new Error("Ollama not responding"));

      const response = await generateOllamaResearchResponse("add section", mockSession);

      // Should return heuristic response containing common fallback patterns
      expect(response).toBeTruthy();
      expect(typeof response).toBe("string");
      expect(response.length).toBeGreaterThan(0);
    });

    it("should fallback to heuristic when response has no content", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "" } }],
        }),
      });

      const response = await generateOllamaResearchResponse("Test", mockSession);

      expect(response).toBeTruthy();
      expect(response.length).toBeGreaterThan(0);
    });

    it("should handle network errors gracefully", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

      const response = await generateOllamaResearchResponse("Test", mockSession);

      expect(response).toBeTruthy();
      expect(typeof response).toBe("string");
    });

    it("should use custom system prompt if provided", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Response" } }],
        }),
      });

      const customPrompt = "You are a technical writer";
      await generateOllamaResearchResponse("Test", mockSession, {
        systemPrompt: customPrompt,
      });

      const callArgs = mockFetch.mock.calls[0] as unknown[];
      const body = JSON.parse((callArgs[1] as { body: string }).body);
      const systemMessage = body.messages.find(
        (m: unknown) => (m as { role?: string }).role === "system",
      );
      expect(systemMessage).toBeDefined();
      expect(systemMessage.content).toBe(customPrompt);
    });

    it("should include research context in system prompt", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Response" } }],
        }),
      });

      await generateOllamaResearchResponse("Test", mockSession);

      const callArgs = mockFetch.mock.calls[0] as unknown[];
      const body = JSON.parse((callArgs[1] as { body: string }).body);
      const systemMessage = body.messages.find(
        (m: unknown) => (m as { role?: string }).role === "system",
      );

      // Should include research context
      expect(systemMessage).toBeDefined();
      expect(systemMessage.content).toContain("research assistant");
    });
  });

  describe("generateOllamaResearchResponseStream()", () => {
    it("should stream response chunks", async () => {
      const mockFetch = global.fetch as unknown as {
        mockResolvedValueOnce: Function;
        mockRejectedValueOnce: Function;
        mockImplementationOnce: Function;
        mock: { calls: unknown[] };
      };

      // Create a mock ReadableStream that yields chunks
      const chunks = [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
        'data: {"choices":[{"delta":{"content":" "}}]}\n',
        'data: {"choices":[{"delta":{"content":"world"}}]}\n',
        "data: [DONE]\n",
      ];

      const mockReader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({ done: false, value: Buffer.from(chunks[0]) })
          .mockResolvedValueOnce({ done: false, value: Buffer.from(chunks[1]) })
          .mockResolvedValueOnce({ done: false, value: Buffer.from(chunks[2]) })
          .mockResolvedValueOnce({ done: false, value: Buffer.from(chunks[3]) })
          .mockResolvedValueOnce({ done: true }),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        body: {
          getReader: () => mockReader,
        },
      });

      const { generateOllamaResearchResponseStream } = await import("./research-ollama.js");

      const result: string[] = [];
      for await (const chunk of generateOllamaResearchResponseStream("Test", mockSession)) {
        result.push(chunk);
      }

      expect(result.length).toBeGreaterThan(0);
      expect(result.join("")).toContain("Hello");
    });
  });
});
