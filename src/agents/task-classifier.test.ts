import { describe, expect, it } from "vitest";
import { classify, loadToModelTier } from "./task-classifier.js";

describe("task-classifier", () => {
  describe("classify", () => {
    it("heartbeat → cheap/routine", () => {
      const result = classify({ promptText: "", isHeartbeat: true });
      expect(result.load).toBe("cheap");
      expect(result.pattern).toBe("routine");
      expect(result.altitude).toBe("tactical");
      expect(result.confidence).toBe(0.95);
      expect(result.context.isHeartbeat).toBe(true);
      expect(result.context.isUserMessage).toBe(false);
    });

    it("routine cron → cheap/routine", () => {
      const result = classify({ promptText: "run evening tasks", cronName: "evening-maintenance" });
      expect(result.load).toBe("cheap");
      expect(result.pattern).toBe("routine");
      expect(result.context.isCron).toBe(true);
      expect(result.context.cronName).toBe("evening-maintenance");
    });

    it("small prompt without code → cheap/triage", () => {
      const result = classify({ promptText: "hello", promptTokens: 50 });
      expect(result.load).toBe("cheap");
      expect(result.pattern).toBe("triage");
      expect(result.altitude).toBe("tactical");
      expect(result.confidence).toBe(0.6);
    });

    it("strategic keywords → expensive/strategic", () => {
      const result = classify({
        promptText: "architect a new authentication system",
        promptTokens: 500,
      });
      expect(result.load).toBe("expensive");
      expect(result.pattern).toBe("strategic");
      expect(result.altitude).toBe("strategic");
      expect(result.confidence).toBe(0.85);
    });

    it("debug keywords → expensive/debug", () => {
      const result = classify({ promptText: "debug the failing test suite", promptTokens: 400 });
      expect(result.load).toBe("expensive");
      expect(result.pattern).toBe("debug");
      expect(result.altitude).toBe("tactical");
    });

    it("failedAttempts >= 2 → expensive/debug", () => {
      const result = classify({
        promptText: "try again with the deployment",
        promptTokens: 300,
        failedAttempts: 3,
      });
      expect(result.load).toBe("expensive");
      expect(result.pattern).toBe("debug");
    });

    it("many files read → expensive/build", () => {
      const result = classify({
        promptText: "update all the handlers",
        promptTokens: 400,
        filesRead: 8,
      });
      expect(result.load).toBe("expensive");
      expect(result.pattern).toBe("build");
      expect(result.altitude).toBe("tactical");
    });

    it("subagent result → mid/review", () => {
      const result = classify({
        promptText: "here are the results from scanning",
        promptTokens: 600,
        isSubagentResult: true,
      });
      expect(result.load).toBe("mid");
      expect(result.pattern).toBe("review");
      expect(result.altitude).toBe("tactical");
      expect(result.context.isSubagentResult).toBe(true);
      expect(result.context.isUserMessage).toBe(false);
    });

    it("build keywords → mid/build", () => {
      const result = classify({
        promptText: "implement the new notification feature",
        promptTokens: 350,
      });
      expect(result.load).toBe("mid");
      expect(result.pattern).toBe("build");
    });

    it("error context flag set when text contains error", () => {
      const result = classify({
        promptText: "there was an error in the pipeline",
        promptTokens: 300,
      });
      expect(result.context.hasError).toBe(true);
    });
  });

  describe("loadToModelTier", () => {
    it("maps cheap → haiku", () => {
      expect(loadToModelTier("cheap")).toBe("haiku");
    });

    it("maps mid → sonnet", () => {
      expect(loadToModelTier("mid")).toBe("sonnet");
    });

    it("maps expensive → opus", () => {
      expect(loadToModelTier("expensive")).toBe("opus");
    });
  });
});
