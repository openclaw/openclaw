import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyProviderConfigDefaultsWithPlugin: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  applyProviderConfigDefaultsWithPlugin: (
    ...args: Parameters<typeof mocks.applyProviderConfigDefaultsWithPlugin>
  ) => mocks.applyProviderConfigDefaultsWithPlugin(...args),
}));

let applyContextPruningDefaults: typeof import("./defaults.js").applyContextPruningDefaults;

describe("config defaults", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ applyContextPruningDefaults } = await import("./defaults.js"));
    mocks.applyProviderConfigDefaultsWithPlugin.mockReset();
  });

  it("skips provider defaults when agent defaults are absent", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
          },
        },
      },
    };

    expect(applyContextPruningDefaults(cfg as never)).toBe(cfg);
    expect(mocks.applyProviderConfigDefaultsWithPlugin).not.toHaveBeenCalled();
  });

  it("uses anthropic provider defaults when agent defaults exist", () => {
    const cfg = {
      agents: {
        defaults: {},
      },
    };
    const nextCfg = {
      agents: {
        defaults: {
          contextPruning: {
            mode: "cache-ttl",
          },
        },
      },
    };
    mocks.applyProviderConfigDefaultsWithPlugin.mockReturnValue(nextCfg);

    expect(applyContextPruningDefaults(cfg as never)).toBe(nextCfg);
    expect(mocks.applyProviderConfigDefaultsWithPlugin).toHaveBeenCalledTimes(1);
  });
});
