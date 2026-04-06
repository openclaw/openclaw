import { describe, it, expect } from "vitest";
import { classifyIntent, evaluateMatcher, DEFAULT_INTENT_RULES } from "./intent-classifier.js";
import type { IntentRule, IntentMatcher } from "./intent-classifier.js";

// ---------------------------------------------------------------------------
// evaluateMatcher — unit tests for individual matcher types
// ---------------------------------------------------------------------------

describe("evaluateMatcher", () => {
  describe("regex matcher", () => {
    it("matches a simple pattern", () => {
      const m: IntentMatcher = { type: "regex", pattern: "\\bhello\\b", flags: "i" };
      expect(evaluateMatcher(m, "Hello world")).toBe(true);
    });

    it("rejects when pattern does not match", () => {
      const m: IntentMatcher = { type: "regex", pattern: "\\bxyz\\b", flags: "i" };
      expect(evaluateMatcher(m, "Hello world")).toBe(false);
    });

    it("returns false for missing pattern", () => {
      const m: IntentMatcher = { type: "regex" };
      expect(evaluateMatcher(m, "anything")).toBe(false);
    });

    it("returns false for invalid regex (does not throw)", () => {
      const m: IntentMatcher = { type: "regex", pattern: "[invalid" };
      expect(evaluateMatcher(m, "test")).toBe(false);
    });

    it("respects flags (multiline)", () => {
      const m: IntentMatcher = { type: "regex", pattern: "^\\d+\\.", flags: "m" };
      expect(evaluateMatcher(m, "intro\n1. item")).toBe(true);
      expect(evaluateMatcher(m, "no numbers here")).toBe(false);
    });
  });

  describe("keyword matcher", () => {
    it("matches case-insensitively", () => {
      const m: IntentMatcher = { type: "keyword", keywords: ["hello"] };
      expect(evaluateMatcher(m, "HELLO WORLD")).toBe(true);
    });

    it("matches any keyword (OR logic)", () => {
      const m: IntentMatcher = { type: "keyword", keywords: ["foo", "bar", "baz"] };
      expect(evaluateMatcher(m, "contains bar inside")).toBe(true);
    });

    it("rejects when no keywords match", () => {
      const m: IntentMatcher = { type: "keyword", keywords: ["xyz"] };
      expect(evaluateMatcher(m, "nothing here")).toBe(false);
    });

    it("returns false for empty keywords array", () => {
      const m: IntentMatcher = { type: "keyword", keywords: [] };
      expect(evaluateMatcher(m, "anything")).toBe(false);
    });

    it("returns false for missing keywords", () => {
      const m: IntentMatcher = { type: "keyword" };
      expect(evaluateMatcher(m, "anything")).toBe(false);
    });
  });

  describe("length matcher", () => {
    it("passes when length is within range", () => {
      const m: IntentMatcher = { type: "length", minLength: 5, maxLength: 10 };
      expect(evaluateMatcher(m, "1234567")).toBe(true);
    });

    it("fails when message is too short", () => {
      const m: IntentMatcher = { type: "length", minLength: 10 };
      expect(evaluateMatcher(m, "short")).toBe(false);
    });

    it("fails when message is too long", () => {
      const m: IntentMatcher = { type: "length", maxLength: 5 };
      expect(evaluateMatcher(m, "this is too long")).toBe(false);
    });

    it("maxLength boundary: exactly at limit passes", () => {
      const m: IntentMatcher = { type: "length", maxLength: 5 };
      expect(evaluateMatcher(m, "12345")).toBe(true);
    });

    it("maxLength boundary: one over limit fails", () => {
      const m: IntentMatcher = { type: "length", maxLength: 5 };
      expect(evaluateMatcher(m, "123456")).toBe(false);
    });

    it("passes with no constraints", () => {
      const m: IntentMatcher = { type: "length" };
      expect(evaluateMatcher(m, "anything at all")).toBe(true);
    });
  });

  describe("negation matcher", () => {
    it("inverts a passing matcher", () => {
      const m: IntentMatcher = {
        type: "negation",
        inner: { type: "keyword", keywords: ["hello"] },
      };
      expect(evaluateMatcher(m, "hello world")).toBe(false);
    });

    it("inverts a failing matcher", () => {
      const m: IntentMatcher = {
        type: "negation",
        inner: { type: "keyword", keywords: ["xyz"] },
      };
      expect(evaluateMatcher(m, "hello world")).toBe(true);
    });

    it("returns true when inner is missing", () => {
      const m: IntentMatcher = { type: "negation" };
      expect(evaluateMatcher(m, "anything")).toBe(true);
    });
  });

  describe("unknown matcher type", () => {
    it("returns false for unknown type", () => {
      const m = { type: "unknown" } as unknown as IntentMatcher;
      expect(evaluateMatcher(m, "test")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// classifyIntent — default rules: simple messages
// ---------------------------------------------------------------------------

describe("classifyIntent (default rules)", () => {
  describe("classifies simple messages correctly", () => {
    const simpleCases = [
      "Say hello",
      "What is 2 + 2?",
      "Explain monads in one paragraph",
      "Translate this to French: Good morning",
      "List 3 blockchain security vulnerabilities",
      "Write a haiku about TypeScript",
      "Summarize this article",
      "Fix the typo in the README",
      "What does this error mean?",
    ];

    for (const msg of simpleCases) {
      it(`"${msg}" → simple`, () => {
        const result = classifyIntent(msg);
        expect(result.category).toBe("simple");
      });
    }
  });

  describe("classifies simple Chinese messages correctly", () => {
    const simpleCases = [
      "你好",
      "今天天气怎么样",
      "解释一下什么是 TypeScript",
      "翻译成英文：早上好",
    ];

    for (const msg of simpleCases) {
      it(`"${msg}" → simple`, () => {
        const result = classifyIntent(msg);
        expect(result.category).toBe("simple");
      });
    }
  });

  // -----------------------------------------------------------------------
  // Complex messages
  // -----------------------------------------------------------------------

  describe("classifies complex messages correctly", () => {
    it('"first...then" sequencing', () => {
      const result = classifyIntent("First design the API schema, then implement the endpoints");
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:first-then");
    });

    it("numbered list", () => {
      const result = classifyIntent("1. Design the schema\n2. Implement the API\n3. Write tests");
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:numbered-list");
    });

    it("step N pattern", () => {
      const result = classifyIntent("Step 1: set up the project. Step 2: write the code.");
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:step-n");
    });

    it("phase N pattern", () => {
      const result = classifyIntent("Phase 1 is planning, phase 2 is execution");
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:phase-n");
    });

    it("stage N pattern", () => {
      const result = classifyIntent("Stage 1 research, stage 2 implementation");
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:stage-n");
    });

    it("collaboration language", () => {
      const result = classifyIntent("Collaborate on building a REST API with tests");
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:collaborate");
    });

    it("coordination language", () => {
      const result = classifyIntent("Coordinate the team to build and deploy the service");
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:coordinate");
    });

    it("review each other", () => {
      const result = classifyIntent("Write code and review each other's pull requests");
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:review-each-other");
    });

    it("work together", () => {
      const result = classifyIntent("Work together to build the frontend and backend");
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:work-together");
    });

    it("parallel execution", () => {
      const result = classifyIntent("Run the linter and tests in parallel");
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:in-parallel");
    });

    it("concurrently", () => {
      const result = classifyIntent("Execute both tasks concurrently");
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:concurrently");
    });

    it("at the same time", () => {
      const result = classifyIntent("Build and test at the same time");
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:same-time");
    });

    it("multiple deliverables", () => {
      const result = classifyIntent(
        "Build the REST API endpoints and then write comprehensive integration tests for each one",
      );
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:multi-deliverable");
    });

    it("Chinese multi-step keywords", () => {
      const result = classifyIntent("首先设计数据库，然后实现 API");
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:zh-sequence");
    });

    it("very long message (>500 chars)", () => {
      const longMsg = "Please analyze " + "a".repeat(500);
      const result = classifyIntent(longMsg);
      expect(result.category).toBe("complex");
      expect(result.matchedRule).toBe("complex:long-message");
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases — common words that should NOT trigger complexity
  // -----------------------------------------------------------------------

  describe("does not false-positive on common words", () => {
    it('"and" alone is not complex', () => {
      const result = classifyIntent("Pros and cons of TypeScript");
      expect(result.category).toBe("simple");
    });

    it('"then" alone is not complex', () => {
      const result = classifyIntent("What happened then?");
      expect(result.category).toBe("simple");
    });

    it('"summarize" is not complex', () => {
      const result = classifyIntent("Summarize the article about AI safety");
      expect(result.category).toBe("simple");
    });

    it('"analyze" is not complex', () => {
      const result = classifyIntent("Analyze this error log");
      expect(result.category).toBe("simple");
    });

    it('"aggregate" is not complex', () => {
      const result = classifyIntent("Aggregate the results");
      expect(result.category).toBe("simple");
    });

    it('"coordinate" as a noun is complex (matches substring)', () => {
      // This is an acceptable trade-off: the word "coordinate" strongly
      // implies coordination, even in noun form.
      const result = classifyIntent("Use coordinate geometry to solve the problem");
      expect(result.category).toBe("complex");
    });
  });

  // -----------------------------------------------------------------------
  // Length boundary tests
  // -----------------------------------------------------------------------

  describe("length boundaries", () => {
    it("empty string → simple", () => {
      expect(classifyIntent("").category).toBe("simple");
    });

    it("exactly 200 chars → simple", () => {
      expect(classifyIntent("x".repeat(200)).category).toBe("simple");
    });

    it("201 chars → default (too long for simple, too short for complex:long)", () => {
      expect(classifyIntent("x".repeat(201)).category).toBe("default");
    });

    it("500 chars → complex (long message)", () => {
      expect(classifyIntent("x".repeat(500)).category).toBe("complex");
    });

    it("201-499 chars without patterns → default", () => {
      expect(classifyIntent("x".repeat(300)).category).toBe("default");
    });
  });

  // -----------------------------------------------------------------------
  // Confidence levels
  // -----------------------------------------------------------------------

  describe("confidence levels", () => {
    it("regex match → high confidence", () => {
      const result = classifyIntent("First do A, then do B");
      expect(result.confidence).toBe("high");
    });

    it("keyword match → medium confidence", () => {
      const result = classifyIntent("首先做这个");
      expect(result.confidence).toBe("medium");
    });

    it("length-only match → low confidence", () => {
      const result = classifyIntent("short");
      expect(result.confidence).toBe("low");
    });

    it("default fallthrough → low confidence", () => {
      const result = classifyIntent("x".repeat(300));
      expect(result.confidence).toBe("low");
    });
  });
});

// ---------------------------------------------------------------------------
// classifyIntent — custom rules
// ---------------------------------------------------------------------------

describe("classifyIntent (custom rules)", () => {
  it("respects custom rules over defaults", () => {
    const rules: IntentRule[] = [
      {
        id: "custom:greeting",
        category: "greeting",
        priority: 1,
        matchers: [{ type: "keyword", keywords: ["hello", "hi", "hey"] }],
      },
    ];

    const result = classifyIntent("Hello there!", rules);
    expect(result.category).toBe("greeting");
    expect(result.matchedRule).toBe("custom:greeting");
  });

  it("evaluates rules in priority order", () => {
    const rules: IntentRule[] = [
      {
        id: "low-priority",
        category: "catch-all",
        priority: 100,
        matchers: [{ type: "length", maxLength: 999 }],
      },
      {
        id: "high-priority",
        category: "specific",
        priority: 1,
        matchers: [{ type: "keyword", keywords: ["test"] }],
      },
    ];

    const result = classifyIntent("run the test", rules);
    expect(result.category).toBe("specific");
    expect(result.matchedRule).toBe("high-priority");
  });

  it("returns default when no custom rules match", () => {
    const rules: IntentRule[] = [
      {
        id: "nope",
        category: "nope",
        priority: 1,
        matchers: [{ type: "keyword", keywords: ["xyzzy"] }],
      },
    ];

    const result = classifyIntent("nothing matches", rules);
    expect(result.category).toBe("default");
    expect(result.matchedRule).toBeNull();
  });

  it("AND logic: all matchers must pass", () => {
    const rules: IntentRule[] = [
      {
        id: "strict",
        category: "strict",
        priority: 1,
        matchers: [
          { type: "keyword", keywords: ["deploy"] },
          { type: "length", minLength: 20 },
        ],
      },
    ];

    // Has keyword but too short
    expect(classifyIntent("deploy it", rules).category).toBe("default");

    // Long enough and has keyword
    expect(classifyIntent("please deploy the application now", rules).category).toBe("strict");
  });

  it("empty matchers array is skipped", () => {
    const rules: IntentRule[] = [
      { id: "empty", category: "empty", priority: 1, matchers: [] },
      { id: "fallback", category: "fallback", priority: 2, matchers: [{ type: "length" }] },
    ];

    const result = classifyIntent("anything", rules);
    expect(result.category).toBe("fallback");
  });

  it("handles equal priorities (stable sort — first defined wins)", () => {
    const rules: IntentRule[] = [
      {
        id: "first",
        category: "first",
        priority: 10,
        matchers: [{ type: "length", maxLength: 999 }],
      },
      {
        id: "second",
        category: "second",
        priority: 10,
        matchers: [{ type: "length", maxLength: 999 }],
      },
    ];

    const result = classifyIntent("test", rules);
    expect(result.category).toBe("first");
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_INTENT_RULES structure validation
// ---------------------------------------------------------------------------

describe("DEFAULT_INTENT_RULES", () => {
  it("has at least 15 rules", () => {
    expect(DEFAULT_INTENT_RULES.length).toBeGreaterThanOrEqual(15);
  });

  it("all rules have unique IDs", () => {
    const ids = DEFAULT_INTENT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all rules have non-empty matchers", () => {
    for (const rule of DEFAULT_INTENT_RULES) {
      expect(rule.matchers.length).toBeGreaterThan(0);
    }
  });

  it("complex rules have priority 10-15", () => {
    const complexRules = DEFAULT_INTENT_RULES.filter((r) => r.category === "complex");
    for (const rule of complexRules) {
      expect(rule.priority).toBeGreaterThanOrEqual(10);
      expect(rule.priority).toBeLessThanOrEqual(15);
    }
  });

  it("simple rules have higher priority number than complex", () => {
    const complexMax = Math.max(
      ...DEFAULT_INTENT_RULES.filter((r) => r.category === "complex").map((r) => r.priority),
    );
    const simpleMin = Math.min(
      ...DEFAULT_INTENT_RULES.filter((r) => r.category === "simple").map((r) => r.priority),
    );
    expect(simpleMin).toBeGreaterThan(complexMax);
  });
});
