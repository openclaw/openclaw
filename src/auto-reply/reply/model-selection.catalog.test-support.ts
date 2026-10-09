import { describe, expect, it, vi, type MockInstance } from "vitest";
import {
  loadProviderScopedThinkingCatalog,
  readPreparedModelCatalog as loadModelCatalogLocal,
} from "../../agents/model-catalog.runtime.js";
import type { ModelCatalogSnapshot } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import * as activeThinkingPolicy from "../../plugins/provider-thinking-active.js";
import { prepareModelCatalogThinkingPolicies } from "../../plugins/provider-thinking.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { isThinkingLevelSupported } from "../thinking.js";
import { prepareModelSelectionRuntime } from "./model-runtime-normalization.js";
import { createInitialState, makeConfiguredModel } from "./model-selection.inputs.test-support.js";
import { resolveContextTokens } from "./model-selection.js";

// Register under the caller's existing mocks and cleanup hooks, in the original suite order.
export function registerModelSelectionCatalogTests(catalogRuntimeMocks: {
  loadModelCatalogSnapshot: MockInstance;
}) {
  describe("catalog and thinking selection", () => {
    it("retains prepared automatic-primary reasoning outside manual policy", async () => {
      const automatic = {
        provider: "fixture",
        id: "automatic",
        name: "Automatic",
        api: "openai-completions" as const,
        baseUrl: "https://fixture.invalid/v1",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["xhigh"] },
      };
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { model: "fixture/automatic", modelPolicy: { allow: ["fixture/manual"] } },
        },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              baseUrl: "https://fixture.invalid/v1",
              models: [makeConfiguredModel({ id: "manual", name: "Manual", reasoning: false })],
            },
          },
        },
      };
      vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValue([automatic]);
      const state = await createInitialState(cfg, "fixture", "automatic", {
        preparedModelCatalog: { entries: [automatic], routeVariants: [] },
      });
      expect(state.modelPolicy.allows({ provider: "fixture", model: "automatic" })).toBe(false);
      expect(
        isThinkingLevelSupported({
          provider: "fixture",
          model: "automatic",
          level: "xhigh",
          catalog: await state.resolveThinkingCatalog(),
        }),
      ).toBe(true);
      await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
    });

    it("uses configured thinking without loading the full catalog", async () => {
      vi.mocked(loadModelCatalogLocal).mockClear();
      const cfg: OpenClawConfig = {
        agents: { defaults: { thinkingDefault: "low", models: { "openai/gpt-5.4": {} } } },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [makeConfiguredModel()],
            },
          },
        },
      };
      const state = await createInitialState(cfg, "openai", "gpt-5.4");
      expect(state.allowedModelKeys.has("openai/gpt-5.4")).toBe(true);
      await expect(state.resolveDefaultThinkingLevel()).resolves.toBe("low");
      await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("on");
      expect(loadModelCatalogLocal).not.toHaveBeenCalled();
    });

    it("hydrates thinking separately for embedded and native runtimes", async () => {
      vi.mocked(loadModelCatalogLocal).mockClear();
      vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([
        { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
      ]);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } } },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [makeConfiguredModel({ reasoning: undefined })],
            },
          },
        },
      };
      const state = await createInitialState(cfg, "openai", "gpt-5.4", {
        preparedModelCatalog: {
          entries: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: false }],
          routeVariants: [],
        },
      });
      await state.resolveThinkingCatalog({
        provider: "openai",
        model: "gpt-5.4",
        agentRuntime: "openclaw",
      });
      await expect(
        state.resolveDefaultThinkingLevel({
          provider: "openai",
          model: "gpt-5.4",
          agentRuntime: "codex",
        }),
      ).resolves.toBe("medium");
      expect(loadModelCatalogLocal).not.toHaveBeenCalled();
      expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledWith({
        config: cfg,
        agentId: "main",
        provider: "openai",
        model: "gpt-5.4",
        agentRuntime: "codex",
      });
    });

    it("reloads embedded metadata when clearing a native runtime pin", async () => {
      const embedded = {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        api: "openai-responses" as const,
        baseUrl: "https://api.openai.com/v1",
        reasoning: false,
      };
      const sessionEntry = { agentRuntimeOverride: "codex" };
      vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValueOnce([embedded]);
      const prepared = await prepareModelSelectionRuntime({
        cfg: {
          agents: {
            defaults: { models: { "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } } } },
          },
        },
        agentId: "main",
        provider: "openai",
        model: "gpt-5.4",
        rawRuntime: "default",
        sessionEntry,
        catalog: [{ ...embedded, nativeRuntime: "codex", reasoning: true }],
      });
      expect(prepared).toMatchObject({ status: "ready", runtime: { kind: "clear" } });
      if (prepared.status !== "ready") {
        throw new Error(prepared.message);
      }
      expect(prepared.catalog).toEqual([embedded]);
      expect(sessionEntry.agentRuntimeOverride).toBe("codex");
      expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ agentId: "main", agentRuntime: "openclaw" }),
      );
    });

    it("uses provider-specific prepared prompt budgets without an authored provider", async () => {
      vi.mocked(loadModelCatalogLocal).mockClear();
      catalogRuntimeMocks.loadModelCatalogSnapshot.mockClear();
      const entries = [
        {
          provider: "fixture-secondary",
          id: "shared-model",
          name: "Shared",
          reasoning: false,
          contextWindow: 1_050_000,
          contextTokens: 922_000,
        },
        {
          provider: "fixture-primary",
          id: "shared-model",
          name: "Shared",
          reasoning: false,
          contextWindow: 1_000_000,
          contextTokens: 872_000,
        },
      ];
      const cfg: OpenClawConfig = {
        agents: { defaults: { models: { "fixture-primary/shared-model": {} } } },
      };
      const state = await createInitialState(cfg, "fixture-primary", "shared-model", {
        preparedModelCatalog: { entries, routeVariants: entries, authoritative: true },
      });
      expect(
        resolveContextTokens({
          cfg,
          provider: state.provider,
          model: state.model,
          modelContextTokens: state.modelContextTokens,
          modelContextWindow: state.modelContextWindow,
        }),
      ).toBe(872_000);
      expect(await state.resolveThinkingCatalog()).toEqual(entries);
      expect(loadModelCatalogLocal).not.toHaveBeenCalled();
      expect(catalogRuntimeMocks.loadModelCatalogSnapshot).not.toHaveBeenCalled();
      expect(loadProviderScopedThinkingCatalog).not.toHaveBeenCalled();
    });

    it("preserves literal catalog identities despite a shared display key", async () => {
      const models = [
        makeConfiguredModel({ id: "m", contextWindow: 1_000_000 }),
        makeConfiguredModel({ id: "fixture/m", contextWindow: 64_000 }),
      ];
      const cfg: OpenClawConfig = {
        agents: { defaults: { modelPolicy: { allow: [] } } },
        models: {
          providers: {
            fixture: {
              api: "openai-responses",
              baseUrl: "https://models.example/v1",
              models,
            },
          },
        },
      };
      const entries = [{ provider: "unrelated", id: "other", name: "Other" }];
      const state = await createInitialState(cfg, "fixture", "fixture/m", {
        preparedModelCatalog: { entries, routeVariants: entries, authoritative: true },
      });
      expect(state.modelContextWindow).toBe(64_000);
      expect(state.allowedModelCatalog).toEqual([
        ...models.map(({ id, contextWindow }) =>
          expect.objectContaining({ provider: "fixture", id, contextWindow }),
        ),
        entries[0],
      ]);
      expect(
        resolveContextTokens({
          cfg,
          provider: state.provider,
          model: state.model,
          modelContextWindow: state.modelContextWindow,
          modelContextTokens: state.modelContextTokens,
        }),
      ).toBe(64_000);
    });

    it.each([
      { hasModelDirective: true, capturedPolicy: true, expected: "ultra", unrestricted: false },
      { hasModelDirective: false, capturedPolicy: false, expected: "medium", unrestricted: true },
    ])("keeps prepared thinking ownership (captured=$capturedPolicy)", async (fixture) => {
      const provider = "fixture-provider";
      const model = "fixture-model";
      const cfg: OpenClawConfig = {
        agents: fixture.unrestricted
          ? undefined
          : { defaults: { models: { [`${provider}/${model}`]: { alias: "Fixture" } } } },
        models: {
          providers: {
            [provider]: {
              baseUrl: "https://fixture.invalid/v1",
              models: [makeConfiguredModel({ id: model })],
            },
          },
        },
      };
      const preparedModelCatalog: ModelCatalogSnapshot = {
        entries: [{ provider, id: model, name: "Fixture", reasoning: true }],
        routeVariants: [],
      };
      prepareModelCatalogThinkingPolicies({
        catalog: preparedModelCatalog,
        metadataSnapshot: createPluginMetadataSnapshotFixture(),
        pluginRegistry: {
          ...createEmptyPluginRegistry(),
          providers: [
            {
              pluginId: provider,
              source: "test",
              provider: {
                id: provider,
                label: provider,
                auth: [],
                ...(fixture.capturedPolicy
                  ? {
                      resolveThinkingProfile: () => ({
                        levels: [{ id: "off" }, { id: "max" }, { id: "ultra" }],
                        defaultLevel: "ultra",
                      }),
                    }
                  : {}),
              },
            },
          ],
        },
      });
      const ambient = vi
        .spyOn(activeThinkingPolicy, "resolveActiveProviderThinkingProfile")
        .mockReturnValue({ levels: [{ id: "off" }], defaultLevel: "off" });
      try {
        const state = await createInitialState(cfg, provider, model, {
          hasModelDirective: fixture.hasModelDirective,
          preparedModelCatalog,
        });
        await expect(
          state.resolveDefaultThinkingLevel({ provider, model, agentRuntime: "codex" }),
        ).resolves.toBe(fixture.expected);
        expect(ambient).not.toHaveBeenCalled();
      } finally {
        ambient.mockRestore();
      }
    });

    it("uses configured compat for a custom route despite loaded catalog compat", async () => {
      vi.mocked(loadModelCatalogLocal).mockClear();
      vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([
        {
          provider: "vllm",
          id: "Qwen/Qwen3-8B",
          name: "Qwen3",
          reasoning: true,
          compat: { supportedReasoningEfforts: ["xhigh"] },
        },
      ]);
      const cfg: OpenClawConfig = {
        agents: { defaults: { models: { "vllm/Qwen/Qwen3-8B": {} } } },
        models: {
          providers: {
            vllm: {
              baseUrl: "http://localhost:9000/v1",
              models: [
                makeConfiguredModel({
                  id: "Qwen/Qwen3-8B",
                  name: "Qwen3",
                  compat: { thinkingFormat: "qwen-chat-template" },
                }),
              ],
            },
          },
        },
      };
      const state = await createInitialState(cfg, "vllm", "Qwen/Qwen3-8B", {
        hasModelDirective: true,
      });
      await expect(state.resolveThinkingCatalog()).resolves.toEqual([
        expect.objectContaining({
          provider: "vllm",
          id: "Qwen/Qwen3-8B",
          reasoning: true,
          compat: { thinkingFormat: "qwen-chat-template" },
        }),
      ]);
      expect(loadModelCatalogLocal).toHaveBeenCalledOnce();
    });

    it.each([
      ["anthropic", "claude-opus-4-5", "openai/*", "gpt-5.5-codex", 1],
      ["openai", "team/Reader", "openai/team/*", "team/Reader", 0],
    ] as const)(
      "selects %s/%s with wildcard %s",
      async (provider, model, allow, selected, loads) => {
        vi.mocked(loadModelCatalogLocal).mockClear();
        if (loads) {
          vi.mocked(loadModelCatalogLocal).mockResolvedValueOnce([
            { provider, id: model, name: "Primary" },
            { provider: "openai", id: selected, name: "Allowed" },
            { provider: "vllm", id: "qwen3-local", name: "Local" },
          ]);
        }
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              model: { primary: `${provider}/${model}` },
              models: { [allow]: {}, "vllm/*": {} },
            },
          },
        };
        const state = await createInitialState(cfg, provider, model);
        expect(state).toMatchObject({ provider: "openai", model: selected });
        expect(loadModelCatalogLocal).toHaveBeenCalledTimes(loads);
      },
    );

    it("returns reasoning off when no capability is published", async () => {
      const state = await createInitialState({}, "openai", "gpt-4o-mini");
      await expect(state.resolveDefaultReasoningLevel()).resolves.toBe("off");
    });
  });
}
