import { describe, expect, it, onTestFinished, vi } from "vitest";
import * as modelAuth from "../agents/model-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { verifySystemAgentInferenceWithFallback } from "./inference-fallback.js";
import * as inferenceRoute from "./inference-route.js";
import type { SystemAgentConfiguredRoute } from "./inference-route.js";
import * as setupInference from "./setup-inference.js";
import type { VerifySetupInferenceResult } from "./setup-inference.js";

const runtime = {} as RuntimeEnv;
const config: OpenClawConfig = {
  agents: {
    defaults: {
      model: { primary: "zeta/model" },
      systemAgent: { agentId: "requester" },
    },
    entries: {
      requester: { model: "zeta/model" },
      beta: { model: "beta/model" },
      alpha: { model: "alpha/model" },
    },
  },
};
type FallbackFixture = {
  config: OpenClawConfig;
  resolveRoute?: typeof inferenceRoute.resolveSystemAgentConfiguredRouteFromConfig;
  hasAuth?: typeof modelAuth.hasAvailableAuthForProvider;
  verify?: (
    params: Parameters<typeof setupInference.verifySetupInference>[0],
  ) => Promise<VerifySetupInferenceResult>;
};

function mockFallback(fixture: FallbackFixture) {
  if (fixture.resolveRoute) {
    const resolveRoute = vi
      .spyOn(inferenceRoute, "resolveSystemAgentConfiguredRouteFromConfig")
      .mockImplementation(fixture.resolveRoute);
    onTestFinished(() => resolveRoute.mockRestore());
  }
  if (fixture.hasAuth) {
    const hasAuth = vi
      .spyOn(modelAuth, "hasAvailableAuthForProvider")
      .mockImplementation(fixture.hasAuth);
    onTestFinished(() => hasAuth.mockRestore());
  }
  if (fixture.verify) {
    const verify = vi
      .spyOn(setupInference, "verifySetupInference")
      .mockImplementation(fixture.verify);
    onTestFinished(() => verify.mockRestore());
  }
  return fixture.config;
}

const verifyConfigured = (fixture: FallbackFixture) =>
  verifySystemAgentInferenceWithFallback({
    requestingAgentId: "requester",
    runtime,
    config: mockFallback(fixture),
  });
const success = (modelRef: string) => ({ ok: true, modelRef, latencyMs: 1, binding: {} }) as never;

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

function fallbackConfig(agentIds: string[], systemAgent?: { agentId: string }): OpenClawConfig {
  return {
    agents: {
      ...(systemAgent ? { defaults: { systemAgent } } : {}),
      entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
    },
  };
}

async function verifyAfterFailure(
  failure: Extract<VerifySetupInferenceResult, { ok: false }>,
  includeBeta: boolean,
  successfulAgentId: "alpha-other" | "beta",
) {
  const attempts: Array<string | undefined> = [];
  const cfg = fallbackConfig(["requester", "alpha-other", ...(includeBeta ? ["beta"] : [])]);
  const result = await verifyConfigured({
    config: cfg,
    resolveRoute: async (_cfg, agentId) => route(agentId, agentId === "beta" ? "beta" : "alpha"),
    hasAuth: async () => true,
    verify: async ({ agentId }) => {
      attempts.push(agentId);
      return agentId === successfulAgentId
        ? success(agentId === "beta" ? "beta/model" : "alpha/model")
        : { ...failure };
    },
  });
  return { result, attempts };
}

