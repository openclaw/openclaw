// Tests reply thinking-catalog hydration for selected and automatic models.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  loadProviderScopedThinkingCatalog,
  readPreparedModelCatalog as loadModelCatalogLocal,
} from "../../agents/model-catalog.runtime.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { isThinkingLevelSupported } from "../thinking.js";
import { prepareModelSelectionRuntime } from "./model-runtime-normalization.js";
import { createInitialState, makeConfiguredModel } from "./model-selection.inputs.test-support.js";

vi.mock("../../agents/model-catalog.runtime.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: vi.fn(async () => []),
  loadPreparedModelCatalogSnapshot: vi.fn(async () => ({
    entries: [],
    routeVariants: [],
    authoritative: true,
  })),
}));

vi.mock("../../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

vi.mock("../../plugins/current-plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/current-plugin-metadata-snapshot.js")>()),
  getCurrentPluginMetadataSnapshot: () => createPluginMetadataSnapshotFixture(),
}));

vi.mock("../../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
}));

afterEach(() => {
  vi.mocked(loadProviderScopedThinkingCatalog).mockReset().mockResolvedValue([]);
});

describe("createModelSelectionState thinking catalog", () => {
  it.each([
    { previous: null, observed: "max", supported: true },
    { previous: "max", observed: null, supported: false },
  ])(
    "uses observed levels for reply thinking ($supported)",
    async ({ previous, observed, supported }) => {
      const stale = {
        provider: "fixture",
        id: "reasoner",
        name: "Reasoner",
        api: "openai-completions" as const,
        baseUrl: "https://fixture.invalid/v1",
        reasoning: true,
        thinkingLevelMap: { max: previous },
      };
      vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValue([
        { ...stale, thinkingLevelMap: { max: observed } },
      ]);
      const state = await createInitialState(
        { agents: { defaults: { model: "fixture/reasoner" } } },
        "fixture",
        "reasoner",
        { preparedModelCatalog: { entries: [stale], routeVariants: [] } },
      );
      expect(
        isThinkingLevelSupported({
          provider: "fixture",
          model: "reasoner",
          level: "max",
          catalog: await state.resolveThinkingCatalog(),
        }),
      ).toBe(supported);
    },
  );

  it.each([false, true])(
    "retains automatic-primary reasoning from prepared=%s metadata outside manual policy",
    async (prepared) => {
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
          defaults: {
            model: "fixture/automatic",
            modelPolicy: { allow: ["fixture/manual"] },
          },
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
      const state = await createInitialState(
        cfg,
        "fixture",
        "automatic",
        prepared
          ? { preparedModelCatalog: { entries: [automatic], routeVariants: [] } }
          : undefined,
      );
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
    },
  );

  it.each([
    { reasoning: undefined, agentRuntime: undefined },
    { reasoning: false, agentRuntime: "codex" },
  ])(
    "hydrates thinking for its runtime (reasoning=$reasoning, runtime=$agentRuntime)",
    async ({ reasoning, agentRuntime }) => {
      vi.mocked(loadModelCatalogLocal).mockClear();
      vi.mocked(loadProviderScopedThinkingCatalog).mockResolvedValue([
        { provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning: true },
      ]);
      const cfg = {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } },
            },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              models: [makeConfiguredModel({ reasoning: undefined })],
            },
          },
        },
      } as OpenClawConfig;

      const state = await createInitialState(cfg, "openai", "gpt-5.4", {
        preparedModelCatalog: agentRuntime
          ? {
              entries: [{ provider: "openai", id: "gpt-5.4", name: "GPT-5.4", reasoning }],
              routeVariants: [],
            }
          : undefined,
      });

      if (agentRuntime) {
        await state.resolveThinkingCatalog({
          provider: "openai",
          model: "gpt-5.4",
          agentRuntime: "openclaw",
        });
      }
      await expect(
        state.resolveDefaultThinkingLevel({ provider: "openai", model: "gpt-5.4", agentRuntime }),
      ).resolves.toBe("medium");
      expect(loadModelCatalogLocal).not.toHaveBeenCalled();
      expect(loadProviderScopedThinkingCatalog).toHaveBeenCalledWith({
        config: cfg,
        agentId: "main",
        provider: "openai",
        model: "gpt-5.4",
        agentRuntime: agentRuntime ?? "openclaw",
      });
    },
  );

  it("reloads embedded thinking metadata when clearing a native runtime pin", async () => {
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
});
