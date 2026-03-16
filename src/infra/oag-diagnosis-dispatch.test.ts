import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock("./oag-diagnosis.js", () => ({
  composeDiagnosisPrompt: vi.fn(() => "test prompt"),
  completeDiagnosis: vi.fn(async () => ({
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
}));

vi.mock("./oag-memory.js", () => ({
  loadOagMemory: vi.fn(async () => ({ version: 1, lifecycles: [], evolutions: [], diagnoses: [] })),
}));

vi.mock("./oag-config-writer.js", () => ({
  applyOagConfigChanges: vi.fn(async () => ({ applied: true })),
}));

const { registerDiagnosisDispatch, isDiagnosisDispatchRegistered, dispatchDiagnosis } =
  await import("./oag-diagnosis-dispatch.js");

describe("oag-diagnosis-dispatch", () => {
  beforeEach(() => {
    // Reset by re-registering null — but since there's no unregister, we test in order
  });

  it("returns dispatched=false when no dispatch registered", async () => {
    const result = await dispatchDiagnosis(
      { type: "recurring_pattern", description: "test" },
      "diag-1",
    );
    expect(result.dispatched).toBe(false);
  });

  it("registers and dispatches to agent", async () => {
    const mockDispatch = vi.fn(async () =>
      JSON.stringify({
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
      }),
    );
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
});
