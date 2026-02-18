import { describe, expect, it } from "vitest";
import {
  DEFAULT_HIGH_RISK_TYPES,
  DEFAULT_REVIEWER_PROMPT,
  ReviewGate,
  ReviewGateError,
} from "../review-gate.js";
import { TaskType } from "../types.js";

const baseConfig = {
  enabled: true,
  mode: "auto" as const,
  high_risk_types: [TaskType.CODE_REFACTOR, TaskType.SECURITY_AUDIT, TaskType.GIT_OPS],
  reviewer_model: "anthropic/claude-opus-4-6",
  reviewer_system_prompt: DEFAULT_REVIEWER_PROMPT,
  timeout_ms: 60000,
};

describe("ReviewGate", () => {
  describe("shouldReview", () => {
    it("returns true when enabled=true and task is high-risk", () => {
      const gate = new ReviewGate(baseConfig);
      expect(gate.shouldReview(TaskType.CODE_REFACTOR)).toBe(true);
      expect(gate.shouldReview(TaskType.SECURITY_AUDIT)).toBe(true);
      expect(gate.shouldReview(TaskType.GIT_OPS)).toBe(true);
    });

    it("returns false when enabled=false", () => {
      const gate = new ReviewGate({ ...baseConfig, enabled: false });
      expect(gate.shouldReview(TaskType.CODE_REFACTOR)).toBe(false);
      expect(gate.shouldReview(TaskType.SECURITY_AUDIT)).toBe(false);
    });

    it("returns false when enabled=true but task is not high-risk", () => {
      const gate = new ReviewGate(baseConfig);
      expect(gate.shouldReview(TaskType.CODE_EDIT)).toBe(false);
      expect(gate.shouldReview(TaskType.DOC_WRITE)).toBe(false);
      expect(gate.shouldReview(TaskType.HEARTBEAT_CHECK)).toBe(false);
    });
  });

  describe("isAutoMode", () => {
    it("returns true for auto mode", () => {
      const gate = new ReviewGate({ ...baseConfig, mode: "auto" });
      expect(gate.isAutoMode()).toBe(true);
    });

    it("returns false for manual mode", () => {
      const gate = new ReviewGate({ ...baseConfig, mode: "manual" });
      expect(gate.isAutoMode()).toBe(false);
    });
  });

  describe("buildReviewPrompt", () => {
    it("includes taskType, originalTask, and output in prompt", () => {
      const gate = new ReviewGate(baseConfig);
      const prompt = gate.buildReviewPrompt(
        TaskType.CODE_REFACTOR,
        "Refactor the auth module",
        "Here is the refactored code...",
      );
      expect(prompt).toContain(TaskType.CODE_REFACTOR);
      expect(prompt).toContain("Refactor the auth module");
      expect(prompt).toContain("Here is the refactored code...");
    });

    it("includes required review sections in prompt", () => {
      const gate = new ReviewGate(baseConfig);
      const prompt = gate.buildReviewPrompt(TaskType.GIT_OPS, "task", "output");
      expect(prompt).toContain("## Review Request");
      expect(prompt).toContain("## Instructions");
      expect(prompt).toContain("Security vulnerabilities");
      expect(prompt).toContain("Breaking changes");
      expect(prompt).toContain("JSON format");
    });
  });

  describe("parseReviewResponse", () => {
    it("parses a valid PASS JSON response", () => {
      const gate = new ReviewGate(baseConfig);
      const response = JSON.stringify({
        status: "PASS",
        reason: "No issues found",
        suggestions: [],
      });
      const result = gate.parseReviewResponse(response);
      expect(result.status).toBe("PASS");
      expect(result.reason).toBe("No issues found");
      expect(result.suggestions).toEqual([]);
    });

    it("parses a valid FAIL JSON response with suggestions", () => {
      const gate = new ReviewGate(baseConfig);
      const response = JSON.stringify({
        status: "FAIL",
        reason: "SQL injection vulnerability detected",
        suggestions: ["Sanitize user inputs", "Use parameterized queries"],
      });
      const result = gate.parseReviewResponse(response);
      expect(result.status).toBe("FAIL");
      expect(result.reason).toBe("SQL injection vulnerability detected");
      expect(result.suggestions).toEqual(["Sanitize user inputs", "Use parameterized queries"]);
    });

    it("extracts JSON embedded in surrounding text", () => {
      const gate = new ReviewGate(baseConfig);
      const response = `Here is my review: {"status": "PASS", "reason": "Looks good", "suggestions": ["Minor style fix"]} End of review.`;
      const result = gate.parseReviewResponse(response);
      expect(result.status).toBe("PASS");
      expect(result.reason).toBe("Looks good");
      expect(result.suggestions).toEqual(["Minor style fix"]);
    });

    it("returns FAIL with parse error message for invalid response", () => {
      const gate = new ReviewGate(baseConfig);
      const result = gate.parseReviewResponse("This is not JSON at all");
      expect(result.status).toBe("FAIL");
      expect(result.reason).toBe("Could not parse reviewer response");
      expect(result.suggestions).toEqual([]);
    });

    it("returns FAIL with parse error for empty response", () => {
      const gate = new ReviewGate(baseConfig);
      const result = gate.parseReviewResponse("");
      expect(result.status).toBe("FAIL");
      expect(result.reason).toBe("Could not parse reviewer response");
      expect(result.suggestions).toEqual([]);
    });

    it("treats unknown status values as FAIL", () => {
      const gate = new ReviewGate(baseConfig);
      const response = JSON.stringify({
        status: "UNKNOWN",
        reason: "Something happened",
        suggestions: [],
      });
      const result = gate.parseReviewResponse(response);
      expect(result.status).toBe("FAIL");
    });

    it("handles missing reason field gracefully", () => {
      const gate = new ReviewGate(baseConfig);
      const response = JSON.stringify({ status: "PASS", suggestions: [] });
      const result = gate.parseReviewResponse(response);
      expect(result.status).toBe("PASS");
      expect(result.reason).toBe("No reason provided");
    });

    it("handles missing suggestions field gracefully", () => {
      const gate = new ReviewGate(baseConfig);
      const response = JSON.stringify({ status: "PASS", reason: "All good" });
      const result = gate.parseReviewResponse(response);
      expect(result.suggestions).toEqual([]);
    });
  });

  describe("getters", () => {
    it("returns reviewer model from config", () => {
      const gate = new ReviewGate(baseConfig);
      expect(gate.getReviewerModel()).toBe("anthropic/claude-opus-4-6");
    });

    it("returns reviewer system prompt from config", () => {
      const gate = new ReviewGate(baseConfig);
      expect(gate.getReviewerSystemPrompt()).toBe(DEFAULT_REVIEWER_PROMPT);
    });

    it("returns timeout from config", () => {
      const gate = new ReviewGate(baseConfig);
      expect(gate.getTimeoutMs()).toBe(60000);
    });
  });
});

