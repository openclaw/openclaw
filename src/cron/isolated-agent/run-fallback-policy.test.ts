import { expect, it } from "vitest";
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

function makeConfig(
  fallbacks?: string[],
  primary = "anthropic/claude-opus-4-6",
  agentModel?: string,
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        model: {
          primary,
          ...(fallbacks !== undefined ? { fallbacks } : {}),
        },
      },
      ...(agentModel ? { entries: { main: { model: agentModel } } } : {}),
    },
  };
}

type FallbackCase = [
  name: string,
  cfg: OpenClawConfig,
  options: Partial<Omit<Parameters<typeof resolveCronFallbacksOverride>[0], "cfg">>,
  expected: string[] | undefined,
];
it.each<FallbackCase>([
  [
    "strict payload model",
    makeConfig(),
    { job: makeJob({ model: "google/gemini-2.0-flash" }) },
    [],
  ],
  [
    "explicit payload fallbacks",
    makeConfig(["openai/gpt-5.4"]),
    { job: makeJob({ model: "google/gemini-2.0-flash", fallbacks: [] }) },
    [],
  ],
  [
    "selected subagent",
    subagentConfig(
      { primary: "kimi/kimi-code", fallbacks: ["openai/gpt-5.2"] },
      { agentPrimary: true },
    ),
    { agentId: "research", useSubagentFallbacks: true },
    ["openai/gpt-5.2"],
  ],
  [
    "subagent without primary",
    subagentConfig({ fallbacks: ["openai/gpt-5.2"] }, { agentPrimary: true }),
    {
      agentId: "research",
      useSubagentFallbacks: true,
    },
    [],
  ],
  [
    "empty subagent fallbacks",
    subagentConfig(
      { primary: "kimi/kimi-code", fallbacks: [] },
      { defaultFallbacks: ["openai/gpt-5.4"] },
    ),
    { useSubagentFallbacks: true },
    [],
  ],
  [
    "unselected subagent",
    subagentConfig({ primary: "kimi/kimi-code", fallbacks: ["openai/gpt-5.2"] }),
    {
      useSubagentFallbacks: false,
    },
    undefined,
  ],
  [
    "string agent model",
    makeConfig(
      ["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"],
      "deepseek/deepseek-v4-pro",
      "deepseek/deepseek-v4-pro",
    ),
    { inheritDefaultFallbacksForAgentStringModel: true },
    ["deepseek/deepseek-v4-flash", "moonshot/kimi-k2.6"],
  ],
  [
    "user session selection",
    makeConfig(["fallback/model-b"]),
    { sessionModelOverrideSource: "user" },
    [],
  ],
  [
    "automatic session selection",
    makeConfig(["fallback/model-b"]),
    { sessionModelOverrideSource: "auto" },
    undefined,
  ],
  [
    "user session selection under a payload model",
    makeConfig(["fallback/model-b"]),
    { job: makeJob({ model: "jobmodel/model-d" }), sessionModelOverrideSource: "user" },
    ["fallback/model-b"],
  ],
  [
    "user session selection with explicit payload fallbacks",
    makeConfig(["fallback/model-b"]),
    {
      job: makeJob({ fallbacks: ["jobfallback/model-c"] }),
      sessionModelOverrideSource: "user",
    },
    ["jobfallback/model-c"],
  ],
])("resolves %s fallback policy", (_name, cfg, options, expected) => {
  expect(
    resolveCronFallbacksOverride({ cfg, agentId: "main", job: makeJob(), ...options }),
  ).toStrictEqual(expected);
});

it.each([
  ["payload fallbacks are explicitly empty", { job: makeJob({ fallbacks: [] }) }],
  ["a user session selection is pinned", { job: makeJob(), sessionModelOverrideSource: "user" }],
] as const)("keeps cron preflight strict when %s", (_name, options) => {
  expect(
    resolveCronPreflightCandidates({
      cfg: makeConfig(["openai/gpt-5.4"]),
      agentId: "main",
      provider: "ollama",
      model: "qwen3:32b",
      ...options,
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
