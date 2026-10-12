import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDoctorPluginMetadataSnapshotScope } from "../commands/doctor/shared/plugin-metadata-snapshot-scope.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginCache, getPluginCache, withPluginCache } from "../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
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

it.each([
  { agents: 200, providers: ["doctor-shared"], reenter: false },
  { agents: 2, providers: ["doctor-alpha", "doctor-beta"], reenter: false },
  { agents: 2, providers: ["doctor-shared"], reenter: true },
])(
  "bounds provider registrations and config captures for $agents agents (reentry: $reenter)",
  async ({ agents, providers, reenter }) => {
    await withOpenClawTestState(
      { env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" } },
      async (state) => {
        const real = await vi.importActual<
          typeof import("../agents/embedded-agent-runner/model.js")
        >("../agents/embedded-agent-runner/model.js");
        const stores = real.createEmptyAgentDiscoveryStores();
        const { resolveProviderRuntimePlugin } =
          await import("../plugins/provider-hook-runtime.js");
        const event = `doctor-frame-registration:${state.root}`;
        const registrations = new Map<string, number>();
        const onRegistration = (provider: string, config: OpenClawConfig) => {
          registrations.set(provider, (registrations.get(provider) ?? 0) + 1);
          if (reenter) {
            resolveProviderRuntimePlugin({
              provider,
              config,
              workspaceDir: state.path("workspace0"),
              env: state.env,
            });
          }
        };
        const paths: string[] = [];
        for (const provider of providers) {
          paths.push(
            await state.writeText(
              `plugins/${provider}/index.cjs`,
              `module.exports = { id: ${JSON.stringify(provider)}, register(api) {
              process.emit(${JSON.stringify(event)}, ${JSON.stringify(provider)}, api.config);
              api.registerProvider({ id: ${JSON.stringify(provider)}, label: "Doctor fixture", auth: [],
                normalizeResolvedModel: ({ model, workspaceDir }) => ({
                  ...model, name: ${JSON.stringify(provider)} + ":" + workspaceDir,
                  contextWindow: 64000
                }) });
            } };`,
            ),
          );
          await state.writeJson(`plugins/${provider}/openclaw.plugin.json`, {
            id: provider,
            providers: [provider],
            configSchema: { type: "object", additionalProperties: false },
          });
          stores.modelRegistry.registerProvider(provider, {
            api: "openai-completions",
            baseUrl: "https://doctor-fixture.example/v1",
            models: [
              {
                id: "selected",
                name: "selected",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 32000,
                maxTokens: 4096,
              },
            ],
          });
        }
        const cfg = captureRuntimeConfig({
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "agent0" } },
            entries: Object.fromEntries(
              Array.from({ length: agents }, (_, index) => [
                `agent${index}`,
                {
                  workspace: state.path(`workspace${index}`),
                  model: `${providers[index % providers.length]}/selected`,
                },
              ]),
            ),
          },
          plugins: { allow: providers, load: { paths }, slots: { memory: "none" } },
        });
        let peakRetainedInstances = 0;
        resolveModelAsync.mockImplementation(
          async (...args: Parameters<typeof real.resolveModelAsync>) => {
            const result = await real.resolveModelAsync(args[0], args[1], args[2], args[3], {
              ...args[4],
              ...stores,
            });
            peakRetainedInstances = Math.max(
              peakRetainedInstances,
              getPluginCache().instances.size,
            );
            return result;
          },
        );
        await using cache = createPluginCache();
        await withPluginCache(cache, async () => {
          await using scope = createDoctorPluginMetadataSnapshotScope({
            baseSnapshot: loadPluginMetadataSnapshot({ config: cfg, env: state.env }),
            env: state.env,
          });
          let captures = 0;
          const clone = globalThis.structuredClone;
          // A spy would retain every clone argument and reproduce the leak in the test itself.
          globalThis.structuredClone = (value, options) => {
            if (value && typeof value === "object" && Object.hasOwn(value, "agents")) {
              captures++;
            }
            return clone(value, options);
          };
          process.on(event, onRegistration);
          try {
            const result = await prepareDoctorToolSchemaFrames(cfg, {
              mode: "doctor",
              env: state.env,
              runWithPluginMetadataSnapshot: scope.run,
            });
            expect(result.findings).toEqual([]);
            expect(result.frames).toHaveLength(agents);
            for (const frame of result.frames) {
              expect(frame.model).toMatchObject({
                name: `${frame.modelRef.provider}:${frame.workspaceDir}`,
                contextWindow: 64000,
              });
            }
            expect([...registrations.keys()].toSorted()).toEqual([...providers].toSorted());
            expect([...registrations.values()]).toEqual(providers.map(() => 1));
            expect(peakRetainedInstances).toBe(providers.length);
            expect(captures).toBeLessThanOrEqual(providers.length * 2);
          } finally {
            globalThis.structuredClone = clone;
            process.off(event, onRegistration);
          }
        });
      },
    );
  },
);

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
