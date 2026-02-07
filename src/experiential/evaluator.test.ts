import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExperientialEvaluator } from "./evaluator.js";

describe("ExperientialEvaluator", () => {
  describe("heuristic evaluation", () => {
    it("returns skipped for observation-only tools", async () => {
      const evaluator = new ExperientialEvaluator();
      const result = await evaluator.evaluate({
        content: "reading a file",
        source: "tool_use",
        toolName: "read_file",
      });

      expect(result.disposition).toBe("skipped");
      expect(result.significance.total).toBe(0);
      expect(result.usedLlm).toBe(false);
    });

    it("scores file write tools with moderate significance", () => {
      const evaluator = new ExperientialEvaluator();
      const result = evaluator.heuristicEvaluation({
        content: "writing important config",
        source: "tool_use",
        toolName: "write_file",
      });

      expect(result.significance.total).toBeGreaterThan(0.4);
      expect(result.significance.consequential).toBeGreaterThan(0);
      expect(result.usedLlm).toBe(false);
    });

    it("scores message tools with relationship weight", () => {
      const evaluator = new ExperientialEvaluator();
      const result = evaluator.heuristicEvaluation({
        content: "sending a reply",
        source: "tool_use",
        toolName: "send_message",
      });

      expect(result.significance.relationship).toBeGreaterThan(0);
      expect(result.usedLlm).toBe(false);
    });

    it("boosts compaction source events", () => {
      const evaluator = new ExperientialEvaluator();
      const result = evaluator.heuristicEvaluation({
        content: "compaction summary",
        source: "compaction",
      });

      expect(result.significance.total).toBeGreaterThan(0.5);
      expect(result.significance.uncertainty).toBeGreaterThan(0);
    });

    it("boosts session boundary events", () => {
      const evaluator = new ExperientialEvaluator();
      const result = evaluator.heuristicEvaluation({
        content: "session ending",
        source: "session_boundary",
      });

      expect(result.significance.total).toBeGreaterThan(0.4);
    });

    it("adds length boost for longer content", () => {
      const evaluator = new ExperientialEvaluator();

      const short = evaluator.heuristicEvaluation({
        content: "short",
        source: "message",
      });

      const long = evaluator.heuristicEvaluation({
        content: "a".repeat(1000),
        source: "message",
      });

      expect(long.significance.total).toBeGreaterThan(short.significance.total);
    });

    it("returns correct dispositions based on score thresholds", () => {
      const evaluator = new ExperientialEvaluator();

      // Unknown tool, short content, message source -> low score
      const low = evaluator.heuristicEvaluation({
        content: "hi",
        source: "message",
      });
      expect(["skipped", "archived"]).toContain(low.disposition);

      // Experience tool, compaction source, long content -> high score
      const high = evaluator.heuristicEvaluation({
        content: "a".repeat(2000),
        source: "compaction",
        toolName: "remember",
      });
      expect(["immediate", "buffered"]).toContain(high.disposition);
    });
  });

  describe("LLM evaluation", () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      fetchSpy = vi.spyOn(globalThis, "fetch");
    });

    afterEach(() => {
      fetchSpy.mockRestore();
    });

    it("parses valid LLM JSON response", async () => {
      const evaluator = new ExperientialEvaluator({
        minIntervalMs: 0,
        maxEvalsPerHour: 100,
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    emotional: 0.8,
                    uncertainty: 0.3,
                    relationship: 0.5,
                    consequential: 0.9,
                    reconstitution: 0.7,
                    reasons: ["high emotional impact", "significant consequences"],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const result = await evaluator.evaluate({
        content: "Important decision made",
        source: "message",
      });

      expect(result.usedLlm).toBe(true);
      expect(result.significance.emotional).toBe(0.8);
      expect(result.significance.consequential).toBe(0.9);
      expect(result.reasons).toContain("high emotional impact");
    });

    it("falls back to heuristic on fetch failure", async () => {
      const evaluator = new ExperientialEvaluator({
        minIntervalMs: 0,
        maxEvalsPerHour: 100,
      });

      fetchSpy.mockRejectedValueOnce(new Error("Connection refused"));

      const result = await evaluator.evaluate({
        content: "test content",
        source: "message",
      });

      expect(result.usedLlm).toBe(false);
      expect(result.reasons).toContain("heuristic evaluation");
    });

    it("falls back to heuristic on non-200 response", async () => {
      const evaluator = new ExperientialEvaluator({
        minIntervalMs: 0,
        maxEvalsPerHour: 100,
      });

      fetchSpy.mockResolvedValueOnce(new Response("error", { status: 500 }));

      const result = await evaluator.evaluate({
        content: "test content",
        source: "message",
      });

      expect(result.usedLlm).toBe(false);
    });

    it("respects rate limiting", async () => {
      const evaluator = new ExperientialEvaluator({
        minIntervalMs: 60000, // 1 minute
        maxEvalsPerHour: 2,
      });

      // First call succeeds via LLM
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"emotional":0.5,"uncertainty":0.5,"relationship":0.5,"consequential":0.5,"reconstitution":0.5,"reasons":["test"]}',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const first = await evaluator.evaluate({
        content: "first eval",
        source: "message",
      });
      expect(first.usedLlm).toBe(true);

      // Second call should be rate-limited (min interval)
      const second = await evaluator.evaluate({
        content: "second eval",
        source: "message",
      });
      expect(second.usedLlm).toBe(false);
    });

    it("clamps values to 0-1 range", async () => {
      const evaluator = new ExperientialEvaluator({
        minIntervalMs: 0,
        maxEvalsPerHour: 100,
      });

      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"emotional":1.5,"uncertainty":-0.3,"relationship":0.5,"consequential":2.0,"reconstitution":0.7,"reasons":[]}',
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );

      const result = await evaluator.evaluate({
        content: "test",
        source: "message",
      });

      expect(result.significance.emotional).toBe(1);
      expect(result.significance.uncertainty).toBe(0);
      expect(result.significance.consequential).toBe(1);
    });
  });
});
