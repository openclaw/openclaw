import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { prepareOperatorModelPolicyPresentation } from "./operator-model-presentation.js";
import { listAgentsForGateway } from "./session-utils-store.js";
import { closeSessionSqliteDatabasesForTest } from "./session-utils.test-support.js";

const providerArtifactMocks = vi.hoisted(() => ({
  resolveBundledProviderPolicySurface: vi.fn<
    typeof import("../plugins/provider-public-artifacts.js").resolveBundledProviderPolicySurface
  >(() => null),
}));

vi.mock("../plugins/provider-public-artifacts.js", () => ({
  resolveBundledProviderPolicySurface: providerArtifactMocks.resolveBundledProviderPolicySurface,
  resolveProviderPolicySurface: providerArtifactMocks.resolveBundledProviderPolicySurface,
}));

beforeEach(() => {
  clearPluginMetadataLifecycleCaches();
  providerArtifactMocks.resolveBundledProviderPolicySurface.mockReset();
  providerArtifactMocks.resolveBundledProviderPolicySurface.mockReturnValue(null);
});

afterAll(closeSessionSqliteDatabasesForTest);

type ModelCase = {
  name: string;
  cfg: OpenClawConfig;
  expected: { id: string; primary?: string; utility?: string; fallbacks?: string[] }[];
  ready?: string;
};

describe("listAgentsForGateway model identity", () => {
  test.each<ModelCase>([
    {
      name: "canonical utility and primary readiness",
      cfg: {
        meta: { migrations: { utilityModelSeparation: true } },
        agents: {
          defaults: {
            utilityModel: "helper@local-utility:setup",
            models: { "local-utility/shared": { alias: "helper" } },
          },
          entries: {
            main: {},
            ops: {
              model: {
                primary: "openai/gpt-5.5@openai:primary",
                fallbacks: ["openai/gpt-5.4@openai:backup"],
              },
              utilityModel: "helper@local-utility:ops",
              models: { "local-utility/ops": { alias: "helper" } },
            },
            disabled: { utilityModel: "" },
          },
        },
      },
      expected: [
        { id: "main", utility: "local-utility/shared" },
        {
          id: "ops",
          primary: "openai/gpt-5.5",
          fallbacks: ["openai/gpt-5.4"],
          utility: "local-utility/ops",
        },
        { id: "disabled" },
      ],
      ready: "disabled",
    },
    {
      name: "model-owned suffix",
      cfg: {
        agents: {
          defaults: { model: { primary: "lmstudio/gemma-4-31b-it@q8_0@lmstudio:setup-fake" } },
          entries: { main: {} },
        },
      },
      expected: [{ id: "main", primary: "lmstudio/gemma-4-31b-it@q8_0" }],
    },
  ])("projects $name without mutating config", async ({ cfg, expected, ready }) => {
    const original = structuredClone(cfg);
    const { agents } = await listAgentsForGateway(cfg);
    for (const { id, primary, utility, fallbacks } of expected) {
      const agent = agents.find((row) => row.id === id);
      expect(agent?.utilityModel).toBe(utility);
      if (id === ready) {
        expect(agent?.model?.primary).toBeTruthy();
      } else {
        expect(agent?.model).toEqual({
          ...(primary ? { primary } : {}),
          ...(fallbacks ? { fallbacks } : {}),
        });
      }
    }
    expect(cfg).toEqual(original);
  });
});

describe("thinking level an agent override falls back to", () => {
  // Global Low, a shared per-model param of High, and coder's own Medium.
  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        model: "openai/gpt-5.5",
        thinkingDefault: "low",
        models: { "openai/gpt-5.5": { params: { thinking: "high" } } },
      },
      entries: { main: {}, coder: { thinkingDefault: "medium" } },
    },
  };

  test("is reported only for agents with their own thinkingDefault", async () => {
    const { agents } = await listAgentsForGateway(cfg);
    const row = (id: string) => agents.find((agent) => agent.id === id);
    // Clearing coder's override resolves the per-model param before the global default.
    expect(row("coder")).toMatchObject({
      thinkingDefault: "medium",
      thinkingInheritedDefault: "high",
    });
    expect(row("main")).toMatchObject({ thinkingDefault: "high" });
    expect(row("main")).not.toHaveProperty("thinkingInheritedDefault");
  });

  test("is dropped by a model-restricted roster, which reports the override as thinkingDefault", async () => {
    const { agents } = await listAgentsForGateway(cfg);
    const coder = agents.find((agent) => agent.id === "coder")!;
    // The policy permits the configured model; the projection still resolves its own defaults.
    const presentation = prepareOperatorModelPolicyPresentation({
      cfg,
      policy: { models: [], allows: () => true },
    })!;
    const projected = presentation.forAgent("coder").agent(coder);
    expect(projected).not.toHaveProperty("thinkingInheritedDefault");
    // The UI receives the override here, so it must not read it as the inherited level.
    expect(projected.thinkingDefault).toBe("medium");
  });
});
