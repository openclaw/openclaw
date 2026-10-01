import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { clearAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import { selectAgentHarness } from "../agents/harness/selection.js";
import { resolveRunWorkspaceDir } from "../agents/workspace-run.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SYSTEM_AGENT_ID } from "./agent-id.js";
import {
  projectDefaultInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig,
  sameDefaultInferenceRoute,
} from "./inference-route.js";

function devConfig(agentRuntime?: string): OpenClawConfig {
  return {
    agents: {
      defaults: { model: "openai/gpt-5.5" },
      entries: {
        dev: { default: true, workspace: "/tmp/x" },
      },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          ...(agentRuntime ? { agentRuntime: { id: agentRuntime } } : {}),
          models: [
            {
              id: "gpt-5.5",
              name: "GPT-5.5",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128_000,
              maxTokens: 8_192,
            },
          ],
        },
      },
    },
  };
}

function utilityConfig(primary?: string): OpenClawConfig {
  const config = devConfig();
  return {
    ...config,
    meta: { migrations: { utilityModelSeparation: true } },
    agents: {
      ...config.agents,
      defaults: { ...(primary ? { model: primary } : {}), utilityModel: "local-utility/tiny" },
    },
    models: {
      providers: {
        ...config.models?.providers,
        "local-utility": {
          api: "openai-completions",
          baseUrl: "http://127.0.0.1:9999/v1",
          models: [
            {
              id: "tiny",
              name: "Local utility fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 8_192,
              maxTokens: 2_048,
            },
          ],
        },
      },
    },
  };
}

afterEach(() => {
  clearAgentHarnesses();
});

