import { afterEach, describe, expect, it, vi } from "vitest";
import { dualRoutes } from "../agents/model-auth-availability.test-support.js";
import { createModelRuntimeChoiceOwnerFixture } from "../agents/model-runtime-choice.test-support.js";
import * as openaiRoutes from "../agents/openai-model-routes.js";
import { bindPreparedModelRuntimeAuth } from "../agents/prepared-model-runtime-auth.js";
import type { PreparedModelRuntimeSnapshot } from "../agents/prepared-model-runtime.types.js";
import { resolveEffectiveAgentRuntime } from "../agents/thinking-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../state/openclaw-agent-db.js";
import { createStatusModelResolver } from "../status/status-model-auth.js";
import { getStatusSummary } from "../status/summary.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { sessionsCommand } from "./sessions.js";
import {
  cleanupStore,
  resetMockSessionsConfig,
  runSessionsJson,
  setMockSessionsConfig,
  writeStore,
} from "./sessions.test-helpers.js";

const prepared = vi.hoisted(() => ({
  owner: undefined as PreparedModelRuntimeSnapshot | undefined,
}));
// mock-isolation: Passive reads borrow this admitted fixture generation without discovery.
vi.mock("../agents/prepared-model-catalog.js", () => ({
  getPublishedPreparedModelCatalogOwnerSnapshot: () => prepared.owner,
}));

const entry = {
  sessionId: "synthetic-owner-budget",
  updatedAt: 1,
  modelProvider: "openai",
  model: "gpt-5.4-mini",
  agentHarnessId: "openclaw",
  contextTokens: 128_000,
  contextTokensSource: "synthetic" as const,
};
const config = { agents: { defaults: { model: "openai/gpt-5.4-mini" } } };

afterEach(async () => {
  resetPluginRuntimeStateForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetMockSessionsConfig();
  prepared.owner = undefined;
  await closeStateDatabaseForTest();
});

