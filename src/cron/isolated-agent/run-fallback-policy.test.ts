import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import { resolveCronFallbacksOverride } from "./run-fallback-policy.js";

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
  it("keeps configured fallbacks for cron payload model overrides", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: makeConfig(["openai/gpt-5.4", "google/gemini-3-pro"]),
        agentId: "main",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
          model: "google/gemini-2.0-flash",
        }),
      }),
    ).toEqual(["openai/gpt-5.4", "google/gemini-3-pro"]);
  });

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

  it("uses configured subagent model fallbacks for isolated agent turns", () => {
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
                  fallbacks: ["openai-codex/gpt-5.4", "zai/glm-5"],
                },
              },
            },
          },
        },
        agentId: "main",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toEqual(["openai-codex/gpt-5.4", "zai/glm-5"]);
  });

  it("treats string subagent model selection as strict when no fallbacks are configured", () => {
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
                model: "kimi/kimi-code",
              },
            },
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
                  fallbacks: ["openai-codex/gpt-5.4", "zai/glm-5"],
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

  it("leaves the default model path to the fallback runner when no payload model is set", () => {
    expect(
      resolveCronFallbacksOverride({
        cfg: makeConfig(["openai/gpt-5.4"]),
        agentId: "main",
        job: makeJob({
          kind: "agentTurn",
          message: "summarize",
        }),
      }),
    ).toBeUndefined();
  });
});
