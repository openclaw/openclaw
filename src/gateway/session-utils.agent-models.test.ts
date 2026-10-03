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

describe("listAgentsForGateway model identity", () => {
  test("separates canonical utility availability from primary readiness", async () => {
    const cfg: OpenClawConfig = {
      meta: { migrations: { utilityModelSeparation: true } },
      agents: {
        defaults: {
          utilityModel: "helper@local-utility:setup",
          models: { "local-utility/shared": { alias: "helper" } },
        },
        entries: {
          main: { default: true },
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
    };
    const original = structuredClone(cfg);

    const { agents } = await listAgentsForGateway(cfg);
    const main = agents.find((agent) => agent.id === "main");
    const ops = agents.find((agent) => agent.id === "ops");
    const disabled = agents.find((agent) => agent.id === "disabled");

    expect(main?.utilityModel).toBe("local-utility/shared");
    expect(main?.model?.primary).toBeUndefined();
    expect(ops?.utilityModel).toBe("local-utility/ops");
    expect(ops?.model).toEqual({
      primary: "openai/gpt-5.5",
      fallbacks: ["openai/gpt-5.4"],
    });
    expect(disabled?.utilityModel).toBeUndefined();
    expect(disabled?.model?.primary).toBeTruthy();
    expect(cfg).toEqual(original);
  });

  test("preserves the legacy Gateway primary for a sole provider matching utility", async () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          utilityModel: "local-utility/small@local:utility",
          models: { "local-utility/small": { alias: "helper" } },
        },
        entries: {
          main: { default: true },
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
    };
    const original = structuredClone(cfg);
    const { agents } = await listAgentsForGateway(cfg);

    for (const id of ["main", "ops", "disabled"]) {
      expect(agents.find((agent) => agent.id === id)?.model?.primary).toBe("local-utility/small");
    }
    expect(agents.find((agent) => agent.id === "main")?.utilityModel).toBe("local-utility/small");
    expect(agents.find((agent) => agent.id === "ops")?.utilityModel).toBe("local-utility/small");
    expect(agents.find((agent) => agent.id === "disabled")?.utilityModel).toBeUndefined();
    expect(cfg).toEqual(original);
  });

  test.each([
    [
      "custom/vertex-ai_claude-haiku-4-5@20251001@custom:setup-fake",
      "custom/vertex-ai_claude-haiku-4-5@20251001",
    ],
    ["lmstudio/gemma-4-31b-it@q8_0@lmstudio:setup-fake", "lmstudio/gemma-4-31b-it@q8_0"],
  ])("listAgentsForGateway preserves model-owned @ suffixes in %s", async (primary, expected) => {
    const cfg = {
      agents: {
        defaults: { model: { primary } },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    expect((await listAgentsForGateway(cfg)).agents[0]?.model?.primary).toBe(expected);
  });
});