describe("passive session context owner", () => {
  it.each(["auto", "openclaw"])(
    "resolves %s policy to the effective sessions capacity owner",
    async (runtime) => {
      const provider = "anthropic";
      const model = "claude-opus-5";
      setMockSessionsConfig(() => ({
        agents: { defaults: { model: `${provider}/${model}` } },
      }));
      const store = await writeStore({
        "agent:main:main": {
          sessionId: "automatic-capacity-owner",
          updatedAt: 1,
          ...(runtime === "openclaw" ? { agentHarnessId: runtime } : {}),
          modelProvider: provider,
          model,
        },
      });
      const result = await runSessionsJson<{
        sessions: Array<{ contextTokens: number; agentRuntime: { id: string } }>;
      }>(sessionsCommand, store);
      expect(result.sessions[0]?.agentRuntime.id).toBe(runtime);
      expect(result.sessions[0]?.contextTokens).toBe(1_000_000);
    },
  );

  it.each([
    { authored: 200_000, synthetic: true, expected: 200_000 },
    { authored: 64_000, synthetic: true, expected: 64_000 },
    { authored: 200_000, synthetic: false, expected: 128_000 },
  ])(
    "projects authored $authored with current owner synthetic=$synthetic",
    async ({ authored, synthetic, expected }) => {
      const provider = "openai";
      const model = "fixture-model";
      const route = {
        provider,
        id: model,
        name: "Fixture model",
        api: "openai-responses" as const,
        baseUrl: "https://api.openai.com/v1",
        contextWindow: 128_000,
        ...(synthetic ? { contextWindowSource: "synthetic" as const } : {}),
      };
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: `${provider}/${model}` } },
        models: {
          providers: {
            [provider]: {
              api: route.api,
              baseUrl: route.baseUrl,
              models: [
                {
                  id: model,
                  name: route.name,
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextTokens: authored,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
      };
      prepared.owner = createModelRuntimeChoiceOwnerFixture(cfg, () => true, {
        modelCatalog: {
          entries: [route],
          routeVariants: [route],
          providerOutcomes: [{ provider, profileId: "openai:fixture", status: "ready" }],
        },
      });
      bindPreparedModelRuntimeAuth(prepared.owner, {
        store: {
          version: 1,
          profiles: {
            "openai:fixture": { type: "api_key", provider, key: "synthetic-fixture-key" },
          },
        },
      });
      vi.stubEnv("OPENAI_API_KEY", undefined);
      vi.spyOn(openaiRoutes, "resolveOpenAIModelRoutes").mockReturnValue(dualRoutes);
      setMockSessionsConfig(() => cfg);
      const saved = {
        ...entry,
        modelProvider: provider,
        model,
        agentRuntimeOverride: "openclaw",
        authProfileOverride: "openai:fixture",
        authProfileOverrideSource: "user" as const,
      };
      expect(
        resolveEffectiveAgentRuntime({
          cfg,
          provider,
          modelId: model,
          agentId: "main",
          sessionEntry: saved,
        }),
      ).toBe("openclaw");
      const store = await writeStore({ "agent:main:main": saved });
      try {
        const summary = await getStatusSummary({
          includeChannelSummary: false,
          config: { ...cfg, session: { store } },
        });
        expect(summary.sessions.recent[0]?.contextTokens).toBe(expected);
      } finally {
        await closeOpenClawAgentDatabaseByPathAsync(store);
        cleanupStore(store);
      }
    },
  );

  it.each([
    {
      name: "ready matching native inventory",
      catalogRuntime: "codex",
      current: true,
      expected: 272_000,
    },
    {
      name: "mismatched native inventory",
      catalogRuntime: "another-native",
      current: true,
      expected: null,
    },
    { name: "retired native owner", catalogRuntime: "codex", current: false, expected: null },
  ])(
    "projects saved Synthetic context through $name without a host route",
    async ({ catalogRuntime, current, expected }) => {
      const provider = "openai";
      const model = "gpt-5.4";
      const cfg: OpenClawConfig = {
        plugins: { entries: { codex: { enabled: true } } },
        agents: {
          defaults: {
            model: `${provider}/${model}`,
            models: { [`${provider}/${model}`]: { agentRuntime: { id: "codex" } } },
          },
        },
      };
      const native = {
        provider,
        id: model,
        name: "Native fixture",
        nativeRuntime: catalogRuntime,
        contextTokens: 272_000,
      };
      const pluginRegistry = createEmptyPluginRegistry();
      pluginRegistry.agentHarnesses.push({
        pluginId: "codex",
        source: "test",
        harness: {
          id: "codex",
          label: "Codex",
          authBootstrap: "harness",
          supports: () => ({ supported: true }),
          readModelCatalogReadiness: () => ({ accountType: "chatgpt", authMode: "oauth" }),
          runAttempt: async () => {
            throw new Error("Passive status must not execute a model");
          },
        },
      });
      const workspaceDir = "/tmp/runtime-choice";
      prepared.owner = createModelRuntimeChoiceOwnerFixture(cfg, () => current, {
        workspaceDir,
        pluginRegistry,
        metadataSnapshot: createPluginMetadataSnapshotFixture({
          plugins: [{ id: "codex", providers: ["codex"], syntheticAuthRefs: ["codex"] }],
        }),
        modelCatalog: { entries: [native], routeVariants: [native] },
      });
      bindPreparedModelRuntimeAuth(prepared.owner, { store: { version: 1, profiles: {} } });
      vi.stubEnv("OPENAI_API_KEY", undefined);
      vi.spyOn(openaiRoutes, "resolveOpenAIModelRoutes").mockReturnValue(dualRoutes);
      const saved = { ...entry, model, agentHarnessId: "codex", agentRuntimeOverride: "codex" };
      const runtimeId = resolveEffectiveAgentRuntime({
        cfg,
        provider,
        modelId: model,
        agentId: "main",
        sessionEntry: saved,
      });
      expect(runtimeId).toBe("codex");
      const resolution = await createStatusModelResolver({
        cfg,
        agentId: "main",
        agentDir: prepared.owner.agentDir,
        workspaceDir,
        sessionEntry: saved,
        owner: prepared.owner,
      })({ provider, model, runtimeId, acceptedProviderIds: [] });
      expect(resolution.endpoint).toBeUndefined();
      if (current) {
        expect(resolution.authLabel).toBe("oauth (codex)");
      }
      const store = await writeStore({ "agent:main:main": saved });
      try {
        const summary = await getStatusSummary({
          includeChannelSummary: false,
          config: { ...cfg, session: { store } },
        });
        expect(summary.sessions.recent[0]?.contextTokens).toBe(expected);
      } finally {
        await closeOpenClawAgentDatabaseByPathAsync(store);
        cleanupStore(store);
      }
    },
  );

  it.each([
    {
      name: "native execution without native inventory",
      runtimeId: "codex",
      native: false,
      expected: null,
    },
    {
      name: "native execution with matching native inventory",
      runtimeId: "codex",
      native: true,
      expected: 272_000,
    },
    {
      name: "host execution with API inventory",
      runtimeId: "openclaw",
      native: false,
      expected: 1_000_000,
    },
  ])("projects $name with a selected host API account", async ({ runtimeId, native, expected }) => {
    const provider = "openai";
    const model = "fixture-model";
    const profileId = "openai:fixture";
    const workspaceDir = "/tmp/runtime-choice";
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: `${provider}/${model}`,
          models: { [`${provider}/${model}`]: { agentRuntime: { id: runtimeId } } },
        },
      },
    };
    const api = {
      provider,
      id: model,
      name: "API fixture",
      api: "openai-responses" as const,
      baseUrl: "https://api.openai.com/v1",
      contextWindow: 1_000_000,
    };
    const rows = native
      ? [api, { ...api, name: "Native fixture", nativeRuntime: "codex", contextTokens: 272_000 }]
      : [api];
    prepared.owner = createModelRuntimeChoiceOwnerFixture(cfg, () => true, {
      workspaceDir,
      modelCatalog: {
        entries: [api],
        routeVariants: rows,
        providerOutcomes: [{ provider, profileId, status: "ready" }],
      },
    });
    bindPreparedModelRuntimeAuth(prepared.owner, {
      store: {
        version: 1,
        profiles: { [profileId]: { type: "api_key", provider, key: "synthetic-fixture-key" } },
      },
    });
    vi.stubEnv("OPENAI_API_KEY", undefined);
    vi.spyOn(openaiRoutes, "resolveOpenAIModelRoutes").mockReturnValue(dualRoutes);
    const saved = {
      ...entry,
      model,
      agentHarnessId: runtimeId,
      agentRuntimeOverride: runtimeId,
      authProfileOverride: profileId,
      authProfileOverrideSource: "user" as const,
    };
    expect(
      resolveEffectiveAgentRuntime({
        cfg,
        provider,
        modelId: model,
        agentId: "main",
        sessionEntry: saved,
      }),
    ).toBe(runtimeId);
    const resolution = await createStatusModelResolver({
      cfg,
      agentId: "main",
      agentDir: prepared.owner.agentDir,
      workspaceDir,
      sessionEntry: saved,
      owner: prepared.owner,
    })({ provider, model, runtimeId, acceptedProviderIds: [] });
    expect(resolution.endpoint).toBe("https://api.openai.com/v1");
    expect(resolution.authLabel).toContain("api-key");
    const store = await writeStore({ "agent:main:main": saved });
    try {
      const summary = await getStatusSummary({
        includeChannelSummary: false,
        config: { ...cfg, session: { store } },
      });
      expect(summary.sessions.recent[0]?.contextTokens).toBe(expected);
    } finally {
      await closeOpenClawAgentDatabaseByPathAsync(store);
      cleanupStore(store);
    }
  });

  it.each([
    {
      name: "reported fixed prompt beside an unselected scalar window",
      prompt: 1_000_000,
      selected: undefined,
      expected: 1_000_000,
    },
    {
      name: "smaller reported prompt beside an unselected scalar window",
      prompt: 64_000,
      selected: undefined,
      expected: 64_000,
    },
    {
      name: "reported fixed prompt with a declared selected window",
      prompt: 1_000_000,
      selected: "small",
      expected: 200_000,
    },
  ])("recovers Synthetic saved context from $name", async ({ prompt, selected, expected }) => {
    const provider = "anthropic";
    const model = "claude-opus-5";
    const runtimeId = "claude-cli";
    const workspaceDir = "/tmp/runtime-choice";
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: `${provider}/${model}`,
          models: { [`${provider}/${model}`]: { agentRuntime: { id: runtimeId } } },
        },
      },
    };
    const route = {
      provider,
      id: model,
      name: "Opus fixture",
      nativeRuntime: runtimeId,
      contextWindow: 128_000,
      contextTokens: prompt,
      ...(selected
        ? { contextWindows: [{ id: "small", label: "Small", contextWindow: 200_000 }] }
        : {}),
    };
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.agentHarnesses.push({
      pluginId: runtimeId,
      source: "test",
      harness: {
        id: runtimeId,
        label: "Claude CLI",
        authBootstrap: "harness",
        supports: () => ({ supported: true }),
        readModelCatalogReadiness: () => ({ accountType: "claude", authMode: "oauth" }),
        runAttempt: async () => {
          throw new Error("Passive summary must not execute a model");
        },
      },
    });
    setActivePluginRegistry(pluginRegistry);
    prepared.owner = createModelRuntimeChoiceOwnerFixture(cfg, () => true, {
      workspaceDir,
      pluginRegistry,
      metadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [{ id: runtimeId, providers: [runtimeId], syntheticAuthRefs: [runtimeId] }],
      }),
      modelCatalog: { entries: [route], routeVariants: [route] },
    });
    bindPreparedModelRuntimeAuth(prepared.owner, { store: { version: 1, profiles: {} } });
    vi.stubEnv("ANTHROPIC_API_KEY", undefined);
    const saved = {
      ...entry,
      modelProvider: provider,
      model,
      agentHarnessId: runtimeId,
      agentRuntimeOverride: runtimeId,
      contextWindow: selected,
    };
    expect(
      resolveEffectiveAgentRuntime({
        cfg,
        provider,
        modelId: model,
        agentId: "main",
        sessionEntry: saved,
      }),
    ).toBe(runtimeId);
    const resolution = await createStatusModelResolver({
      cfg,
      agentId: "main",
      agentDir: prepared.owner.agentDir,
      workspaceDir,
      sessionEntry: saved,
      owner: prepared.owner,
    })({ provider, model, runtimeId, acceptedProviderIds: [] });
    expect(resolution.endpoint).toBeUndefined();
    expect(resolution.authLabel).toBe("oauth (claude-cli)");
    const store = await writeStore({ "agent:main:main": saved });
    try {
      const summary = await getStatusSummary({
        includeChannelSummary: false,
        config: { ...cfg, session: { store } },
      });
      expect(summary.sessions.recent[0]?.contextTokens).toBe(expected);
    } finally {
      await closeOpenClawAgentDatabaseByPathAsync(store);
      cleanupStore(store);
    }
  });

  it("keeps sessions JSON capacity unknown without its admitted owner", async () => {
    setMockSessionsConfig(() => config);
    const store = await writeStore({ "agent:main:main": entry });
    const result = await runSessionsJson<{ sessions: Array<{ contextTokens: number | null }> }>(
      sessionsCommand,
      store,
    );
    expect(result.sessions[0]?.contextTokens).toBeNull();
  });

  it("does not borrow bundled capacity for a synthetic status summary row", async () => {
    const store = await writeStore({ "agent:main:main": entry });
    try {
      const summary = await getStatusSummary({
        includeChannelSummary: false,
        config: { ...config, session: { store } },
      });
      expect(summary.sessions.recent[0]?.contextTokens).toBeNull();
    } finally {
      await closeOpenClawAgentDatabaseByPathAsync(store);
      cleanupStore(store);
    }
  });
});
