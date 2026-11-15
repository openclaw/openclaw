import { describe, expect, it } from "vitest";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "./host-compat.js";
import { buildContextEngineRuntimeSettings } from "./runtime-settings.js";

describe("context engine runtime settings", () => {
  it("marks fallback mode when resolved model differs from the requested model", () => {
    const settings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      requestedModel: "openai/gpt-5.5",
      resolvedModel: "anthropic/claude-sonnet-4-6",
    });

    expect(settings.runtime.mode).toBe("fallback");
    expect(settings.diagnostics.fallbackReason).toBeNull();
  });

  it("marks degraded mode when a degraded reason is present", () => {
    const settings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      resolvedModel: "gpt-5-mini",
      degradedReason: "context_pressure_high",
    });

    expect(settings.runtime.mode).toBe("degraded");
    expect(settings.diagnostics.degradedReason).toBe("context_overflow");
  });

  it("keeps host and selection ids nullable when unknown", () => {
    const settings = buildContextEngineRuntimeSettings({
      contextEngineHost: {
        ...OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        id: "",
      },
    });

    expect(settings.contextEngineSelection).toEqual({
      selectedId: null,
      source: "unknown",
    });
    expect(settings.executionHost.id).toBeNull();
  });
});
