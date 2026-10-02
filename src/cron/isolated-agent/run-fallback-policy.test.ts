// Run fallback policy tests cover isolated agent fallback behavior after run failures.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import {
  resolveCronFallbacksOverride,
  resolveCronPreflightCandidates,
} from "./run-fallback-policy.js";

function makeJob(payload: CronJob["payload"]): CronJob {
  return {
    id: "cron-fallback-policy",
    name: "Cron fallback policy",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload,
    state: {},
  } as CronJob;
}

function makeConfig(fallbacks?: string[]): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary: "anthropic/claude-opus-4-6",
          ...(fallbacks !== undefined ? { fallbacks } : {}),
        },
      },
    },
  };
}

describe("resolveCronFallbacksOverride", () => {
  it("returns an empty override for payload model overrides without configured fallbacks", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: makeConfig(),
        agentId: "main",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
          model: "google/gemini-2.0-flash",
        }),
      }),
    ).toStrictEqual([]);
  });

  it("lets payload fallbacks override the configured fallback policy", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: makeConfig(["openai/gpt-5.4"]),
        agentId: "main",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
          model: "google/gemini-2.0-flash",
          fallbacks: [],
        }),
      }),
    ).toStrictEqual([]);
  });

  it("uses default subagent fallbacks ahead of the agent primary", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: {
          agents: {
            defaults: {
              subagents: {
                model: {
                  primary: "kimi/kimi-code",
                  fallbacks: ["openai/gpt-5.2"],
                },
              },
            },
            list: [
              {
                id: "research",
                model: {
                  primary: "anthropic/claude-opus-4-6",
                },
              },
            ],
          },
        },
        agentId: "research",
        useSubagentFallbacks: true,
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toEqual(["openai/gpt-5.2"]);
  });

  it("keeps the agent primary strict when the default subagent model has no primary", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: {
          agents: {
            defaults: {
              subagents: {
                model: {
                  fallbacks: ["openai/gpt-5.2"],
                },
              },
            },
            list: [
              {
                id: "research",
                model: {
                  primary: "anthropic/claude-opus-4-6",
                },
              },
            ],
          },
        },
        agentId: "research",
        useSubagentFallbacks: true,
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toStrictEqual([]);
  });

  it("keeps explicit empty subagent fallbacks as a fallback override", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-opus-4-6",
                fallbacks: ["openai/gpt-5.4"],
              },
              subagents: {
                model: {
                  primary: "kimi/kimi-code",
                  fallbacks: [],
                },
              },
            },
          },
        },
        agentId: "main",
        useSubagentFallbacks: true,
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toStrictEqual([]);
  });

  it("ignores subagent fallbacks when cron did not select the subagent model", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-opus-4-6",
              },
              subagents: {
                model: {
                  primary: "kimi/kimi-code",
                  fallbacks: ["openai/gpt-5.2"],
                },
              },
            },
          },
        },
        agentId: "main",
        useSubagentFallbacks: false,
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toBeUndefined();
  });

  it("inherits default fallbacks for cron runs when the agent model is a string", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "deepseek/deepseek-v4-pro",
                fallbacks: ["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"],
              },
            },
            list: [
              {
                id: "main",
                model: "deepseek/deepseek-v4-pro",
              },
            ],
          },
        },
        agentId: "main",
        inheritDefaultFallbacksForAgentStringModel: true,
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toEqual(["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"]);
  });

  it("does not infer inheritance from rewritten cron agent defaults", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-sonnet-4-6",
                fallbacks: ["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"],
              },
            },
            list: [
              {
                id: "main",
                model: "anthropic/claude-sonnet-4-6",
              },
            ],
          },
        },
        agentId: "main",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toStrictEqual([]);
  });

  it("keeps payload model overrides on the configured model fallback policy", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "anthropic/claude-opus-4-6",
                fallbacks: ["openai/gpt-5.4"],
              },
              subagents: {
                model: {
                  primary: "kimi/kimi-code",
                  fallbacks: ["openai/gpt-5.4", "zai/glm-5"],
                },
              },
            },
          },
        },
        agentId: "main",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
          model: "google/gemini-3-pro",
        }),
      }),
    ).toEqual(["openai/gpt-5.4"]);
  });

  it("plans the full configured candidate chain for cron preflight", () => {
    expect(
      resolveCronPreflightCandidates({
        cfg: {
          agents: {
            defaults: {
              model: {
                primary: "ollama/qwen3:32b",
                fallbacks: ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", "openai/gpt-5.4"],
              },
            },
          },
        },
        agentId: "main",
        provider: "ollama",
        model: "qwen3:32b",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toEqual([
      {
        provider: "ollama",
        model: "qwen3:32b",
        routeOrigin: "requested",
        routeResolution: "resolved",
      },
      {
        provider: "openrouter",
        model: "nvidia/nemotron-3-super-120b-a12b:free",
        routeOrigin: "configured-fallback",
        routeResolution: "resolved",
      },
      {
        provider: "openai",
        model: "gpt-5.4",
        routeOrigin: "configured-fallback",
        routeResolution: "resolved",
      },
    ]);
  });

  it("keeps cron preflight strict when payload fallbacks are explicitly empty", () => {
    expect(
      resolveCronPreflightCandidates({
        cfg: makeConfig(["openai/gpt-5.4"]),
        agentId: "main",
        provider: "ollama",
        model: "qwen3:32b",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
          fallbacks: [],
        }),
      }),
    ).toStrictEqual([
      {
        provider: "ollama",
        model: "qwen3:32b",
        routeOrigin: "requested",
        routeResolution: "resolved",
      },
    ]);
  });
});
