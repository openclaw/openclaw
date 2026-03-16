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
}));

const { composeDiagnosisPrompt, parseDiagnosisResponse, requestDiagnosis } =
  await import("./oag-diagnosis.js");

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
});