describe("ReviewGateError", () => {
  it("has correct error name", () => {
    const result = { status: "FAIL" as const, reason: "Too risky", suggestions: [] };
    const err = new ReviewGateError(result);
    expect(err.name).toBe("ReviewGateError");
  });

  it("formats the error message correctly", () => {
    const result = { status: "FAIL" as const, reason: "Too risky", suggestions: [] };
    const err = new ReviewGateError(result);
    expect(err.message).toBe("Review gate: FAIL - Too risky");
  });

  it("attaches the ReviewResult to the error", () => {
    const result = {
      status: "FAIL" as const,
      reason: "Security vulnerability",
      suggestions: ["Fix it"],
    };
    const err = new ReviewGateError(result);
    expect(err.result).toEqual(result);
  });

  it("is an instance of Error", () => {
    const err = new ReviewGateError({ status: "PASS", reason: "ok", suggestions: [] });
    expect(err).toBeInstanceOf(Error);
  });
});

describe("DEFAULT_HIGH_RISK_TYPES", () => {
  it("contains CODE_REFACTOR, SECURITY_AUDIT, and GIT_OPS", () => {
    expect(DEFAULT_HIGH_RISK_TYPES).toContain(TaskType.CODE_REFACTOR);
    expect(DEFAULT_HIGH_RISK_TYPES).toContain(TaskType.SECURITY_AUDIT);
    expect(DEFAULT_HIGH_RISK_TYPES).toContain(TaskType.GIT_OPS);
  });

  it("contains exactly 3 entries", () => {
    expect(DEFAULT_HIGH_RISK_TYPES).toHaveLength(3);
  });
});
