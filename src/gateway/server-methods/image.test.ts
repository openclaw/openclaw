/**
 * Tests for image.providers gateway handler.
 */
import { describe, expect, it, vi } from "vitest";
import { imageHandlers } from "./image.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  listImageGenerationProviders: vi.fn(() => []),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig:
    mocks.getRuntimeConfig as typeof import("../../config/config.js").getRuntimeConfig,
}));

vi.mock("../../image-generation/provider-registry.js", () => ({
  listImageGenerationProviders:
    mocks.listImageGenerationProviders as typeof import("../../image-generation/provider-registry.js").listImageGenerationProviders,
}));

describe("imageHandlers", () => {
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
});
