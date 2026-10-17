import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createNativeTypeScriptParser } from "../../scripts/lib/native-typescript.mts";
import { visitModuleSpecifiers } from "../../scripts/lib/ts-guard-utils.mts";
import { resolveAgentDir } from "../agents/agent-scope.js";
import { clearAgentHarnesses, registerAgentHarness } from "../agents/harness/registry.js";
import { selectAgentHarness } from "../agents/harness/selection.js";
import { resolveRunWorkspaceDir } from "../agents/workspace-run.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { SYSTEM_AGENT_ID } from "./agent-id.js";
import {
  projectInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig as resolveRoute,
  type SystemAgentConfiguredRoute,
} from "./inference-route.js";

function model(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 2_048,
  };
}

async function expectSameProjection(
  before: OpenClawConfig,
  after: OpenClawConfig,
  same: boolean,
  modelTarget?: "utility",
  afterTarget = modelTarget,
) {
  expect(
    isDeepStrictEqual(
      await projectInferenceRoute(before, undefined, { modelTarget }),
      await projectInferenceRoute(after, undefined, { modelTarget: afterTarget }),
    ),
  ).toBe(same);
}

function devConfig(agentRuntime?: string): OpenClawConfig {
  return {
    agents: {
      defaults: { model: "openai/gpt-5.5" },
      entries: { dev: { workspace: "/tmp/x" } },
    },
    models: {
      providers: {
        openai: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          ...(agentRuntime ? { agentRuntime: { id: agentRuntime } } : {}),
          models: [model("gpt-5.5")],
        },
      },
    },
  };
}

function utilityConfig(primary?: string): OpenClawConfig {
  const config = devConfig();
  config.meta = { migrations: { utilityModelSeparation: true } };
  config.agents!.defaults = {
    ...(primary ? { model: primary } : {}),
    utilityModel: "local-utility/tiny",
  };
  config.models!.providers!["local-utility"] = {
    api: "openai-completions",
    baseUrl: "http://127.0.0.1:9999/v1",
    models: [model("tiny")],
  };
  return config;
}

afterEach(clearAgentHarnesses);

