import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({ gateway: { oag: { delivery: { maxRetries: 5 } } } }),
}));

vi.mock("./oag-metrics.js", () => ({
  getOagMetrics: () => ({ channelRestarts: 3, deliveryRecoveryFailures: 2 }),
}));

const mockMemory = vi.hoisted(() => ({
  current: {
    version: 1,
    lifecycles: [
      {
        id: "lc-1",
        startedAt: "2026-03-17T00:00:00Z",
        stoppedAt: "2026-03-17T01:00:00Z",
        stopReason: "crash",
        uptimeMs: 3600000,
        metricsSnapshot: {},
        incidents: [],
      },
    ],
    evolutions: [],
    diagnoses: [] as unknown[],
  },
}));

vi.mock("./oag-memory.js", () => ({
  loadOagMemory: vi.fn(async () => JSON.parse(JSON.stringify(mockMemory.current))),
  saveOagMemory: vi.fn(async (m: unknown) => {
    mockMemory.current = m as typeof mockMemory.current;
  }),
  recordDiagnosis: vi.fn(async (r: unknown) => {
    mockMemory.current.diagnoses.push(r);
  }),
  withOagMemory: vi.fn(async (fn: (memory: unknown) => boolean | void) => {
    const memory = JSON.parse(JSON.stringify(mockMemory.current));
    const result = fn(memory);
    if (result !== false) {
      mockMemory.current = memory as typeof mockMemory.current;
    }
  }),
}));

const {
  composeDiagnosisPrompt,
  parseDiagnosisResponse,
  requestDiagnosis,
  completeDiagnosis,
  sanitizeForPrompt,
  buildHistoricalRecommendations,
  getDiagnosisModelConfig,
} = await import("./oag-diagnosis.js");

