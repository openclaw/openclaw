import { afterEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { DEFAULT_AGENT_MAX_CONCURRENT, DEFAULT_SUBAGENT_MAX_CONCURRENT } from "./agent-limits.js";
import {
  applyAgentDefaults,
  applyCompactionDefaults,
  applyContextPruningDefaults,
  applyLoggingDefaults,
  applyMessageDefaults,
  applySessionDefaults,
  resetSessionDefaultsWarningForTests,
} from "./defaults.js";
import type { OpenClawConfig } from "./types.js";

afterEach(() => {
  resetSessionDefaultsWarningForTests();
});

describe("config defaults helpers", () => {
  it("defaults messages.ackReactionScope when unset", () => {
    const next = applyMessageDefaults({});

    expect(next.messages?.ackReactionScope).toBe("group-mentions");
  });

  it("preserves explicit messages.ackReactionScope", () => {
    const cfg: OpenClawConfig = {
      messages: {
        ackReactionScope: "all",
      },
    };

    expect(applyMessageDefaults(cfg)).toBe(cfg);
  });

  it("normalizes session.mainKey and warns only once per warnState", () => {
    const warn = vi.fn();
    const warnState = { warned: false };

    const first = applySessionDefaults(
      {
        session: {
          mainKey: "primary",
        },
      },
      { warn, warnState },
    );
    const second = applySessionDefaults(
      {
        session: {
          mainKey: "secondary",
        },
      },
      { warn, warnState },
    );

    expect(first.session?.mainKey).toBe("main");
    expect(second.session?.mainKey).toBe("main");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('session.mainKey is ignored; main session is always "main".');
  });

  it("does not warn for blank or canonical session.mainKey values", () => {
    const warn = vi.fn();

    const blank = applySessionDefaults(
      {
        session: {
          mainKey: "   ",
        },
      },
      { warn },
    );
    const canonical = applySessionDefaults(
      {
        session: {
          mainKey: "main",
        },
      },
      { warn },
    );

    expect(blank.session?.mainKey).toBe("main");
    expect(canonical.session?.mainKey).toBe("main");
    expect(warn).not.toHaveBeenCalled();
  });

  it("fills missing agent and subagent concurrency defaults independently", () => {
    const missingBoth = applyAgentDefaults({});
    const missingTopLevel = applyAgentDefaults({
      agents: {
        defaults: {
          subagents: {
            maxConcurrent: 9,
          },
        },
      },
    });
    const missingSubagents = applyAgentDefaults({
      agents: {
        defaults: {
          maxConcurrent: 7,
        },
      },
    });

    expect(missingBoth.agents?.defaults?.maxConcurrent).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(missingBoth.agents?.defaults?.subagents?.maxConcurrent).toBe(
      DEFAULT_SUBAGENT_MAX_CONCURRENT,
    );
    expect(missingTopLevel.agents?.defaults?.maxConcurrent).toBe(DEFAULT_AGENT_MAX_CONCURRENT);
    expect(missingTopLevel.agents?.defaults?.subagents?.maxConcurrent).toBe(9);
    expect(missingSubagents.agents?.defaults?.maxConcurrent).toBe(7);
    expect(missingSubagents.agents?.defaults?.subagents?.maxConcurrent).toBe(
      DEFAULT_SUBAGENT_MAX_CONCURRENT,
    );
  });

  it("preserves explicit finite concurrency defaults", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          maxConcurrent: 3,
          subagents: {
            maxConcurrent: 5,
          },
        },
      },
    };

    expect(applyAgentDefaults(cfg)).toBe(cfg);
  });

  it("defaults logging.redactSensitive when the logging block exists", () => {
    const next = applyLoggingDefaults({
      logging: {},
    });

    expect(next.logging?.redactSensitive).toBe("tools");
  });

  it("leaves logging unchanged when absent or explicit", () => {
    expect(applyLoggingDefaults({})).toEqual({});

    const explicit: OpenClawConfig = {
      logging: {
        redactSensitive: "off",
      },
    };
    expect(applyLoggingDefaults(explicit)).toBe(explicit);
  });

  it("does not enable context pruning without agent defaults or Anthropic auth", async () => {
    await withEnvAsync({ ANTHROPIC_API_KEY: "", ANTHROPIC_OAUTH_TOKEN: "" }, async () => {
      expect(applyContextPruningDefaults({})).toEqual({});

      const withoutAuth: OpenClawConfig = {
        agents: {
          defaults: {},
        },
      };
      expect(applyContextPruningDefaults(withoutAuth)).toBe(withoutAuth);
    });
  });

  it("applies oauth pruning defaults", async () => {
    await withEnvAsync({ ANTHROPIC_API_KEY: "", ANTHROPIC_OAUTH_TOKEN: "" }, async () => {
      const next = applyContextPruningDefaults({
        auth: {
          profiles: {
            "anthropic:oauth": {
              provider: "anthropic",
              mode: "oauth",
              email: "me@example.com",
            },
          },
          order: {
            anthropic: ["anthropic:oauth"],
          },
        },
        agents: {
          defaults: {},
        },
      } as OpenClawConfig);

      expect(next.agents?.defaults?.contextPruning).toEqual({
        mode: "cache-ttl",
        ttl: "1h",
      });
      expect(next.agents?.defaults?.heartbeat?.every).toBe("1h");
    });
  });

  it("applies api-key pruning defaults and cache retention for Anthropic targets", async () => {
    await withEnvAsync({ ANTHROPIC_API_KEY: "", ANTHROPIC_OAUTH_TOKEN: "" }, async () => {
      const next = applyContextPruningDefaults({
        auth: {
          profiles: {
            "anthropic:api": {
              provider: "anthropic",
              mode: "api_key",
            },
          },
          order: {
            anthropic: ["anthropic:api"],
          },
        },
        agents: {
          defaults: {
            model: {
              primary: "sonnet",
            },
            models: {
              "anthropic/claude-opus-4-6": {},
              "amazon-bedrock/us.anthropic.claude-opus-4-6-v1": {},
              "openai/gpt-5.4": {},
            },
          },
        },
      } as OpenClawConfig);

      expect(next.agents?.defaults?.contextPruning).toEqual({
        mode: "cache-ttl",
        ttl: "1h",
      });
      expect(next.agents?.defaults?.heartbeat?.every).toBe("30m");
      expect(
        next.agents?.defaults?.models?.["anthropic/claude-opus-4-6"]?.params?.cacheRetention,
      ).toBe("short");
      expect(
        next.agents?.defaults?.models?.["amazon-bedrock/us.anthropic.claude-opus-4-6-v1"]?.params
          ?.cacheRetention,
      ).toBe("short");
      expect(
        next.agents?.defaults?.models?.["anthropic/claude-sonnet-4-6"]?.params?.cacheRetention,
      ).toBe("short");
      expect(next.agents?.defaults?.models?.["openai/gpt-5.4"]?.params?.cacheRetention).toBe(
        undefined,
      );
    });
  });

  it("defaults compaction mode when missing and preserves explicit modes", () => {
    const missingMode = applyCompactionDefaults({
      agents: {
        defaults: {
          compaction: {
            reserveTokensFloor: 9_000,
          },
        },
      },
    } as OpenClawConfig);
    const explicit: OpenClawConfig = {
      agents: {
        defaults: {
          compaction: {
            mode: "safeguard",
          },
        },
      },
    };

    expect(missingMode.agents?.defaults?.compaction?.mode).toBe("safeguard");
    expect(applyCompactionDefaults(explicit)).toBe(explicit);
  });
});