describe("system-agent inference fallback", () => {
  it("does not claim providers are unconfigured when no route can be verified", async () => {
    const result = await verifySystemAgentInferenceWithFallback({
      runtime,
      config: mockFallback({
        config: {},
        resolveRoute: async () => null,
      }),
    });

    expect(result).toEqual({
      ok: false,
      status: "unknown",
      error: "OpenClaw could not verify a usable inference route. Check model setup and try again.",
    });
  });

  it("tries the system-agent route first, then authenticated providers by provider id", async () => {
    const attempts: Array<string | undefined> = [];
    const verify = vi.fn(async ({ agentId }: { agentId?: string }) => {
      attempts.push(agentId);
      return agentId === "beta"
        ? ({ ok: true, modelRef: "beta/model", latencyMs: 1, binding: {} } as never)
        : ({ ok: false, status: "unavailable", error: "down" } as const);
    });

    const result = await verifySystemAgentInferenceWithFallback({
      runtime,
      config: mockFallback({
        config,
        resolveRoute: async (_cfg, agentId) =>
          route(agentId, agentId === "requester" ? "zeta" : agentId),
        hasAuth: async () => true,
        verify,
      }),
    });

    expect(result.ok).toBe(true);
    expect(attempts).toEqual(["requester", "alpha", "beta"]);
  });

  it("retains the implicit main fallback for a pre-roster config", async () => {
    const attempts: Array<string | undefined> = [];
    const result = await verifySystemAgentInferenceWithFallback({
      requestingAgentId: "requester",
      runtime,
      config: mockFallback({
        config: {},
        resolveRoute: async (_cfg, agentId) => route(agentId, agentId),
        hasAuth: async () => true,
        verify: async ({ agentId }) => {
          attempts.push(agentId);
          return agentId === "main"
            ? ({ ok: true, modelRef: "main/model", latencyMs: 1, binding: {} } as never)
            : ({ ok: false, status: "unavailable", error: "down" } as const);
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(attempts).toEqual(["requester", "main"]);
  });

  it("skips unauthenticated fallback providers", async () => {
    const attempts: Array<string | undefined> = [];
    await verifySystemAgentInferenceWithFallback({
      requestingAgentId: "requester",
      runtime,
      config: mockFallback({
        config,
        resolveRoute: async (_cfg, agentId) =>
          route(agentId, agentId === "requester" ? "zeta" : agentId),
        hasAuth: async ({ provider }) => provider !== "alpha",
        verify: async ({ agentId }) => {
          attempts.push(agentId);
          return { ok: false, status: "unavailable", error: "down" };
        },
      }),
    });

    expect(attempts).toEqual(["requester", "beta"]);
  });

  it("uses a later authenticated route for one fallback provider", async () => {
    const attempts: Array<string | undefined> = [];
    const duplicateProviderConfig = fallbackConfig(["requester", "alpha-bad", "alpha-good"]);

    const result = await verifyConfigured({
      config: duplicateProviderConfig,
      resolveRoute: async (_cfg, agentId) =>
        route(agentId, agentId === "requester" ? "zeta" : "alpha"),
      hasAuth: async ({ agentDir }) => agentDir?.endsWith("alpha-good") === true,
      verify: async ({ agentId }) => {
        attempts.push(agentId);
        return agentId === "alpha-good"
          ? success("alpha/model")
          : ({ ok: false, status: "unavailable", error: "down" } as const);
      },
    });

    expect(result.ok).toBe(true);
    expect(attempts).toEqual(["requester", "alpha-good"]);
  });

  it.each([
    ["auth", "stale key", false, "alpha-other"],
    ["rate_limit", "429", false, "alpha-other"],
    ["format", "bad response", true, "alpha-other"],
    ["unavailable", "down", true, "beta"],
  ] as const)(
    "retries %s at the correct owner scope",
    async (status, error, includeBeta, successfulAgentId) => {
      const { result, attempts } = await verifyAfterFailure(
        { ok: false, status, error },
        includeBeta,
        successfulAgentId,
      );
      expect(result.ok).toBe(true);
      expect(attempts).toEqual(["requester", successfulAgentId]);
    },
  );

  it("does not fail over on owner or identity uncertainty", async () => {
    const verify = vi.fn(
      async () => ({ ok: false, status: "unknown", error: "winner identity uncertain" }) as const,
    );

    const result = await verifyConfigured({
      config: fallbackConfig(["requester", "beta", "alpha"], { agentId: "requester" }),
      resolveRoute: async (_cfg, agentId) =>
        route(agentId, agentId === "requester" ? "zeta" : agentId),
      hasAuth: async () => true,
      verify,
    });

    expect(result).toEqual({
      ok: false,
      status: "unknown",
      error: "winner identity uncertain",
    });
    expect(verify).toHaveBeenCalledOnce();
  });
});
