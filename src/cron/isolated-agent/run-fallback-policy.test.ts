import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CronJob } from "../types.js";
import {
  prepareCronModelResolveInput,
  resolveCronFallbacksOverride,
  resolveCronPreflightCandidates,
} from "./run-fallback-policy.js";

it.each([undefined, "cron", "event"] as const)(
  "classifies model routing as %s only from the trusted caller, not the hook session key",
  async (trigger) => {
    const { modelResolve } = await prepareCronModelResolveInput({
      cwd: "/tmp/event-model-routing",
      prompt: "Synthetic immediate event",
      cronSession: { sessionEntry: {} },
      job: { id: "caller-classification" },
      trigger,
      runSessionKey: "agent:main:hook:caller-classification",
      resolvedDelivery: {},
      messageChannel: undefined,
    });

    expect(modelResolve.context?.trigger).toBe(trigger ?? "cron");
  },
);

function makeJob(
  payload: Partial<Extract<CronJob["payload"], { kind: "agentTurn" }>> = {},
): CronJob {
  return {
    id: "cron-fallback-policy",
    name: "Cron fallback policy",
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    payload: { kind: "agentTurn", message: "summarize", ...payload },
    state: {},
  } as CronJob;
}

function expectFallbacks(
  cfg: OpenClawConfig,
  options: Partial<Omit<Parameters<typeof resolveCronFallbacksOverride>[0], "cfg">> = {},
) {
  return expect(resolveCronFallbacksOverride({ cfg, agentId: "main", job: makeJob(), ...options }));
}

function subagentConfig(
  model: { primary?: string; fallbacks: string[] },
  options: { agentPrimary?: boolean; defaultFallbacks?: string[] } = {},
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        ...(!options.agentPrimary ? makeConfig(options.defaultFallbacks).agents?.defaults : {}),
        subagents: { model },
      },
      ...(options.agentPrimary
        ? { entries: { research: { model: { primary: "anthropic/claude-opus-4-6" } } } }
        : {}),
    },
  };
}

function makeConfig(fallbacks?: string[], primary = "anthropic/claude-opus-4-6"): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary,
          ...(fallbacks !== undefined ? { fallbacks } : {}),
        },
      },
    },
  };
}

describe("resolveCronFallbacksOverride", () => {
  it("returns an empty override for payload model overrides without configured fallbacks", () => {
    expectFallbacks(makeConfig(), {
      job: makeJob({ model: "google/gemini-2.0-flash" }),
    }).toStrictEqual([]);
  });

  it("lets payload fallbacks override the configured fallback policy", () => {
    expectFallbacks(makeConfig(["openai/gpt-5.4"]), {
      job: makeJob({ model: "google/gemini-2.0-flash", fallbacks: [] }),
    }).toStrictEqual([]);
  });

  it("uses default subagent fallbacks ahead of the agent primary", () => {
    expectFallbacks(
      subagentConfig(
        { primary: "kimi/kimi-code", fallbacks: ["openai/gpt-5.2"] },
        { agentPrimary: true },
      ),
      { agentId: "research", useSubagentFallbacks: true },
    ).toEqual(["openai/gpt-5.2"]);
  });

  it("keeps the agent primary strict when the default subagent model has no primary", () => {
    expectFallbacks(subagentConfig({ fallbacks: ["openai/gpt-5.2"] }, { agentPrimary: true }), {
      agentId: "research",
      useSubagentFallbacks: true,
    }).toStrictEqual([]);
  });

  it("keeps explicit empty subagent fallbacks as a fallback override", () => {
    expectFallbacks(
      subagentConfig(
        { primary: "kimi/kimi-code", fallbacks: [] },
        { defaultFallbacks: ["openai/gpt-5.4"] },
      ),
      { useSubagentFallbacks: true },
    ).toStrictEqual([]);
  });

  it("ignores subagent fallbacks when cron did not select the subagent model", () => {
    expectFallbacks(subagentConfig({ primary: "kimi/kimi-code", fallbacks: ["openai/gpt-5.2"] }), {
      useSubagentFallbacks: false,
    }).toBeUndefined();
  });

  it("inherits default fallbacks for cron runs when the agent model is a string", () => {
    expectFallbacks(
      {
        agents: {
          defaults: {
            model: {
              primary: "deepseek/deepseek-v4-pro",
              fallbacks: ["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"],
            },
          },
          entries: {
            main: {
              model: "deepseek/deepseek-v4-pro",
            },
          },
        },
      },
      {
        inheritDefaultFallbacksForAgentStringModel: true,
      },
    ).toEqual(["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"]);
  });

  it("keeps cron preflight strict when payload fallbacks are explicitly empty", () => {
    expect(
      resolveCronPreflightCandidates({
        cfg: makeConfig(["openai/gpt-5.4"]),
        agentId: "main",
        provider: "ollama",
        model: "qwen3:32b",
        job: makeJob({ fallbacks: [] }),
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

  it("plans the full configured candidate chain for cron preflight", () => {
    expect(
      resolveCronPreflightCandidates({
        cfg: makeConfig(
          ["openrouter/nvidia/nemotron-3-super-120b-a12b:free", "openai/gpt-5.4"],
          "ollama/qwen3:32b",
        ),
        agentId: "main",
        provider: "ollama",
        model: "qwen3:32b",
        job: makeJob(),
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
});
