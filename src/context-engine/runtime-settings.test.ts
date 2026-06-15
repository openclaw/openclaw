import { describe, expect, it } from "vitest";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "./host-compat.js";
import { buildContextEngineRuntimeSettings } from "./runtime-settings.js";
import {
  ContextEngineRuntimeSettingsUnavailableError,
  ContextEngineRuntimeSettingsUnsupportedError,
} from "./types.js";

describe("context engine runtime settings", () => {
  it("builds declared normal runtime settings from host and model inputs", () => {
    const settings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      harnessId: "embedded",
      runtimeId: "direct",
      provider: "openai",
      requestedModel: "gpt-5.5",
      resolvedModel: "gpt-5.5",
      tokenBudget: 128_000,
      maxOutputTokens: 8192,
    });

    expect(settings).toMatchObject({
      schemaVersion: 1,
      runtime: {
        host: "openclaw",
        mode: "normal",
        harnessId: "embedded",
        runtimeId: "direct",
      },
      model: {
        requested: "gpt-5.5",
        resolved: "gpt-5.5",
        provider: "openai",
        fallbackActive: false,
      },
      limits: {
        tokenBudget: 128_000,
        maxOutputTokens: 8192,
      },
      diagnostics: {
        fallbackReason: null,
        degradedReason: null,
      },
    });
    expect(settings.contextEngine).toEqual({
      hostId: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST.id,
      hostLabel: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST.label,
      capabilities: [...OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST.capabilities],
    });
  });

  it("marks fallback mode when a fallback reason is present", () => {
    const settings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      resolvedModel: "gpt-5-mini",
      fallbackReason: "primary_unavailable",
    });

    expect(settings.runtime.mode).toBe("fallback");
    expect(settings.model.fallbackActive).toBe(true);
    expect(settings.diagnostics.fallbackReason).toBe("primary_unavailable");
  });

  it("keeps fallbackReason and fallbackActive internally consistent", () => {
    const settings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      resolvedModel: "gpt-5-mini",
      fallbackActive: false,
      fallbackReason: "primary_unavailable",
    });

    expect(settings.runtime.mode).toBe("fallback");
    expect(settings.model.fallbackActive).toBe(true);
    expect(settings.diagnostics.fallbackReason).toBe("primary_unavailable");
  });

  it("marks degraded mode when a degraded reason is present", () => {
    const settings = buildContextEngineRuntimeSettings({
      contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
      resolvedModel: "gpt-5-mini",
      degradedReason: "context_pressure_high",
    });

    expect(settings.runtime.mode).toBe("degraded");
    expect(settings.diagnostics.degradedReason).toBe("context_pressure_high");
  });

  it("fails closed when host support is missing a host id", () => {
    expect(() =>
      buildContextEngineRuntimeSettings({
        contextEngineHost: {
          ...OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
          id: "",
        },
      }),
    ).toThrow(ContextEngineRuntimeSettingsUnavailableError);
  });

  it("fails closed when host capabilities are not an array", () => {
    expect(() =>
      buildContextEngineRuntimeSettings({
        contextEngineHost: {
          ...OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
          capabilities: "assemble-before-prompt" as never,
        },
      }),
    ).toThrow(ContextEngineRuntimeSettingsUnsupportedError);
  });
});
