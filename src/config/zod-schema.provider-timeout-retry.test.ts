import { describe, it, expect } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("ModelProviderSchema: request.timeoutMs", () => {
  it("accepts request.timeoutMs on a provider", () => {
    const config = OpenClawSchema.parse({
      models: {
        providers: {
          "test-provider": {
            baseUrl: "https://api.test.com",
            request: { timeoutMs: 30_000 },
            models: [],
          },
        },
      },
    });
    expect(config.models?.providers?.["test-provider"]?.request?.timeoutMs).toBe(30_000);
  });

  it("rejects request.timeoutMs > 600000", () => {
    expect(() =>
      OpenClawSchema.parse({
        models: {
          providers: {
            "test-provider": {
              baseUrl: "https://api.test.com",
              request: { timeoutMs: 700_000 },
              models: [],
            },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects request.timeoutMs <= 0", () => {
    expect(() =>
      OpenClawSchema.parse({
        models: {
          providers: {
            "test-provider": {
              baseUrl: "https://api.test.com",
              request: { timeoutMs: 0 },
              models: [],
            },
          },
        },
      }),
    ).toThrow();
  });

  it("coexists with provider-level timeoutSeconds", () => {
    const config = OpenClawSchema.parse({
      models: {
        providers: {
          "test-provider": {
            baseUrl: "https://api.test.com",
            timeoutSeconds: 300,
            request: { timeoutMs: 15_000 },
            models: [],
          },
        },
      },
    });
    // Both fields are preserved in config; runtime resolution prefers request.timeoutMs
    expect(config.models?.providers?.["test-provider"]?.timeoutSeconds).toBe(300);
    expect(config.models?.providers?.["test-provider"]?.request?.timeoutMs).toBe(15_000);
  });
});

describe("ModelProviderSchema: retry", () => {
  it("accepts a full retry config", () => {
    const config = OpenClawSchema.parse({
      models: {
        providers: {
          "test-provider": {
            baseUrl: "https://api.test.com",
            retry: {
              attempts: 3,
              minDelayMs: 500,
              maxDelayMs: 10_000,
              jitter: true,
            },
            models: [],
          },
        },
      },
    });
    expect(config.models?.providers?.["test-provider"]?.retry).toEqual({
      attempts: 3,
      minDelayMs: 500,
      maxDelayMs: 10_000,
      jitter: true,
    });
  });

  it("accepts partial retry config", () => {
    const config = OpenClawSchema.parse({
      models: {
        providers: {
          "test-provider": {
            baseUrl: "https://api.test.com",
            retry: { attempts: 2 },
            models: [],
          },
        },
      },
    });
    expect(config.models?.providers?.["test-provider"]?.retry?.attempts).toBe(2);
  });

  it("rejects retry.attempts > 5", () => {
    expect(() =>
      OpenClawSchema.parse({
        models: {
          providers: {
            "test-provider": {
              baseUrl: "https://api.test.com",
              retry: { attempts: 10 },
              models: [],
            },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects retry.attempts < 1", () => {
    expect(() =>
      OpenClawSchema.parse({
        models: {
          providers: {
            "test-provider": {
              baseUrl: "https://api.test.com",
              retry: { attempts: 0 },
              models: [],
            },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects retry.maxDelayMs > 300000", () => {
    expect(() =>
      OpenClawSchema.parse({
        models: {
          providers: {
            "test-provider": {
              baseUrl: "https://api.test.com",
              retry: { maxDelayMs: 500_000 },
              models: [],
            },
          },
        },
      }),
    ).toThrow();
  });

  it("rejects unknown retry fields (strict mode)", () => {
    expect(() =>
      OpenClawSchema.parse({
        models: {
          providers: {
            "test-provider": {
              baseUrl: "https://api.test.com",
              retry: { backoff: "exponential" },
              models: [],
            },
          },
        },
      }),
    ).toThrow();
  });
});
