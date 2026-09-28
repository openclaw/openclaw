import { describe, expect, it } from "vitest";
import { activationTimeoutForKind, initialWizardValue, mapActivationResult } from "./state.ts";

describe("model setup state", () => {
  it("matches the activation and provider-auth wizard lifetimes", () => {
    expect(activationTimeoutForKind("codex-cli")).toBe(480_000);
    expect(activationTimeoutForKind("claude-cli")).toBe(480_000);
    expect(activationTimeoutForKind("api-key")).toBe(480_000);
    expect(activationTimeoutForKind("provider-auth")).toBe(25 * 60_000);
  });

  it("maps activation success and categorized failure results", () => {
    expect(
      mapActivationResult({
        result: { ok: true, modelRef: "openai/gpt-5", latencyMs: 84, lines: [] },
        targetId: "openai",
        fallbackError: "failed",
        restartWarning: "Restart the Gateway",
      }),
    ).toEqual({ phase: "success", modelRef: "openai/gpt-5", latencyMs: 84 });
    expect(
      mapActivationResult({
        result: { ok: false, status: "billing", error: "No credits" },
        targetId: "openai",
        fallbackError: "failed",
        restartWarning: "Restart the Gateway",
      }),
    ).toEqual({ phase: "failure", targetId: "openai", status: "billing", error: "No credits" });
    expect(
      mapActivationResult({
        result: { ok: false },
        targetId: "openai",
        fallbackError: "failed",
        restartWarning: "Restart the Gateway",
      }),
    ).toEqual({ phase: "failure", targetId: "openai", status: "unknown", error: "failed" });
  });

  it("copies multiselect initial values", () => {
    const initial = ["a"];
    const value = initialWizardValue({ id: "models", type: "multiselect", initialValue: initial });
    expect(value).toEqual(["a"]);
    expect(value).not.toBe(initial);
  });
});
