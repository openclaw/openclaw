import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { assert, describe, expect, it } from "vitest";
import { resolveRunWorkspaceDir } from "../agents/workspace-run.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildCatalogModel } from "../plugin-sdk/provider-catalog.test-support.js";
import { SYSTEM_AGENT_ID } from "./agent-id.js";
import {
  projectInferenceRoute,
  resolveSystemAgentConfiguredRouteFromConfig as resolveRoute,
} from "./inference-route.js";

const model = (id: string) => buildCatalogModel(id, { contextWindow: 8192, maxTokens: 2048 });
const workspaceAgent = (config: OpenClawConfig, agentId: string, workspaceDir?: string) =>
  resolveRunWorkspaceDir({ config, agentId, workspaceDir }).agentId;

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

describe("resolveSystemAgentConfiguredRouteFromConfig", () => {
  it("does not directly load completion execution to select a configured route", () => {
    const source = readFileSync(new URL("./inference-route.ts", import.meta.url), "utf8");
    expect(source).not.toContain("../agents/simple-completion-runtime.js");
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

  it("retires the first-run utility route without changing primary ownership", async () => {
    const config = utilityConfig("openai/gpt-5.5");
    const original = structuredClone(config);
    const primary = await resolveRoute(config);
    const utility = await resolveRoute(config, undefined, { modelTarget: "utility" });
    expect(primary).toMatchObject({ modelLabel: "openai/gpt-5.5", agentId: "dev" });
    expect(primary).not.toHaveProperty("modelTarget");
    expect(utility).toMatchObject({ modelTarget: "utility", modelLabel: "local-utility/tiny" });
    expect(utility?.agentDir).toBe(primary?.agentDir);
    expect(utility?.runConfig.agents?.defaults?.model).toBe("openai/gpt-5.5");
    expect(config).toEqual(original);
    await expectSameProjection(utilityConfig(), config, false);
  });

  it("does not reuse a primary verification for the same model selected as utility", async () => {
    const config = utilityConfig("local-utility/tiny");

    await expectSameProjection(config, config, false, undefined, "utility");
  });

  it("admits the requested owner and reserved agent in a multi-agent roster", async () => {
    const config = devConfig();
    config.agents!.entries!.main = {};
    const route = await resolveRoute(config, "dev");
    expect(route?.agentId).toBe("dev");
    for (const agentId of ["dev", SYSTEM_AGENT_ID]) {
      expect(workspaceAgent(route!.runConfig, agentId, "/tmp/x")).toBe(agentId);
    }
  });

  it("admits an uncreated owner only for an explicit primary preflight", async () => {
    const config = devConfig();
    const before = structuredClone(config);
    const agentId = "bot-uncreated";
    const ordinary = await resolveRoute(config, agentId);
    const candidate = await resolveRoute(config, agentId, { modelTarget: "primary" });
    assert(ordinary && candidate);
    expect(() => workspaceAgent(ordinary.runConfig, agentId)).toThrow(
      "not present in the configured roster",
    );
    expect(workspaceAgent(candidate.runConfig, agentId)).toBe(agentId);
    expect(candidate.sourceConfig).toBe(config);
    expect(config).toEqual(before);
  });

  it.each([undefined, "codex"])("preserves explicit harness policy (%s)", async (runtime) => {
    const route = await resolveRoute(devConfig(runtime));
    expect(route).toMatchObject({ runner: "embedded" });
    if (runtime) {
      expect(route).toHaveProperty("agentHarnessRuntimeOverride", runtime);
    } else {
      expect(route).not.toHaveProperty("agentHarnessRuntimeOverride");
    }
  });
});
