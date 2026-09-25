import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";

const resolveModelAsync = vi.hoisted(() => vi.fn());
vi.mock("../agents/embedded-agent-runner/model.js", () => ({ resolveModelAsync }));
const { prepareDoctorToolSchemaFrames } = await import("./doctor-tool-schema-frames.js");

beforeEach(() => {
  resolveModelAsync.mockReset();
});
afterEach(() => clearPluginMetadataLifecycleCaches());

it("retains the selected alias's runtime metadata instead of normalizing it again", async () => {
  await withOpenClawTestState({}, async (state) => {
    const real = await vi.importActual<typeof import("../agents/embedded-agent-runner/model.js")>(
      "../agents/embedded-agent-runner/model.js",
    );
    const provider = "doctor-selected";
    const metadataSnapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        {
          id: provider,
          providers: [provider],
          modelIdNormalization: {
            providers: { [provider]: { aliases: { entry: "middle", middle: "final" } } },
          },
        },
      ],
    });
    const stores = real.createEmptyAgentDiscoveryStores();
    stores.modelRegistry.registerProvider(provider, {
      api: "openai-completions",
      baseUrl: "https://doctor-selected.example/v1",
      models: [
        {
          id: "middle",
          name: "middle",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 4096,
        },
        {
          id: "final",
          name: "final",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 4096,
          maxTokens: 4096,
        },
      ],
    });
    resolveModelAsync.mockImplementation(
      async (...args: Parameters<typeof real.resolveModelAsync>) =>
        real.resolveModelAsync(args[0], args[1], args[2], args[3], {
          ...args[4],
          ...stores,
          skipProviderRuntimeHooks: true,
        }),
    );
    const cfg: OpenClawConfig = { agents: { defaults: { model: `${provider}/entry` } } };
    const result = await withPluginRuntimeGenerationScope({ metadataSnapshot }, () =>
      prepareDoctorToolSchemaFrames(cfg, { mode: "doctor", env: state.env }),
    );
    expect(result.findings).toEqual([]);
    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]).toMatchObject({
      modelRef: { provider, model: "middle" },
      model: { id: "middle", api: "openai-completions", contextWindow: 32000 },
    });
  });
});

it("records deferred model preparation and continues with a healthy agent", async () => {
  await withOpenClawTestState({}, async (state) => {
    resolveModelAsync.mockImplementation(
      async (
        _provider: string,
        id: string,
        _dir: string,
        _cfg: OpenClawConfig,
        options: { deferProviderDynamicModelPreparation?: boolean },
      ) => {
        if (id === "deferred") {
          if (!options.deferProviderDynamicModelPreparation) {
            throw new Error("live provider preparation must not start");
          }
          return {
            error: "provider dynamic model preparation is deferred",
            deferred: "provider-dynamic-model",
          };
        }
        return {
          model: {
            id,
            name: id,
            provider: "fixture",
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:1/v1",
            contextWindow: 32000,
          },
        };
      },
    );
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "alpha" } },
        entries: {
          alpha: { workspace: state.path("alpha"), model: "fixture/deferred" },
          beta: { workspace: state.path("beta"), model: "fixture/available" },
        },
      },
    };
    const result = await prepareDoctorToolSchemaFrames(cfg, { mode: "doctor", env: state.env });
    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: "warning",
        path: "agents.alpha.model",
        requirement: "provider dynamic model preparation is deferred",
      }),
    ]);
    expect(result.frames.map((frame) => frame.agentId)).toEqual(["beta"]);
  });
});
