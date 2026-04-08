import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AGENT_MAX_CONCURRENT, DEFAULT_SUBAGENT_MAX_CONCURRENT } from "./agent-limits.js";

const mocks = vi.hoisted(() => ({
  applyProviderConfigDefaultsWithPlugin: vi.fn(),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  applyProviderConfigDefaultsWithPlugin: (
    ...args: Parameters<typeof mocks.applyProviderConfigDefaultsWithPlugin>
  ) => mocks.applyProviderConfigDefaultsWithPlugin(...args),
}));

let applyContextPruningDefaults: typeof import("./defaults.js").applyContextPruningDefaults;
let applyAgentDefaults: typeof import("./defaults.js").applyAgentDefaults;
let applyMessageDefaults: typeof import("./defaults.js").applyMessageDefaults;

describe("config defaults", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ applyAgentDefaults, applyContextPruningDefaults, applyMessageDefaults } =
      await import("./defaults.js"));
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

  it("defaults ackReactionScope without deriving other message fields", () => {
    const next = applyMessageDefaults({
      agents: {
        list: [
          {
            id: "main",
            identity: {
              name: "Samantha",
              theme: "helpful sloth",
              emoji: "🦥",
            },
          },
        ],
      },
      messages: {},
    } as never);

    expect(next.messages?.ackReactionScope).toBe("group-mentions");
    expect(next.messages?.responsePrefix).toBeUndefined();
    expect(next.messages?.groupChat?.mentionPatterns).toBeUndefined();
  });

  it("fills missing agent concurrency defaults", () => {
    const next = applyAgentDefaults({ messages: {} } as never);

    expect(next.agents?.defaults?.maxConcurrent).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(next.agents?.defaults?.subagents?.maxConcurrent).toBe(DEFAULT_SUBAGENT_MAX_CONCURRENT);
  });
});
