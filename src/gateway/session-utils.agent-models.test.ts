import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
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
      name: "legacy sole provider matching utility",
      cfg: {
        agents: {
          defaults: {
            utilityModel: "local-utility/small@local:utility",
            models: { "local-utility/small": { alias: "helper" } },
          },
          entries: {
            main: {},
            ops: {
              utilityModel: "worker-helper@local:ops",
              models: { "local-utility/small": { alias: "worker-helper" } },
            },
            disabled: { utilityModel: "" },
          },
        },
        models: {
          providers: {
            "local-utility": {
              baseUrl: "http://127.0.0.1:9/v1",
              models: [
                makeProviderModelFixture({
                  id: "small",
                  provider: "local-utility",
                  api: "openai-completions",
                  baseUrl: "http://127.0.0.1:9/v1",
                }),
              ],
            },
          },
        },
      },
      expected: [
        { id: "main", primary: "local-utility/small", utility: "local-utility/small" },
        { id: "ops", primary: "local-utility/small", utility: "local-utility/small" },
        { id: "disabled", primary: "local-utility/small" },
      ],
    },
    ...[
      [
        "custom/vertex-ai_claude-haiku-4-5@20251001@custom:setup-fake",
        "custom/vertex-ai_claude-haiku-4-5@20251001",
      ],
      ["lmstudio/gemma-4-31b-it@q8_0@lmstudio:setup-fake", "lmstudio/gemma-4-31b-it@q8_0"],
    ].map(([primary, expected]) => ({
      name: `model-owned suffix: ${primary}`,
      cfg: { agents: { defaults: { model: { primary } }, entries: { main: {} } } },
      expected: [{ id: "main", primary: expected }],
    })),
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
