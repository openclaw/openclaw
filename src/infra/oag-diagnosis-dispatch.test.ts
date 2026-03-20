import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("./oag-memory.js", () => ({
  loadOagMemory: vi.fn(async () => ({ version: 1, lifecycles: [], evolutions: [], diagnoses: [] })),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: () => ({ gateway: { oag: { evolution: { autoApply: true } } } }),
}));

vi.mock("./oag-config-writer.js", () => ({
  applyOagConfigChanges: vi.fn(async () => ({ applied: true })),
}));

// Use hoisted mock for completeDiagnosis to allow per-test configuration
const mockCompleteDiagnosis = vi.hoisted(() =>
  vi.fn(async () => ({
    rootCause: "test",
    analysis: "test",
    confidence: 0.9,
    recommendations: [
      {
        type: "config_change",
        description: "test",
        configPath: "gateway.oag.delivery.maxRetries",
        suggestedValue: 8,
        risk: "low",
      },
    ],
  })),
);

vi.mock("./oag-diagnosis.js", () => ({
  composeDiagnosisPrompt: vi.fn(() => "test prompt"),
  completeDiagnosis: mockCompleteDiagnosis,
}));

const { registerDiagnosisDispatch, isDiagnosisDispatchRegistered, dispatchDiagnosis } =
  await import("./oag-diagnosis-dispatch.js");

