import { describe, expect, it, vi } from "vitest";

const mockEnsureAuthProfileStore = vi.hoisted(() =>
  vi.fn(() => ({
    version: 1,
    profiles: {},
    usageStats: {},
  })),
);

const mockRunAndLogPreflight = vi.hoisted(() =>
  vi.fn((_params: Record<string, unknown>) => ({ ok: true, checks: [], timestamp: Date.now() })),
);

vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: mockEnsureAuthProfileStore,
}));

vi.mock("./preflight.js", () => ({
  runAndLogPreflight: mockRunAndLogPreflight,
}));

// Stable mock for model selection that avoids importing the full real module.
vi.mock("../agents/model-selection.js", () => ({
  resolveConfiguredModelRef: (params: { defaultProvider: string }) => ({
    provider: params.defaultProvider,
    model: "claude-opus-4-6",
  }),
}));

vi.mock("../config/model-input.js", () => ({
  resolveAgentModelFallbackValues: () => [],
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe("server-preflight", () => {
  it("calls runAndLogPreflight with configured providers", async () => {
    const { runPreflightAtStartup } = await import("./server-preflight.js");
    const cfg = {
      models: {
        providers: {
          anthropic: { baseUrl: "https://api.anthropic.com" },
          openai: { baseUrl: "https://api.openai.com" },
        },
      },
    };
    runPreflightAtStartup({ cfg: cfg as never });

    expect(mockRunAndLogPreflight).toHaveBeenCalledOnce();
    const call = mockRunAndLogPreflight.mock.calls.at(-1)![0];
    expect(call.providers).toContain("anthropic");
    expect(call.providers).toContain("openai");
    expect(call.authStore).toBeTruthy();
  });

  it("does not throw when ensureAuthProfileStore fails", async () => {
    mockEnsureAuthProfileStore.mockImplementationOnce(() => {
      throw new Error("store unavailable");
    });
    const { runPreflightAtStartup } = await import("./server-preflight.js");
    // Should not throw — preflight must not block startup.
    expect(() => runPreflightAtStartup({ cfg: {} as never })).not.toThrow();
  });

  it("includes default provider even without explicit config providers", async () => {
    const { runPreflightAtStartup } = await import("./server-preflight.js");
    runPreflightAtStartup({ cfg: {} as never });

    expect(mockRunAndLogPreflight).toHaveBeenCalled();
    const call = mockRunAndLogPreflight.mock.calls.at(-1)![0];
    // Default provider (anthropic) should be included from model ref resolution.
    expect(call.providers).toContain("anthropic");
  });
});
