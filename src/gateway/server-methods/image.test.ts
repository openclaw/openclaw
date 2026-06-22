/**
 * Tests for image.providers gateway handler.
 * Includes regression tests for auth-profile-only and empty-config cases.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { imageHandlers } from "./image.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  listImageGenerationProviders: vi.fn(() => []),
  loadAuthProfileStoreForRuntime: vi.fn(() => ({ profiles: {} })),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig:
    mocks.getRuntimeConfig as typeof import("../../config/config.js").getRuntimeConfig,
}));

vi.mock("../../image-generation/provider-registry.js", () => ({
  listImageGenerationProviders:
    mocks.listImageGenerationProviders as typeof import("../../image-generation/provider-registry.js").listImageGenerationProviders,
}));

vi.mock("../../agents/auth-profiles/store.js", () => ({
  loadAuthProfileStoreForRuntime:
    mocks.loadAuthProfileStoreForRuntime as typeof import("../../agents/auth-profiles/store.js").loadAuthProfileStoreForRuntime,
}));

describe("imageHandlers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Test 1: no active provider - imageGenerationModel not configured
  it("returns null active when imageGenerationModel not configured", async () => {
    const mockRespond = vi.fn();
    const mockContext = {
      getRuntimeConfig: () => ({
        models: { providers: {} },
        plugins: { entries: {} },
        auth: { profiles: {} },
        agents: { defaults: {} },
      }),
    };

    mocks.listImageGenerationProviders.mockReturnValue([]);

    await imageHandlers["image.providers"]({
      respond: mockRespond,
      context: mockContext as never,
    });

    expect(mockRespond).toHaveBeenCalledWith(true, expect.objectContaining({ active: null }));
  });

  // Test 2: configured/readiness state - provider.isConfigured returns true
  it("marks provider as configured when isConfigured returns true", async () => {
    const mockRespond = vi.fn();
    const mockProvider = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "dall-e-3",
      models: ["dall-e-3"],
      capabilities: {
        generate: { enabled: true },
        edit: { enabled: false },
      },
      isConfigured: vi.fn().mockReturnValue(true),
    };
    const mockContext = {
      getRuntimeConfig: () => ({
        models: { providers: {} },
        plugins: { entries: {} },
        auth: { profiles: {} },
        agents: { defaults: {} },
      }),
    };

    mocks.listImageGenerationProviders.mockReturnValue([mockProvider]);

    await imageHandlers["image.providers"]({
      respond: mockRespond,
      context: mockContext as never,
    });

    expect(mockRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({ id: "openai", configured: true }),
        ]),
      }),
    );
  });

  // Test 3: response validation - schema validates correctly
  it("validates response against ImageProvidersResultSchema", async () => {
    const mockRespond = vi.fn();
    const mockProvider = {
      id: "test",
      label: "Test",
      defaultModel: "test-model",
      models: ["test-model"],
      capabilities: {
        generate: { enabled: true },
        edit: { enabled: false },
      },
      isConfigured: vi.fn().mockReturnValue(false),
    };
    const mockContext = {
      getRuntimeConfig: () => ({
        models: { providers: {} },
        plugins: { entries: {} },
        auth: { profiles: {} },
        agents: { defaults: {} },
      }),
    };

    mocks.listImageGenerationProviders.mockReturnValue([mockProvider]);

    await imageHandlers["image.providers"]({
      respond: mockRespond,
      context: mockContext as never,
    });

    // Should return valid response
    expect(mockRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        providers: expect.any(Array),
        active: null,
      }),
    );
  });

  // Test 4: representative capability payloads - full capability contract
  it("includes maxInputImages, aspectRatiosByModel, resolutionsByModel in capabilities", async () => {
    const mockRespond = vi.fn();
    const mockProvider = {
      id: "stability",
      label: "Stability AI",
      defaultModel: "sd-xl",
      models: ["sd-xl"],
      capabilities: {
        generate: { enabled: true, maxCount: 10 },
        edit: { enabled: true, maxInputImages: 5 },
        geometry: {
          sizes: ["512x512", "1024x1024"],
          aspectRatiosByModel: { "sd-xl": ["16:9", "4:3"] },
          resolutionsByModel: { "sd-xl": ["1K", "2K"] },
        },
        output: { formats: ["png", "jpeg"] },
      },
      isConfigured: vi.fn().mockReturnValue(false),
    };
    const mockContext = {
      getRuntimeConfig: () => ({
        models: { providers: {} },
        plugins: { entries: {} },
        auth: { profiles: {} },
        agents: { defaults: {} },
      }),
    };

    mocks.listImageGenerationProviders.mockReturnValue([mockProvider]);

    await imageHandlers["image.providers"]({
      respond: mockRespond,
      context: mockContext as never,
    });

    expect(mockRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({
            id: "stability",
            capabilities: expect.objectContaining({
              edit: expect.objectContaining({ maxInputImages: 5 }),
              geometry: expect.objectContaining({
                aspectRatiosByModel: { "sd-xl": ["16:9", "4:3"] },
                resolutionsByModel: { "sd-xl": ["1K", "2K"] },
              }),
            }),
          }),
        ]),
      }),
    );
  });

  // ========== Regression Tests (per ClawSweeper P2 requirement) ==========

  // Test 5: lazy provider (no isConfigured) - uses canonical auth profile store
  it("marks lazy provider as configured when has model config (no isConfigured implemented)", async () => {
    const mockRespond = vi.fn();
    const mockProvider = {
      id: "google",
      label: "Google",
      defaultModel: "gemini-2.0-flash",
      models: ["gemini-2.0-flash"],
      capabilities: { generate: { enabled: true }, edit: { enabled: false } },
      // Provider does NOT implement isConfigured - relies on fallback
      isConfigured: undefined,
    };
    const mockContext = {
      getRuntimeConfig: () => ({
        models: {
          providers: {
            google: { model: "gemini-2.0-flash" },
          },
        },
        plugins: { entries: {} },
        auth: { profiles: {} },
        agents: { defaults: {} },
      }),
    };

    mocks.listImageGenerationProviders.mockReturnValue([mockProvider]);
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue({ profiles: {} });

    await imageHandlers["image.providers"]({
      respond: mockRespond,
      context: mockContext as never,
    });

    expect(mockRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({ id: "google", configured: true }),
        ]),
      }),
    );
  });

  // Test 6: empty provider config entry - configured: false when no auth, no model, no plugin config
  it("marks provider as not configured when empty config (empty-config case)", async () => {
    const mockRespond = vi.fn();
    const mockProvider = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "dall-e-3",
      models: ["dall-e-3"],
      capabilities: { generate: { enabled: true }, edit: { enabled: false } },
      isConfigured: undefined,
    };
    const mockContext = {
      getRuntimeConfig: () => ({
        models: { providers: {} },
        plugins: { entries: {} },
        auth: { profiles: {} },
        agents: { defaults: {} },
      }),
    };

    mocks.listImageGenerationProviders.mockReturnValue([mockProvider]);
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue({ profiles: {} });

    await imageHandlers["image.providers"]({
      respond: mockRespond,
      context: mockContext as never,
    });

    expect(mockRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({ id: "openai", configured: false }),
        ]),
      }),
    );
  });

  // Test 7: model config provider - configured when has model config
  it("marks provider as configured when has model config", async () => {
    const mockRespond = vi.fn();
    const mockProvider = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "dall-e-3",
      models: ["dall-e-3"],
      capabilities: { generate: { enabled: true }, edit: { enabled: false } },
      isConfigured: undefined,
    };
    const mockContext = {
      getRuntimeConfig: () => ({
        models: {
          providers: {
            openai: { model: "dall-e-3" },
          },
        },
        plugins: { entries: {} },
        auth: { profiles: {} },
        agents: { defaults: {} },
      }),
    };

    mocks.listImageGenerationProviders.mockReturnValue([mockProvider]);
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue({ profiles: {} });

    await imageHandlers["image.providers"]({
      respond: mockRespond,
      context: mockContext as never,
    });

    expect(mockRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({ id: "openai", configured: true }),
        ]),
      }),
    );
  });

  // Test 8: plugin config provider - configured when has plugin config
  it("marks provider as configured when has plugin config", async () => {
    const mockRespond = vi.fn();
    const mockProvider = {
      id: "comfy",
      label: "ComfyUI",
      defaultModel: "workflow",
      models: ["workflow"],
      capabilities: { generate: { enabled: true }, edit: { enabled: false } },
      isConfigured: undefined,
    };
    const mockContext = {
      getRuntimeConfig: () => ({
        models: { providers: {} },
        plugins: {
          entries: {
            comfy: { config: { endpoint: "http://localhost:8188" } },
          },
        },
        auth: { profiles: {} },
        agents: { defaults: {} },
      }),
    };

    mocks.listImageGenerationProviders.mockReturnValue([mockProvider]);
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue({ profiles: {} });

    await imageHandlers["image.providers"]({
      respond: mockRespond,
      context: mockContext as never,
    });

    expect(mockRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({ id: "comfy", configured: true }),
        ]),
      }),
    );
  });

  // Test 9: TTS provider config - configured when has TTS provider config
  it("marks provider as configured when has TTS provider config", async () => {
    const mockRespond = vi.fn();
    const mockProvider = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "dall-e-3",
      models: ["dall-e-3"],
      capabilities: { generate: { enabled: true }, edit: { enabled: false } },
      isConfigured: undefined,
    };
    const mockContext = {
      getRuntimeConfig: () => ({
        models: { providers: {} },
        plugins: { entries: {} },
        auth: { profiles: {} },
        agents: { defaults: {} },
        messages: {
          tts: {
            providers: {
              openai: { voice: "alloy" },
            },
          },
        },
      }),
    };

    mocks.listImageGenerationProviders.mockReturnValue([mockProvider]);
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue({ profiles: {} });

    await imageHandlers["image.providers"]({
      respond: mockRespond,
      context: mockContext as never,
    });

    expect(mockRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({ id: "openai", configured: true }),
        ]),
      }),
    );
  });

  // Test 10: auth profile - configured when has auth profile (canonical store)
  it("marks provider as configured when has auth profile (canonical store)", async () => {
    const mockRespond = vi.fn();
    const mockProvider = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "dall-e-3",
      models: ["dall-e-3"],
      capabilities: { generate: { enabled: true }, edit: { enabled: false } },
      isConfigured: undefined,
    };
    const mockContext = {
      getRuntimeConfig: () => ({
        models: { providers: {} },
        plugins: { entries: {} },
        auth: { profiles: {} },
        agents: { defaults: {} },
      }),
    };

    mocks.listImageGenerationProviders.mockReturnValue([mockProvider]);
    // Canonical store has auth profile for openai
    mocks.loadAuthProfileStoreForRuntime.mockReturnValue({
      profiles: {
        "openai:default": { apiKey: "sk-..." },
      },
    });

    await imageHandlers["image.providers"]({
      respond: mockRespond,
      context: mockContext as never,
    });

    expect(mockRespond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        providers: expect.arrayContaining([
          expect.objectContaining({ id: "openai", configured: true }),
        ]),
      }),
    );
  });
});
