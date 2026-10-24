import { afterEach, describe, expect, it, vi } from "vitest";
import * as modelAuth from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { verifySystemAgentInferenceWithFallback } from "./inference-fallback.js";
import * as inferenceRoute from "./inference-route.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import * as setupInference from "./setup-inference.js";
import type { VerifySetupInferenceResult } from "./setup-inference.js";

afterEach(() => vi.restoreAllMocks());
const runtime = {} as RuntimeEnv;
const unavailable = { ok: false, status: "unavailable", error: "down" } as const;
const success = (modelRef: string) => ({ ok: true, modelRef, latencyMs: 1, binding: {} }) as never;
const config: OpenClawConfig = {
  agents: {
    defaults: { model: { primary: "zeta/model" }, systemAgent: { agentId: "requester" } },
    entries: {
      requester: { model: "zeta/model" },
      beta: { model: "beta/model" },
      alpha: { model: "alpha/model" },
    },
  },
};
function roster(ids: string[], systemAgent?: { agentId: string }): OpenClawConfig {
  return {
    agents: {
      ...(systemAgent ? { defaults: { systemAgent } } : {}),
      entries: Object.fromEntries(ids.map((id) => [id, {}])),
    },
  };
}
function route(
  agentId: string | undefined,
  provider: string | undefined,
): SystemAgentConfiguredRoute {
  if (!agentId || !provider) {
    throw new Error("missing fallback fixture owner identity");
  }
  return {
    runner: "embedded",
    agentHarnessRuntimeOverride: "openclaw",
    runConfig: {},
    sourceConfig: {},
    modelLabel: `${provider}/model`,
    provider,
    model: "model",
    agentDir: `/tmp/${agentId}`,
    agentId,
  };
}
type Scenario = {
  name: string;
  config?: OpenClawConfig;
  provider?: (agentId: string | undefined) => string | undefined;
  hasAuth?: typeof modelAuth.hasAvailableAuthForProvider;
  winner?: string;
  failure?: Extract<VerifySetupInferenceResult, { ok: false }>;
  attempts: string[];
  checkSuccess?: boolean;
};
async function exercise(scenario: Scenario) {
  const attempts: Array<string | undefined> = [];
  const provider = scenario.provider ?? ((id) => (id === "requester" ? "zeta" : id));
  vi.spyOn(inferenceRoute, "resolveSystemAgentConfiguredRouteFromConfig").mockImplementation(
    async (_config, id) => route(id, provider(id)),
  );
  vi.spyOn(modelAuth, "hasAvailableAuthForProvider").mockImplementation(
    scenario.hasAuth ?? (async () => true),
  );
  const verify = vi
    .spyOn(setupInference, "verifySetupInference")
    .mockImplementation(async ({ agentId }) => {
      attempts.push(agentId);
      return agentId === scenario.winner && agentId !== undefined
        ? success(`${provider(agentId)}/model`)
        : (scenario.failure ?? unavailable);
    });
  const result = await verifySystemAgentInferenceWithFallback({
    requestingAgentId: "requester",
    runtime,
    config: scenario.config ?? config,
  });
  expect(attempts).toEqual(scenario.attempts);
  if (scenario.checkSuccess !== false) {
    expect(result.ok).toBe(true);
  }
  return { result, verify };
}

describe("system-agent inference fallback", () => {
  it("does not claim providers are unconfigured when no route can be verified", async () => {
    vi.spyOn(inferenceRoute, "resolveSystemAgentConfiguredRouteFromConfig").mockResolvedValue(null);
    expect(await verifySystemAgentInferenceWithFallback({ runtime, config: {} })).toEqual({
      ok: false,
      status: "unknown",
      error: "OpenClaw could not verify a usable inference route. Check model setup and try again.",
    });
  });
  it.each<Scenario>([
    {
      name: "tries the requester then providers in provider-id order",
      winner: "beta",
      attempts: ["requester", "alpha", "beta"],
    },
    {
      name: "retains implicit main for a pre-roster config",
      config: {},
      provider: (id) => id,
      winner: "main",
      attempts: ["requester", "main"],
    },
    {
      name: "skips unauthenticated providers",
      hasAuth: async ({ provider }) => provider !== "alpha",
      attempts: ["requester", "beta"],
      checkSuccess: false,
    },
    {
      name: "uses a later authenticated route for one provider",
      config: roster(["requester", "alpha-bad", "alpha-good"]),
      provider: (id) => (id === "requester" ? "zeta" : "alpha"),
      hasAuth: async ({ agentDir }) => agentDir?.endsWith("alpha-good") === true,
      winner: "alpha-good",
      attempts: ["requester", "alpha-good"],
    },
  ])("$name", async (scenario) => {
    await exercise(scenario);
  });
  it.each([
    ["auth", "stale key", false, "alpha-other"],
    ["rate_limit", "429", false, "alpha-other"],
    ["format", "bad response", true, "alpha-other"],
    ["unavailable", "down", true, "beta"],
  ] as const)(
    "retries %s at the correct owner scope",
    async (status, error, includeBeta, winner) => {
      await exercise({
        name: status,
        config: roster(["requester", "alpha-other", ...(includeBeta ? ["beta"] : [])]),
        provider: (id) => (id === "beta" ? "beta" : "alpha"),
        failure: { ok: false, status, error },
        winner,
        attempts: ["requester", winner],
      });
    },
  );
  it("does not fail over on owner or identity uncertainty", async () => {
    const failure = { ok: false, status: "unknown", error: "winner identity uncertain" } as const;
    const { result, verify } = await exercise({
      name: "unknown",
      failure,
      checkSuccess: false,
      config: roster(["requester", "beta", "alpha"], { agentId: "requester" }),
      attempts: ["requester"],
    });
    expect(result).toEqual(failure);
    expect(verify).toHaveBeenCalledOnce();
  });
});
