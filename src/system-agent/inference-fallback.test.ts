import { afterEach, expect, it, vi } from "vitest";
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
const roster = (ids: string[]): OpenClawConfig => ({
  agents: { entries: Object.fromEntries(ids.map((id) => [id, {}])) },
});
type Options = {
  config?: OpenClawConfig;
  provider?: (agentId: string) => string;
  hasAuth?: typeof modelAuth.hasAvailableAuthForProvider;
  winner?: string;
  failure?: Extract<VerifySetupInferenceResult, { ok: false }>;
};
async function exercise(attempts: string[], options: Options = {}) {
  const observed: Array<string | undefined> = [];
  const provider = options.provider ?? ((id) => (id === "requester" ? "zeta" : id));
  vi.spyOn(inferenceRoute, "resolveSystemAgentConfiguredRouteFromConfig").mockImplementation(
    async (_config, agentId) => {
      if (!agentId) {
        throw new Error("missing fallback fixture owner identity");
      }
      return {
        runner: "embedded",
        agentHarnessRuntimeOverride: "openclaw",
        runConfig: {},
        sourceConfig: {},
        model: "model",
        modelLabel: `${provider(agentId)}/model`,
        provider: provider(agentId),
        agentId,
        agentDir: `/tmp/${agentId}`,
      } satisfies SystemAgentConfiguredRoute;
    },
  );
  vi.spyOn(modelAuth, "hasAvailableAuthForProvider").mockImplementation(
    options.hasAuth ?? (async () => true),
  );
  vi.spyOn(setupInference, "verifySetupInference").mockImplementation(async ({ agentId }) => {
    observed.push(agentId);
    return agentId === options.winner && agentId !== undefined
      ? ({ ok: true, modelRef: `${provider(agentId)}/model`, latencyMs: 1, binding: {} } as never)
      : (options.failure ?? unavailable);
  });
  const result = await verifySystemAgentInferenceWithFallback({
    requestingAgentId: "requester",
    runtime,
    config: options.config ?? roster(["requester", "beta", "alpha"]),
  });
  expect(observed).toEqual(attempts);
  expect(result.ok).toBe(options.winner !== undefined);
  return result;
}

it("does not claim providers are unconfigured when no route can be verified", async () => {
  vi.spyOn(inferenceRoute, "resolveSystemAgentConfiguredRouteFromConfig").mockResolvedValue(null);
  expect(await verifySystemAgentInferenceWithFallback({ runtime, config: {} })).toEqual({
    ok: false,
    status: "unknown",
    error: "OpenClaw could not verify a usable inference route. Check model setup and try again.",
  });
});

it.each<[string, string[], Options]>([
  ["requester then provider-id order", ["requester", "alpha", "beta"], { winner: "beta" }],
  [
    "implicit main before roster setup",
    ["requester", "main"],
    { config: {}, provider: (id) => id, winner: "main" },
  ],
  [
    "skip unauthenticated providers",
    ["requester", "beta"],
    { hasAuth: async ({ provider }) => provider !== "alpha" },
  ],
  [
    "later authenticated owner of one provider",
    ["requester", "alpha-good"],
    {
      config: roster(["requester", "alpha-bad", "alpha-good"]),
      provider: (id) => (id === "requester" ? "zeta" : "alpha"),
      hasAuth: async ({ agentDir }) => agentDir?.endsWith("alpha-good") === true,
      winner: "alpha-good",
    },
  ],
])("tries %s", async (_name, attempts, options) => {
  await exercise(attempts, options);
});

it.each([
  ["auth", "stale key", false, "alpha-other"],
  ["rate_limit", "429", false, "alpha-other"],
  ["format", "bad response", true, "alpha-other"],
  ["unavailable", "down", true, "beta"],
] as const)("retries %s at the correct owner scope", async (status, error, includeBeta, winner) => {
  await exercise(["requester", winner], {
    config: roster(["requester", "alpha-other", ...(includeBeta ? ["beta"] : [])]),
    provider: (id) => (id === "beta" ? "beta" : "alpha"),
    failure: { ok: false, status, error },
    winner,
  });
});

it("does not fail over on owner or identity uncertainty", async () => {
  const failure = { ok: false, status: "unknown", error: "winner identity uncertain" } as const;
  expect(await exercise(["requester"], { failure })).toEqual(failure);
});