describe("oag-diagnosis-dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset by re-registering null — but since there's no unregister, we test in order
  });

  it("returns dispatched=false when no dispatch registered", async () => {
    const result = await dispatchDiagnosis(
      { type: "recurring_pattern", description: "test" },
      "diag-1",
    );
    expect(result.dispatched).toBe(false);
  });

  it("times out when agent dispatch hangs", async () => {
    vi.useFakeTimers();
    const hangingDispatch = vi.fn(
      () => new Promise<string>(() => {}), // Never resolves
    );
    registerDiagnosisDispatch(hangingDispatch);

    const resultPromise = dispatchDiagnosis(
      { type: "recurring_pattern", description: "test" },
      "diag-timeout",
    );

    // Advance past the 60s timeout
    await vi.advanceTimersByTimeAsync(60_000);

    const result = await resultPromise;
    expect(result.dispatched).toBe(false);
    expect(result.applied).toBe(0);
    vi.useRealTimers();
  });

  it("registers and dispatches to agent", async () => {
    mockCompleteDiagnosis.mockResolvedValueOnce({
      rootCause: "test",
      analysis: "x",
      confidence: 0.9,
      recommendations: [
        {
          type: "config_change",
          description: "t",
          configPath: "gateway.oag.delivery.maxRetries",
          suggestedValue: 8,
          risk: "low",
        },
      ],
    });
    const mockDispatch = vi.fn(async () => "response");
    registerDiagnosisDispatch(mockDispatch);
    expect(isDiagnosisDispatchRegistered()).toBe(true);

    const result = await dispatchDiagnosis(
      { type: "recurring_pattern", description: "test" },
      "diag-2",
    );
    expect(result.dispatched).toBe(true);
    expect(result.applied).toBe(1);
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "oag:diagnosis:diag-2",
        agentId: "oag",
      }),
    );
  });

  describe("auto-apply security allowlist", () => {
    it("allows allowlisted config paths", async () => {
      mockCompleteDiagnosis.mockResolvedValueOnce({
        rootCause: "test",
        analysis: "x",
        confidence: 0.9,
        recommendations: [
          {
            type: "config_change",
            description: "valid change",
            configPath: "gateway.oag.health.stalePollFactor",
            suggestedValue: 3,
            risk: "low",
          },
        ],
      });
      const mockDispatch = vi.fn(async () => "response");
      registerDiagnosisDispatch(mockDispatch);

      const result = await dispatchDiagnosis(
        { type: "recurring_pattern", description: "test" },
        "diag-allowlist",
      );
      expect(result.dispatched).toBe(true);
      expect(result.applied).toBe(1);
    });

    it("rejects non-allowlisted config paths", async () => {
      mockCompleteDiagnosis.mockResolvedValueOnce({
        rootCause: "test",
        analysis: "x",
        confidence: 0.9,
        recommendations: [
          {
            type: "config_change",
            description: "non-allowlisted path",
            configPath: "gateway.oag.evolution.autoApply",
            suggestedValue: true,
            risk: "low",
          },
        ],
      });
      const mockDispatch = vi.fn(async () => "response");
      registerDiagnosisDispatch(mockDispatch);

      const result = await dispatchDiagnosis(
        { type: "recurring_pattern", description: "test" },
        "diag-nonallowlist",
      );
      expect(result.dispatched).toBe(true);
      expect(result.applied).toBe(0); // Rejected because path not in allowlist
    });

    it("rejects malicious __proto__ path", async () => {
      mockCompleteDiagnosis.mockResolvedValueOnce({
        rootCause: "test",
        analysis: "x",
        confidence: 0.9,
        recommendations: [
          {
            type: "config_change",
            description: "prototype pollution attempt",
            configPath: "gateway.oag.__proto__",
            suggestedValue: { malicious: true },
            risk: "low",
          },
        ],
      });
      const mockDispatch = vi.fn(async () => "response");
      registerDiagnosisDispatch(mockDispatch);

      const result = await dispatchDiagnosis(
        { type: "recurring_pattern", description: "test" },
        "diag-proto",
      );
      expect(result.dispatched).toBe(true);
      expect(result.applied).toBe(0); // Rejected malicious path
    });

    it("rejects malicious constructor path", async () => {
      mockCompleteDiagnosis.mockResolvedValueOnce({
        rootCause: "test",
        analysis: "x",
        confidence: 0.9,
        recommendations: [
          {
            type: "config_change",
            description: "constructor pollution attempt",
            configPath: "gateway.oag.constructor",
            suggestedValue: { malicious: true },
            risk: "low",
          },
        ],
      });
      const mockDispatch = vi.fn(async () => "response");
      registerDiagnosisDispatch(mockDispatch);

      const result = await dispatchDiagnosis(
        { type: "recurring_pattern", description: "test" },
        "diag-constructor",
      );
      expect(result.dispatched).toBe(true);
      expect(result.applied).toBe(0); // Rejected malicious path
    });

    it("rejects arbitrary path outside oag namespace", async () => {
      mockCompleteDiagnosis.mockResolvedValueOnce({
        rootCause: "test",
        analysis: "x",
        confidence: 0.9,
        recommendations: [
          {
            type: "config_change",
            description: "arbitrary path attempt",
            configPath: "gateway.someOtherService.enabled",
            suggestedValue: true,
            risk: "low",
          },
        ],
      });
      const mockDispatch = vi.fn(async () => "response");
      registerDiagnosisDispatch(mockDispatch);

      const result = await dispatchDiagnosis(
        { type: "recurring_pattern", description: "test" },
        "diag-arbitrary",
      );
      expect(result.dispatched).toBe(true);
      expect(result.applied).toBe(0);
    });

    it("mixes allowed and rejected paths", async () => {
      mockCompleteDiagnosis.mockResolvedValueOnce({
        rootCause: "test",
        analysis: "x",
        confidence: 0.9,
        recommendations: [
          {
            type: "config_change",
            description: "allowed",
            configPath: "gateway.oag.delivery.maxRetries",
            suggestedValue: 5,
            risk: "low",
          },
          {
            type: "config_change",
            description: "rejected",
            configPath: "gateway.oag.__proto__",
            suggestedValue: {},
            risk: "low",
          },
          {
            type: "config_change",
            description: "also allowed",
            configPath: "gateway.oag.lock.staleMs",
            suggestedValue: 30000,
            risk: "low",
          },
        ],
      });
      const mockDispatch = vi.fn(async () => "response");
      registerDiagnosisDispatch(mockDispatch);

      const result = await dispatchDiagnosis(
        { type: "recurring_pattern", description: "test" },
        "diag-mixed",
      );
      expect(result.dispatched).toBe(true);
      expect(result.applied).toBe(2); // Only the 2 allowed paths
    });
  });
});
