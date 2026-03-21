import { describe, expect, it, vi } from "vitest";
import { validateConfigObjectRaw } from "./validation.js";

describe("provider-level validation sanitization", () => {
  it("accepts config when all providers are valid", () => {
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-4o", name: "GPT-4o" }],
          },
        },
      },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.models?.providers?.openai).toBeDefined();
    }
  });

  it("skips the invalid provider and keeps valid ones", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-4o", name: "GPT-4o" }],
          },
          broken: {
            baseUrl: "https://example.com",
            models: [{ id: "m1", name: "Model 1" }],
            notARealField: true,
          },
        },
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.models?.providers?.openai).toBeDefined();
      expect(result.config.models?.providers?.broken).toBeUndefined();
    }
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('skipping invalid provider "models.providers.broken"'),
    );
    spy.mockRestore();
  });

  it("logs a warning that identifies the failing field", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    validateConfigObjectRaw({
      models: {
        providers: {
          bad: {
            baseUrl: "https://example.com",
            models: [{ id: "m1", name: "Model 1" }],
            bogus: 123,
          },
        },
      },
    });

    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/models\.providers\.bad.*bogus/));
    spy.mockRestore();
  });

  it("still rejects config when non-provider fields are invalid", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = validateConfigObjectRaw({
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [{ id: "gpt-4o", name: "GPT-4o" }],
          },
        },
      },
      nope: true,
    });
    expect(result.ok).toBe(false);
    spy.mockRestore();
  });
});
