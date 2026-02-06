import { describe, expect, it, vi } from "vitest";
import { LlmContextExtractor } from "./context-extractor.js";

describe("LlmContextExtractor", () => {
  it("extracts structured context via gateway LLM call", async () => {
    const extractionResult = {
      summary: "Implemented the auth module with JWT",
      outputs: { filesModified: 3 },
      keyFindings: ["JWT is the best choice for stateless auth"],
      artifacts: [{ type: "file", path: "src/auth.ts", description: "Main auth module" }],
    };

    const callGateway = vi.fn().mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "agent") return { runId: "extract-run" };
      if (opts.method === "agent.wait") return { status: "ok" };
      if (opts.method === "chat.history") {
        return {
          messages: [
            {
              role: "assistant",
              content: "```json\n" + JSON.stringify(extractionResult) + "\n```",
            },
          ],
        };
      }
      if (opts.method === "sessions.delete") return {};
      return {};
    });

    const readFullTranscript = vi.fn().mockResolvedValue([
      { role: "user", content: "implement auth" },
      { role: "assistant", content: "I implemented JWT auth in src/auth.ts" },
    ]);

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const extractor = new LlmContextExtractor({ callGateway, readFullTranscript, log });

    const context = await extractor.extract({
      sessionKey: "test-session",
      item: {
        id: "item-1",
        queueId: "q",
        title: "Auth task",
        status: "in_progress",
        priority: "medium",
        createdAt: "",
        updatedAt: "",
      },
      runResult: { status: "ok" },
    });

    expect(context.summary).toBe("Implemented the auth module with JWT");
    expect(context.outputs).toEqual({ filesModified: 3 });
    expect(context.keyFindings).toEqual(["JWT is the best choice for stateless auth"]);
    expect(context.artifacts).toHaveLength(1);
    expect(context.extractedAt).toBeDefined();
  });

  it("falls back to transcript summary on LLM failure", async () => {
    const callGateway = vi.fn().mockImplementation(async (opts: { method: string }) => {
      if (opts.method === "agent") throw new Error("gateway unavailable");
      return {};
    });

    const readFullTranscript = vi
      .fn()
      .mockResolvedValue([{ role: "assistant", content: "I finished the task successfully." }]);

    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const extractor = new LlmContextExtractor({ callGateway, readFullTranscript, log });

    const context = await extractor.extract({
      sessionKey: "test-session",
      item: {
        id: "item-1",
        queueId: "q",
        title: "Test",
        status: "in_progress",
        priority: "medium",
        createdAt: "",
        updatedAt: "",
      },
      runResult: { status: "ok" },
    });

    // Should still have a summary from the transcript fallback.
    expect(context.summary).toBeDefined();
    expect(context.extractedAt).toBeDefined();
  });

  it("returns error context for failed runs without LLM call", async () => {
    const callGateway = vi.fn();
    const readFullTranscript = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const extractor = new LlmContextExtractor({ callGateway, readFullTranscript, log });

    const context = await extractor.extract({
      sessionKey: "test-session",
      item: {
        id: "item-1",
        queueId: "q",
        title: "Test",
        status: "in_progress",
        priority: "medium",
        createdAt: "",
        updatedAt: "",
      },
      runResult: { status: "error", error: "crashed" },
    });

    expect(context.summary).toContain("Failed: crashed");
    // Should NOT have called the gateway for extraction on error runs.
    expect(callGateway).not.toHaveBeenCalled();
  });
});