describe("resolveSystemAgentConfiguredRouteFromConfig", () => {
  it("does not directly load completion execution to select a configured route", () => {
    const root = path.resolve(import.meta.dirname, "../..");
    const entry = path.join(root, "src/system-agent/inference-route.ts");
    using parser = createNativeTypeScriptParser({ cwd: root });
    const [source] = parser.parseSourceFiles([
      { fileName: entry, text: readFileSync(entry, "utf8") },
    ]);
    assert(source);
    const specifiers: string[] = [];
    visitModuleSpecifiers(source, ({ specifier }) => specifiers.push(specifier));
    expect(specifiers).not.toContain("../agents/simple-completion-runtime.js");
  });

  it.each([false, true])("preserves implicit catalog @ IDs (ACP=%s)", async (acp) => {
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
    assert(provider?.models[0]);
    provider.models[0].id = "tiny@experimental";

    const route = await resolveRoute(config);

    expect(route).toMatchObject({
      provider: "local-utility",
      model: "tiny@experimental",
      modelLabel: "local-utility/tiny@experimental",
    });
    expect(route?.authProfileId).toBeUndefined();
    expect(route?.modelTarget).toBeUndefined();
  });

  it("invalidates the inherited primary verification when only utility separation changes", async () => {
    const legacy = utilityConfig();
    legacy.meta = undefined;
    delete legacy.models?.providers?.openai;
    const separated: OpenClawConfig = {
      ...legacy,
      meta: { migrations: { utilityModelSeparation: true } },
    };

    const primary = await projectInferenceRoute(legacy);
    const utility = await projectInferenceRoute(separated);

    expect(primary.route).toMatchObject({ modelLabel: "local-utility/tiny", agentId: "dev" });
    expect(primary.route).not.toHaveProperty("modelTarget");
    expect(utility.route).toMatchObject({
      modelLabel: "local-utility/tiny",
      modelTarget: "utility",
    });
    expect(isDeepStrictEqual(primary, utility)).toBe(false);
    await expectSameProjection(legacy, separated, true, "utility");
  });

  it.each([undefined, "openai/gpt-5.5"])(
    "separates primary and utility ownership (%s)",
    async (primaryModel) => {
      const config = utilityConfig(primaryModel);
      const original = structuredClone(config);
      const primary = primaryModel ? await resolveRoute(config) : undefined;
      const utility = await resolveRoute(
        config,
        undefined,
        primaryModel ? { modelTarget: "utility" } : undefined,
      );

      if (primaryModel) {
        expect(primary).toMatchObject({ modelLabel: primaryModel, agentId: "dev" });
        expect(primary).not.toHaveProperty("modelTarget");
        expect(utility?.agentDir).toBe(primary?.agentDir);
      }
      expect(utility).toMatchObject({
        runner: "embedded",
        modelTarget: "utility",
        modelLabel: "local-utility/tiny",
        provider: "local-utility",
        model: "tiny",
        agentId: "dev",
        agentDir: resolveAgentDir(config, "dev"),
      });
      expect(utility?.runConfig.agents?.defaults?.model).toBe(primaryModel);
      expect(config).toEqual(original);
    },
  );

  it.each(["defaults", "agent"] as const)(
    "invalidates only the changed %s utility",
    async (scope) => {
      const before = utilityConfig("openai/gpt-5.5");
      const after = structuredClone(before);
      const target = scope === "defaults" ? after.agents?.defaults : after.agents?.entries?.dev;
      assert(target);
      target.utilityModel = "local-utility/other";
      await expectSameProjection(before, after, false, "utility");
      await expectSameProjection(before, after, true);
    },
  );

  it("retires the first-run utility route when a primary becomes configured", async () => {
    const utility = await projectInferenceRoute(utilityConfig());
    const primary = await projectInferenceRoute(utilityConfig("openai/gpt-5.5"));

    expect(utility.route).toMatchObject({ modelTarget: "utility", model: "tiny" });
    expect(primary.route).toMatchObject({ model: "gpt-5.5" });
    expect(primary.route).not.toHaveProperty("modelTarget");
    expect(isDeepStrictEqual(utility, primary)).toBe(false);
  });

  it("does not reuse a primary verification for the same model selected as utility", async () => {
    const config = utilityConfig("local-utility/tiny");

    await expectSameProjection(config, config, false, undefined, "utility");
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
            workspace: "/tmp/openclaw-main",
            agentDir: resolveAgentDir(withoutRoster, "main"),
          },
        },
      },
    };

    await expectSameProjection(withoutRoster, withFirstAgent, true);
  });

  it.each([
    { label: "main", agentIds: ["main"], owner: "main" },
    { label: "non-main", agentIds: ["dev"], owner: "dev" },
    { label: "multi-agent", agentIds: ["main", "dev"], owner: "dev" },
  ])("admits owner and reserved agent: $label", async ({ agentIds, owner }) => {
    const config = devConfig();
    config.agents!.entries = Object.fromEntries(agentIds.map((id) => [id, {}]));
    const route = await resolveRoute(config, owner);

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
  });

  it("admits an uncreated owner only for an explicit primary preflight", async () => {
    const config = devConfig();
    const before = structuredClone(config);
    const agentId = "bot-uncreated";
    const ordinary = await resolveRoute(config, agentId);
    const candidate = await resolveRoute(config, agentId, {
      modelTarget: "primary",
    });
    assert(ordinary && candidate);
    expect(() =>
      resolveRunWorkspaceDir({ workspaceDir: undefined, agentId, config: ordinary.runConfig }),
    ).toThrow("not present in the configured roster");
    expect(
      resolveRunWorkspaceDir({ workspaceDir: undefined, agentId, config: candidate.runConfig })
        .agentId,
    ).toBe(agentId);
    expect(candidate.sourceConfig).toBe(config);
    expect(config).toEqual(before);
  });

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
    const select = (route: SystemAgentConfiguredRoute | null) =>
      selectAgentHarness({
        provider: "openai",
        modelId: "gpt-5.5",
        modelProvider: preparedModelProvider,
        config: route!.runConfig,
        agentHarnessRuntimeOverride:
          route!.runner === "embedded" ? route!.agentHarnessRuntimeOverride : undefined,
      });

    const implicitRoute = await resolveRoute(devConfig());
    expect(implicitRoute).toMatchObject({ runner: "embedded" });
    expect(implicitRoute).not.toHaveProperty("agentHarnessRuntimeOverride");
    expect(select(implicitRoute).id).toBe("openclaw");

    const explicitRoute = await resolveRoute(devConfig("codex"));
    expect(explicitRoute).toMatchObject({
      runner: "embedded",
      agentHarnessRuntimeOverride: "codex",
    });
    expect(() => select(explicitRoute)).toThrow("authored request transport overrides");
  });
});