describe("oag-diagnosis", () => {
  beforeEach(() => {
    mockMemory.current.diagnoses = [];
  });

  it("composes a prompt with all required sections", () => {
    const prompt = composeDiagnosisPrompt(
      {
        type: "recurring_pattern",
        description: "Telegram crash loop",
        channel: "telegram",
        occurrences: 5,
      },
      mockMemory.current as never,
    );
    expect(prompt).toContain("Current Incident");
    expect(prompt).toContain("Telegram crash loop");
    expect(prompt).toContain("Lifecycle History");
    expect(prompt).toContain("Current Metrics");
    expect(prompt).toContain("OAG Config");
    expect(prompt).toContain("Response Schema");
  });

  it("parses a valid JSON diagnosis response", () => {
    const response = JSON.stringify({
      rootCause: "Rate limit exceeded",
      analysis: "Detailed analysis",
      confidence: 0.85,
      recommendations: [
        {
          type: "config_change",
          description: "Increase budget",
          configPath: "gateway.oag.delivery.recoveryBudgetMs",
          suggestedValue: 120000,
          risk: "low",
        },
      ],
      preventive: "Add rate limiting",
    });
    const result = parseDiagnosisResponse(response);
    expect(result).not.toBeNull();
    expect(result!.rootCause).toBe("Rate limit exceeded");
    expect(result!.confidence).toBe(0.85);
    expect(result!.recommendations).toHaveLength(1);
  });

  it("extracts JSON from markdown code blocks", () => {
    const response =
      "Here's my analysis:\n```json\n" +
      JSON.stringify({
        rootCause: "Timeout",
        analysis: "x",
        confidence: 0.7,
        recommendations: [],
      }) +
      "\n```";
    const result = parseDiagnosisResponse(response);
    expect(result).not.toBeNull();
    expect(result!.rootCause).toBe("Timeout");
  });

  it("returns null for invalid response", () => {
    expect(parseDiagnosisResponse("not json")).toBeNull();
    expect(parseDiagnosisResponse('{"rootCause": 123}')).toBeNull();
  });

  it("enforces diagnosis cooldown", async () => {
    mockMemory.current.diagnoses = [
      {
        id: "diag-recent",
        triggeredAt: new Date().toISOString(),
        trigger: "recurring_pattern",
        rootCause: "test",
        confidence: 0.5,
        recommendations: [],
        completedAt: new Date().toISOString(),
      },
    ];
    const result = await requestDiagnosis({
      type: "recurring_pattern",
      description: "same pattern",
    });
    expect(result.ran).toBe(false);
  });

  it("creates a diagnosis record when triggered", async () => {
    const result = await requestDiagnosis({
      type: "recurring_pattern",
      description: "new pattern",
    });
    expect(result.ran).toBe(true);
    expect(result.record).toBeDefined();
    expect(result.record!.trigger).toBe("recurring_pattern");
  });

  describe("sanitizeForPrompt", () => {
    it("serializes primitives via JSON.stringify", () => {
      expect(sanitizeForPrompt("hello")).toBe('"hello"');
      expect(sanitizeForPrompt(42)).toBe("42");
      expect(sanitizeForPrompt(true)).toBe("true");
      expect(sanitizeForPrompt(null)).toBe("null");
    });

    it("serializes objects and arrays", () => {
      expect(sanitizeForPrompt({ a: 1 })).toBe('{"a":1}');
      expect(sanitizeForPrompt([1, 2, 3])).toBe("[1,2,3]");
    });

    it("truncates values exceeding 200 chars", () => {
      const longString = "x".repeat(300);
      const result = sanitizeForPrompt(longString);
      // JSON.stringify wraps in quotes, so the raw serialized is 302 chars
      expect(result.length).toBeLessThanOrEqual(200 + "…[truncated]".length);
      expect(result).toContain("…[truncated]");
    });

    it("does not truncate values at exactly 200 chars", () => {
      // Create a string whose JSON.stringify result is exactly 200 chars: 198 x's + 2 quotes
      const exactString = "x".repeat(198);
      const result = sanitizeForPrompt(exactString);
      expect(result).toBe(JSON.stringify(exactString));
      expect(result).not.toContain("…[truncated]");
    });

    it("falls back to String() for non-serializable values", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const result = sanitizeForPrompt(circular);
      expect(result).toBe("[object Object]");
    });
  });

  it("composes a prompt with sanitized dynamic data", () => {
    const prompt = composeDiagnosisPrompt(
      {
        type: "recurring_pattern",
        description: "Telegram crash loop",
        channel: "telegram",
        occurrences: 5,
      },
      mockMemory.current as never,
    );
    // Dynamic values should be JSON-serialized (sanitized), not raw interpolated
    expect(prompt).toContain('"recurring_pattern"');
    expect(prompt).toContain('"Telegram crash loop"');
    expect(prompt).toContain('"telegram"');
  });

  describe("historical recommendation outcomes", () => {
    it("includes previous recommendation outcomes in diagnosis prompt", () => {
      const memoryWithOutcomes = {
        ...mockMemory.current,
        diagnoses: [
          {
            id: "diag-hist-1",
            triggeredAt: "2026-03-16T00:00:00Z",
            trigger: "recurring_pattern",
            rootCause: "Rate limit",
            confidence: 0.9,
            recommendations: [
              {
                type: "config_change" as const,
                description: "Increase recovery budget",
                configPath: "gateway.oag.delivery.recoveryBudgetMs",
                suggestedValue: 90000,
                risk: "low" as const,
                applied: true,
                recommendationId: "diag-hist-1-rec-0",
                outcome: "effective" as const,
              },
            ],
            completedAt: "2026-03-16T01:00:00Z",
          },
        ],
      };

      const prompt = composeDiagnosisPrompt(
        {
          type: "recurring_pattern",
          description: "New crash loop",
        },
        memoryWithOutcomes as never,
      );

      expect(prompt).toContain("Previous Recommendation Outcomes");
      expect(prompt).toContain("recoveryBudgetMs");
      expect(prompt).toContain("effective");
    });

    it("does not include outcomes section when no historical data exists", () => {
      const prompt = composeDiagnosisPrompt(
        {
          type: "recurring_pattern",
          description: "Crash loop",
        },
        mockMemory.current as never,
      );

      expect(prompt).not.toContain("Previous Recommendation Outcomes");
    });

    it("buildHistoricalRecommendations formats tracked recommendations", () => {
      const memory = {
        ...mockMemory.current,
        diagnoses: [
          {
            id: "diag-tr-1",
            triggeredAt: "2026-03-16T00:00:00Z",
            trigger: "recurring_pattern",
            rootCause: "Timeout",
            confidence: 0.8,
            recommendations: [],
            trackedRecommendations: [
              {
                id: "diag-tr-1-rec-0",
                parameter: "gateway.oag.delivery.maxRetries",
                oldValue: 5,
                newValue: 7,
                risk: "low" as const,
                applied: true,
                outcome: "reverted" as const,
                outcomeAt: "2026-03-16T02:00:00Z",
              },
            ],
            completedAt: "2026-03-16T01:00:00Z",
          },
        ],
      };

      const result = buildHistoricalRecommendations(memory as never);
      expect(result).toContain("maxRetries");
      expect(result).toContain("reverted");
      expect(result).toContain("5");
      expect(result).toContain("7");
    });

    it("limits historical recommendations to 10 entries", () => {
      const diagnoses = [];
      for (let i = 0; i < 15; i++) {
        diagnoses.push({
          id: `diag-limit-${i}`,
          triggeredAt: "2026-03-16T00:00:00Z",
          trigger: "recurring_pattern",
          rootCause: `cause-${i}`,
          confidence: 0.5,
          recommendations: [
            {
              type: "config_change" as const,
              description: `change-${i}`,
              configPath: `gateway.oag.param${i}`,
              suggestedValue: i * 100,
              risk: "low" as const,
              applied: true,
              recommendationId: `diag-limit-${i}-rec-0`,
              outcome: "effective" as const,
            },
          ],
          completedAt: "2026-03-16T01:00:00Z",
        });
      }

      const memory = { ...mockMemory.current, diagnoses };
      const result = buildHistoricalRecommendations(memory as never);
      const lines = result.split("\n").filter((l) => l.length > 0);
      expect(lines.length).toBeLessThanOrEqual(10);
    });
  });

  describe("getDiagnosisModelConfig", () => {
    it("returns lightweight mode by default when config is undefined", () => {
      const config = getDiagnosisModelConfig();
      expect(config.mode).toBe("lightweight");
      expect(config.useEmbeddedRunner).toBe(false);
    });

    it("returns lightweight mode when gateway.oag is absent", () => {
      const config = getDiagnosisModelConfig({ gateway: {} });
      expect(config.mode).toBe("lightweight");
      expect(config.useEmbeddedRunner).toBe(false);
    });

    it("returns lightweight mode when diagnosis section is absent", () => {
      const config = getDiagnosisModelConfig({ gateway: { oag: {} } });
      expect(config.mode).toBe("lightweight");
      expect(config.useEmbeddedRunner).toBe(false);
    });

    it("returns lightweight mode when model is explicitly set to lightweight", () => {
      const config = getDiagnosisModelConfig({
        gateway: { oag: { diagnosis: { model: "lightweight" } } },
      });
      expect(config.mode).toBe("lightweight");
      expect(config.useEmbeddedRunner).toBe(false);
    });

    it("returns embedded mode when model is set to embedded", () => {
      const config = getDiagnosisModelConfig({
        gateway: { oag: { diagnosis: { model: "embedded" } } },
      });
      expect(config.mode).toBe("embedded");
      expect(config.useEmbeddedRunner).toBe(true);
    });

    it("returns lightweight mode for unrecognized model values", () => {
      const config = getDiagnosisModelConfig({
        gateway: { oag: { diagnosis: { model: "unknown" as "lightweight" } } },
      });
      expect(config.mode).toBe("lightweight");
      expect(config.useEmbeddedRunner).toBe(false);
    });
  });

  describe("completeDiagnosis", () => {
    const validResponse = JSON.stringify({
      rootCause: "Rate limit exceeded",
      analysis: "Detailed analysis",
      confidence: 0.85,
      recommendations: [
        {
          type: "config_change",
          description: "Increase budget",
          configPath: "gateway.oag.delivery.recoveryBudgetMs",
          suggestedValue: 120000,
          risk: "low",
        },
      ],
      preventive: "Add rate limiting",
    });

    it("updates the diagnosis record on successful completion", async () => {
      const diagId = "diag-complete-1";
      mockMemory.current.diagnoses = [
        {
          id: diagId,
          triggeredAt: "2026-03-17T00:00:00Z",
          trigger: "recurring_pattern",
          rootCause: "pending agent analysis",
          confidence: 0,
          recommendations: [],
          completedAt: "",
        },
      ];

      const result = await completeDiagnosis(diagId, validResponse);

      expect(result).not.toBeNull();
      expect(result!.rootCause).toBe("Rate limit exceeded");
      expect(result!.confidence).toBe(0.85);
      // Verify the record was updated in memory
      const saved = mockMemory.current.diagnoses.find(
        (d) => (d as { id: string }).id === diagId,
      ) as { rootCause: string; confidence: number; recommendations: unknown[] };
      expect(saved.rootCause).toBe("Rate limit exceeded");
      expect(saved.confidence).toBe(0.85);
      expect(saved.recommendations).toHaveLength(1);
    });

    it("is a no-op when diagnosisId is not found in memory", async () => {
      mockMemory.current.diagnoses = [
        {
          id: "diag-other",
          triggeredAt: "2026-03-17T00:00:00Z",
          trigger: "recurring_pattern",
          rootCause: "pending",
          confidence: 0,
          recommendations: [],
          completedAt: "",
        },
      ];

      const result = await completeDiagnosis("diag-nonexistent", validResponse);

      // Parsing succeeds but no record is updated
      expect(result).not.toBeNull();
      // Original record unchanged
      const original = mockMemory.current.diagnoses[0] as { rootCause: string };
      expect(original.rootCause).toBe("pending");
    });

    it("sets completedAt timestamp on the updated record", async () => {
      const diagId = "diag-complete-ts";
      mockMemory.current.diagnoses = [
        {
          id: diagId,
          triggeredAt: "2026-03-17T00:00:00Z",
          trigger: "adaptation_failed",
          rootCause: "pending agent analysis",
          confidence: 0,
          recommendations: [],
          completedAt: "",
        },
      ];

      const before = Date.now();
      await completeDiagnosis(diagId, validResponse);
      const after = Date.now();

      const saved = mockMemory.current.diagnoses.find(
        (d) => (d as { id: string }).id === diagId,
      ) as { completedAt: string };
      expect(saved.completedAt).toBeTruthy();
      const completedMs = Date.parse(saved.completedAt);
      expect(completedMs).toBeGreaterThanOrEqual(before);
      expect(completedMs).toBeLessThanOrEqual(after);
    });
  });
});
