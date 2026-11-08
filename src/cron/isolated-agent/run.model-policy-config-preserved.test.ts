import { describe, expect, it } from "vitest";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { DEFAULT_PROVIDER } from "../../agents/defaults.js";
import { resolveExtraParams } from "../../agents/embedded-agent-runner/extra-params.js";
import { resolveFastModeState } from "../../agents/fast-mode.js";
import { resolveMemorySearchConfig } from "../../agents/memory-search.js";
import { resolveAllowedModelRefCore } from "../../agents/model-selection-resolve.js";
import { resolveConfiguredThinkingDefault } from "../../agents/model-thinking-default.js";
import { resolveSandboxConfigForAgent } from "../../agents/sandbox/config.js";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import type { AgentEntryConfig } from "../../config/types.agents.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { MemorySearchConfig } from "../../config/types.tools.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { resolveCronModelSelection } from "./model-selection.js";
import { resolveCronAgentConfig } from "./run-config.js";

function config(defaults: AgentDefaultsConfig, worker: AgentEntryConfig = {}): OpenClawConfig {
  return { agents: { defaults, entries: { worker } } };
}
function buildCronConfig(cfg: OpenClawConfig): OpenClawConfig {
  return resolveCronAgentConfig({
    config: cfg,
    agentConfigOverride: resolveAgentConfig(cfg, "worker"),
  }).cfgWithAgentDefaults;
}
type ModelOwner = NonNullable<Parameters<typeof resolveCronModelSelection>[0]["owner"]>;
function modelOwner(
  cfg: OpenClawConfig,
  metadataSnapshot = createPluginMetadataSnapshotFixture({ plugins: [] }),
): ModelOwner {
  return {
    config: cfg,
    agentId: "worker",
    agentDir: "/tmp/cron-agent",
    workspaceDir: metadataSnapshot.workspaceDir ?? "/tmp/cron-owner",
    metadataSnapshot,
    modelCatalog: { entries: [], routeVariants: [] },
  };
}
function selectModel(owner: ModelOwner, isGmailHook = false) {
  return resolveCronModelSelection({
    cfg: owner.config,
    owner,
    agentConfigOverride: resolveAgentConfig(owner.config, owner.agentId),
    agentId: owner.agentId,
    agentDir: owner.agentDir,
    workspaceDir: owner.workspaceDir,
    sessionEntry: {},
    isGmailHook,
  });
}
function resolveCronPayloadModel(cfg: OpenClawConfig, raw: string) {
  return resolveAllowedModelRefCore({
    cfg,
    catalog: [
      { provider: "openai", id: "gpt-5.5", name: "GPT 5.5" },
      { provider: "openai", id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    ],
    raw,
    defaultProvider: "openai",
    defaultModel: "baseline",
    manifestPlugins: [],
  });
}

describe("resolveCronAgentConfig preserves agent-aware config", () => {
  it("keeps ACP harness models out of native defaults while preserving empty fallbacks", async () => {
    const fallbacks: string[] = [];
    const primary = "native/primary@native:test-profile";
    const cfg = config(
      { model: { primary, fallbacks: ["native/default-backup"] } },
      {
        runtime: { type: "acp" },
        model: { primary: "harness-only[reasoning=medium]", fallbacks },
      },
    );
    cfg.plugins = { enabled: false };
    expect(await selectModel(modelOwner(cfg))).toMatchObject({
      ok: true,
      provider: "native",
      model: "primary",
      modelSource: "default",
      configuredProfileId: "native:test-profile",
      cfgWithAgentDefaults: { agents: { defaults: { model: { primary, fallbacks } } } },
    });
  });

  it("keeps per-agent model parameters and controls without flattening their catalog", () => {
    const cfg = config(
      {
        model: "openai/test-model",
        models: {
          "openai/test-model": {
            agentRuntime: { id: "openclaw" },
            params: {
              maxTokens: 2048,
              topP: 0.6,
              thinking: "high",
              fastMode: false,
              fastAutoOnSeconds: 60,
            },
          },
        },
      },
      {
        models: {
          "openai/test-model": {
            params: { max_tokens: 1536, thinking: "low", fast_mode: "auto", fast_seconds: 20 },
          },
        },
        params: { temperature: 0.4 },
      },
    );
    const selection = {
      cfg: buildCronConfig(cfg),
      agentId: "worker",
      provider: "openai",
      model: "test-model",
    };
    expect(resolveExtraParams({ ...selection, modelId: selection.model })).toMatchObject({
      maxTokens: 1536,
      topP: 0.6,
      temperature: 0.4,
    });
    expect(resolveConfiguredThinkingDefault(selection)).toBe("low");
    expect(resolveFastModeState(selection)).toMatchObject({ mode: "auto", fastAutoOnSeconds: 20 });
  });

  it.each([false, true])("resolves per-agent allowlist override=%s", (override) => {
    const allowed = override ? "openai/gpt-5.6-sol" : "openai/gpt-5.5";
    const denied = override ? "openai/gpt-5.5" : "openai/gpt-5.6-sol";
    const cronCfg = buildCronConfig(
      config(
        { modelPolicy: { allow: ["openai/gpt-5.5"] } },
        { modelPolicy: override ? { allow: [allowed] } : {} },
      ),
    );
    expect(cronCfg.agents?.defaults?.modelPolicy).toEqual({ allow: [allowed] });
    expect(resolveCronPayloadModel(cronCfg, denied)).toEqual({
      error: `model not allowed: ${denied}`,
    });
    if (override) {
      expect(resolveCronPayloadModel(cronCfg, allowed)).toMatchObject({
        ref: { provider: "openai", model: "gpt-5.6-sol" },
      });
    }
  });

  it.each(["agent", "hook"] as const)(
    "keeps the selected owner's metadata for the %s model",
    async (source) => {
      const snapshot = (workspaceDir: string, model: string) => ({
        ...createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "cron-model-policy",
              modelIdNormalization: {
                providers: {
                  custom: { aliases: { legacy: model } },
                  [DEFAULT_PROVIDER]: { aliases: { legacy: model } },
                },
              },
            },
          ],
        }),
        workspaceDir,
      });
      const metadataSnapshot = snapshot("/tmp/cron-owner", "selected");
      const cfg = config(
        {
          model: { primary: "custom/baseline" },
          modelPolicy: { allow: ["custom/legacy", `${DEFAULT_PROVIDER}/legacy`] },
        },
        {
          agentDir: "/tmp/cron-agent",
          workspace: metadataSnapshot.workspaceDir,
          ...(source === "agent" ? { model: "custom/legacy" } : {}),
        },
      );
      if (source === "hook") {
        cfg.hooks = { gmail: { model: "legacy" } };
      }
      const owner = modelOwner(cfg, metadataSnapshot);
      for (const ambient of [metadataSnapshot, snapshot("/tmp/other-owner", "other")]) {
        expect(
          await withPluginRuntimeGenerationScope({ metadataSnapshot: ambient }, () =>
            selectModel(owner, source === "hook"),
          ),
        ).toMatchObject({
          ok: true,
          provider: source === "hook" ? DEFAULT_PROVIDER : "custom",
          model: "selected",
          modelSource: source,
        });
      }
    },
  );

  it("keeps global sandbox defaults when agent override is partial", () => {
    const defaults = {
      mode: "all",
      workspaceAccess: "rw",
      docker: {
        network: "none",
        dangerouslyAllowContainerNamespaceJoin: true,
        dangerouslyAllowExternalBindSources: true,
      },
      browser: { enabled: true, autoStart: false },
      prune: { maxAgeDays: 7 },
    } as const;
    const sandbox = {
      docker: { image: "ghcr.io/openclaw/sandbox:custom" },
      browser: { image: "ghcr.io/openclaw/browser:custom" },
      prune: { idleHours: 1 },
    };
    const runCfg = buildCronConfig(config({ sandbox: structuredClone(defaults) }, { sandbox }));
    expect(runCfg.agents?.defaults?.sandbox).toEqual(defaults);
    expect(resolveSandboxConfigForAgent(runCfg, "worker")).toMatchObject({
      mode: "all",
      workspaceAccess: "rw",
      docker: { ...defaults.docker, ...sandbox.docker },
      browser: { ...defaults.browser, ...sandbox.browser },
      prune: { ...defaults.prune, ...sandbox.prune },
    });
  });

  it("keeps global memory search defaults when the agent override is partial", () => {
    const defaults = {
      enabled: true,
      provider: "openai",
      model: "text-embedding-3-large",
      sources: ["memory", "sessions"],
      remote: { apiKey: "redacted" },
      query: { maxResults: 6 },
    } satisfies MemorySearchConfig;
    const search = {
      rememberAcrossConversations: true,
      query: { maxResults: 10 },
    } satisfies MemorySearchConfig;
    const worker = { memory: { search } };
    const { agentDefaults } = resolveCronAgentConfig({ config: {}, agentConfigOverride: worker });
    const runCfg = {
      ...config(agentDefaults, worker),
      plugins: { enabled: false },
      memory: { search: defaults },
    };
    expect(agentDefaults).not.toHaveProperty("memory");
    expect(resolveMemorySearchConfig(runCfg, "worker")).toMatchObject({ ...defaults, ...search });
  });
});