describe("resolveSystemAgentConfiguredRouteFromConfig", () => {
  it.each([false, true])(
    "retains a literal catalog @ suffix on a native implicit route (ACP=%s)",
    async (acp) => {
      const config = utilityConfig();
      const agent = config.agents?.entries?.dev;
      assert(agent);
      if (acp) {
        agent.model = "harness-only";
        agent.runtime = { type: "acp" };
      }
      delete config.meta;
      delete config.models?.providers?.openai;
      const provider = config.models?.providers?.["local-utility"];
      if (!provider?.models[0]) {
        throw new Error("Missing local utility fixture");
      }
      provider.models[0].id = "tiny@experimental";

      const route = await resolveSystemAgentConfiguredRouteFromConfig(config);

      expect(route).toMatchObject({
        provider: "local-utility",
        model: "tiny@experimental",
        modelLabel: "local-utility/tiny@experimental",
      });
      expect(route?.authProfileId).toBeUndefined();
      expect(route?.modelTarget).toBeUndefined();
    },
  );

  it("invalidates the inherited primary verification when only utility separation changes", async () => {
    const legacy = utilityConfig();
    legacy.meta = undefined;
    delete legacy.models?.providers?.openai;
    const separated: OpenClawConfig = {
      ...legacy,
      meta: { migrations: { utilityModelSeparation: true } },
    };

    const primary = await projectDefaultInferenceRoute(legacy);
    const utility = await projectDefaultInferenceRoute(separated);

    expect(primary.route).toMatchObject({ modelLabel: "local-utility/tiny", agentId: "dev" });
    expect(primary.route).not.toHaveProperty("modelTarget");
    expect(utility.route).toMatchObject({
      modelLabel: "local-utility/tiny",
      modelTarget: "utility",
    });
    expect(sameDefaultInferenceRoute(primary, utility)).toBe(false);
    expect(
      sameDefaultInferenceRoute(
        await projectDefaultInferenceRoute(legacy, { modelTarget: "utility" }),
        await projectDefaultInferenceRoute(separated, { modelTarget: "utility" }),
      ),
    ).toBe(true);
  });

  it("uses the explicit utility during first-run setup without manufacturing a primary", async () => {
    const config = utilityConfig();
    const original = structuredClone(config);

    const route = await resolveSystemAgentConfiguredRouteFromConfig(config);

    expect(route).toMatchObject({
      runner: "embedded",
      modelTarget: "utility",
      modelLabel: "local-utility/tiny",
      provider: "local-utility",
      model: "tiny",
      agentId: "dev",
      agentDir: resolveAgentDir(config, "dev"),
    });
    expect(route?.runConfig.agents?.defaults?.model).toBeUndefined();
    expect(config).toEqual(original);
  });

  it("verifies the utility role alongside a primary without moving the credential owner", async () => {
    const config = utilityConfig("openai/gpt-5.5");

    const primary = await resolveSystemAgentConfiguredRouteFromConfig(config);
    const utility = await resolveSystemAgentConfiguredRouteFromConfig(config, undefined, {
      modelTarget: "utility",
    });

    expect(primary).toMatchObject({ modelLabel: "openai/gpt-5.5", agentId: "dev" });
    expect(primary).not.toHaveProperty("modelTarget");
    expect(utility).toMatchObject({
      modelTarget: "utility",
      modelLabel: "local-utility/tiny",
      agentId: "dev",
      agentDir: primary?.agentDir,
    });
    expect(utility?.runConfig.agents?.defaults?.model).toBe("openai/gpt-5.5");
  });

  it.each(["defaults", "agent"] as const)(
    "invalidates utility verification after a %s utility change while preserving the primary route",
    async (scope) => {
      const before = utilityConfig("openai/gpt-5.5");
      const after: OpenClawConfig = {
        ...before,
        agents: {
          ...before.agents,
          defaults: {
            ...before.agents?.defaults,
            ...(scope === "defaults" ? { utilityModel: "local-utility/other" } : {}),
          },
          entries: {
            dev: {
              ...before.agents?.entries?.dev,
              ...(scope === "agent" ? { utilityModel: "local-utility/other" } : {}),
            },
          },
        },
      };

      expect(
        sameDefaultInferenceRoute(
          await projectDefaultInferenceRoute(before, { modelTarget: "utility" }),
          await projectDefaultInferenceRoute(after, { modelTarget: "utility" }),
        ),
      ).toBe(false);
      expect(
        sameDefaultInferenceRoute(
          await projectDefaultInferenceRoute(before),
          await projectDefaultInferenceRoute(after),
        ),
      ).toBe(true);
    },
  );

  it("retires the first-run utility route when a primary becomes configured", async () => {
    const utility = await projectDefaultInferenceRoute(utilityConfig());
    const primary = await projectDefaultInferenceRoute(utilityConfig("openai/gpt-5.5"));

    expect(utility.route).toMatchObject({ modelTarget: "utility", model: "tiny" });
    expect(primary.route).toMatchObject({ model: "gpt-5.5" });
    expect(primary.route).not.toHaveProperty("modelTarget");
    expect(sameDefaultInferenceRoute(utility, primary)).toBe(false);
  });

  it("does not reuse a primary verification for the same model selected as utility", async () => {
    const config = utilityConfig("local-utility/tiny");

    expect(
      sameDefaultInferenceRoute(
        await projectDefaultInferenceRoute(config),
        await projectDefaultInferenceRoute(config, { modelTarget: "utility" }),
      ),
    ).toBe(false);
  });

  it("treats a setup-materialized first-agent roster as inference-route neutral", async () => {
    const withoutRoster: OpenClawConfig = {
      agents: { defaults: { model: "openai/gpt-5.5" } },
    };
    const withFirstAgent: OpenClawConfig = {
      agents: {
        defaults: withoutRoster.agents?.defaults,
        entries: {
          main: {
            default: true,
            workspace: "/tmp/openclaw-main",
            agentDir: resolveAgentDir(withoutRoster, "main"),
          },
        },
      },
    };

    expect(
      sameDefaultInferenceRoute(
        await projectDefaultInferenceRoute(withoutRoster),
        await projectDefaultInferenceRoute(withFirstAgent),
      ),
    ).toBe(true);
  });

  it.each([
    { label: "main", agentIds: ["main"], owner: "main" },
    { label: "non-main", agentIds: ["dev"], owner: "dev" },
    { label: "multi-agent", agentIds: ["main", "dev"], owner: "dev" },
  ])(
    "admits the route owner and reserved agent for a $label roster",
    async ({ agentIds, owner }) => {
      const config = devConfig();
      config.agents = {
        ...config.agents,
        entries: Object.fromEntries(agentIds.map((id) => [id, {}])),
      };
      const route = await resolveSystemAgentConfiguredRouteFromConfig(config, owner);

      expect(route?.agentId).toBe(owner);
      for (const agentId of [owner, SYSTEM_AGENT_ID]) {
        expect(
          resolveRunWorkspaceDir({
            workspaceDir: "/tmp/x",
            agentId,
            config: route!.runConfig,
          }).agentId,
        ).toBe(agentId);
      }
    },
  );

  it("keeps implicit harness selection fallible while forcing explicit policy", async () => {
    const supports = vi.fn((ctx: { modelProvider?: { requestTransportOverrides?: string } }) =>
      ctx.modelProvider?.requestTransportOverrides === "present"
        ? { supported: false as const, reason: "authored request transport overrides" }
        : { supported: true as const, priority: 100 },
    );
    registerAgentHarness({
      id: "codex",
      label: "Codex",
      supports: supports as never,
      runAttempt: vi.fn() as never,
    });
    const preparedModelProvider = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      requestTransportOverrides: "present" as const,
    };

    const implicitRoute = await resolveSystemAgentConfiguredRouteFromConfig(devConfig());
    expect(implicitRoute).toMatchObject({ runner: "embedded" });
    expect(implicitRoute).not.toHaveProperty("agentHarnessRuntimeOverride");
    expect(
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProvider: preparedModelProvider,
        config: implicitRoute!.runConfig,
        agentHarnessRuntimeOverride:
          implicitRoute!.runner === "embedded"
            ? implicitRoute!.agentHarnessRuntimeOverride
            : undefined,
      }).id,
    ).toBe("openclaw");

    const explicitRoute = await resolveSystemAgentConfiguredRouteFromConfig(devConfig("codex"));
    expect(explicitRoute).toMatchObject({
      runner: "embedded",
      agentHarnessRuntimeOverride: "codex",
    });
    expect(() =>
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProvider: preparedModelProvider,
        config: explicitRoute!.runConfig,
        agentHarnessRuntimeOverride:
          explicitRoute!.runner === "embedded"
            ? explicitRoute!.agentHarnessRuntimeOverride
            : undefined,
      }),
    ).toThrow("authored request transport overrides");
  });
});
