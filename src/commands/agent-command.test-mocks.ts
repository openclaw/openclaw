// Agent command test mocks replace logging and runtime-heavy modules shared by agent command suites.
import { vi } from "vitest";
import { getAgentHarnessPluginMocks } from "./agent-command-state.test-mocks.js";

// Harness/plugin selection has focused owner coverage in runtime-plugin.test.ts.
// Command suites only need to prove their handoff without loading plugin manifests.
const agentHarnessPluginMocks = getAgentHarnessPluginMocks();

vi.mock("../agents/harness/runtime-plugin.js", () => ({
  ensureSelectedAgentHarnessPlugin: agentHarnessPluginMocks.ensureSelectedAgentHarnessPlugin,
}));

vi.mock("../agents/runtime-plugins.js", async () => {
  const { createEmptyPluginRegistry } = await import("../plugins/registry-empty.js");
  return {
    withAgentPluginRegistry: ({ run }: { run: () => unknown }) => run(),
    loadAgentRuntimePluginRegistryHandle: () => createEmptyPluginRegistry(),
    acquireAgentRuntimePluginRegistry: async () => {
      const registry = createEmptyPluginRegistry();
      return { registry, primaryRegistry: registry };
    },
  };
});

vi.mock("../logging/subsystem.js", () => {
  const createMockLogger = () => ({
    subsystem: "test",
    isEnabled: vi.fn(() => true),
    trace: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  });
  return {
    createSubsystemLogger: vi.fn(() => createMockLogger()),
  };
});

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: vi.fn(() => ({})),
}));

const acpManagerMock = vi.hoisted(() => ({
  current: {
    resolveSession: vi.fn(() => null),
  } as unknown,
}));

vi.mock("../acp/control-plane/manager.js", () => ({
  testing: {
    resetAcpSessionManagerForTests: vi.fn(() => {
      acpManagerMock.current = {
        resolveSession: vi.fn(() => null),
      };
    }),
    setAcpSessionManagerForTests: vi.fn((manager: unknown) => {
      acpManagerMock.current = manager;
    }),
  },
  getAcpSessionManager: vi.fn(() => acpManagerMock.current),
}));

vi.mock("../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: vi.fn().mockReturnValue(false),
  runEmbeddedAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));

vi.mock("../agents/model-catalog.js", () => ({
  loadManifestModelCatalog: vi.fn(() => []),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: vi.fn(),
  loadPreparedModelCatalogSnapshot: vi.fn(async () => ({
    entries: [],
    routeVariants: [],
  })),
}));

vi.mock("../agents/model-selection.js", async (importOriginal) => {
  const {
    inferUniqueProviderFromConfiguredModels,
    normalizeStoredOverrideModel,
    resolvePersistedSelectedModelRef,
  } = await importOriginal<typeof import("../agents/model-selection.js")>();
  const { normalizeModelRef } = await import("../agents/model-ref-shared.js");
  const { parseModelRef: parseModelRefImpl } =
    await import("../agents/model-selection-normalize.js");
  type ConfigWithModels = {
    meta?: { migrations?: { modelPolicyAllowlist?: boolean } };
    agents?: {
      defaults?: {
        model?: string | { primary?: string; fallbacks?: string[] };
        modelPolicy?: { allow?: string[] };
        models?: Record<string, { params?: { thinking?: string } } | undefined>;
        thinkingDefault?: string;
      };
    };
  };
  type ModelRef = { provider: string; model: string };
  type CatalogEntry = { id?: string; model?: string; name?: string; reasoning?: boolean };

  const parseModelRef = vi.fn(parseModelRefImpl);
  const normalizeProviderId = (provider: string) => provider.trim().toLowerCase();
  const modelKey = (provider: string, model: string) =>
    `${normalizeProviderId(provider)}/${model.trim().toLowerCase()}`;
  const isModelKeyAllowedBySet = (allowedKeys: ReadonlySet<string>, key: string) => {
    if (allowedKeys.has(key)) {
      return true;
    }
    let separator = key.indexOf("/");
    while (separator > 0) {
      if (allowedKeys.has(`${key.slice(0, separator + 1)}*`)) {
        return true;
      }
      separator = key.indexOf("/", separator + 1);
    }
    return false;
  };
  const resolvePrimary = (cfg?: ConfigWithModels): string | undefined => {
    const primary = cfg?.agents?.defaults?.model;
    if (typeof primary === "string") {
      return primary;
    }
    return primary?.primary;
  };
  const resolveDefaultRef = (cfg?: ConfigWithModels): ModelRef => {
    const parsed = parseModelRefImpl(resolvePrimary(cfg) ?? "openai/gpt-5.5", "openai");
    return parsed ?? { provider: "openai", model: "gpt-5.5" };
  };
  const resolvePolicyRefs = (cfg?: ConfigWithModels) => {
    const defaults = cfg?.agents?.defaults;
    const hasExplicitPolicy = Boolean(
      defaults?.modelPolicy && Object.hasOwn(defaults.modelPolicy, "allow"),
    );
    if (hasExplicitPolicy) {
      return {
        refs: defaults?.modelPolicy?.allow ?? [],
        configPath: "agents.defaults.modelPolicy.allow",
      };
    }
    if (cfg?.meta?.migrations?.modelPolicyAllowlist !== true) {
      const refs = Object.keys(defaults?.models ?? {});
      if (refs.length > 0) {
        return { refs, configPath: "agents.defaults.models" };
      }
    }
    return { refs: [], configPath: null };
  };

  return {
    buildAllowedModelSet: vi.fn(({ cfg }: { cfg?: ConfigWithModels; catalog?: CatalogEntry[] }) => {
      const refs = new Set<string>();
      const policyRefs = resolvePolicyRefs(cfg).refs;
      for (const raw of policyRefs) {
        const parsed = parseModelRefImpl(raw, "openai");
        if (parsed) {
          refs.add(modelKey(parsed.provider, parsed.model));
        }
      }
      const primary = resolveDefaultRef(cfg);
      refs.add(modelKey(primary.provider, primary.model));
      return {
        allowedKeys: refs,
        allowedCatalog: [],
        allowAny: policyRefs.length === 0,
      };
    }),
    createModelVisibilityPolicy: vi.fn(
      ({ cfg, catalog = [] }: { cfg?: ConfigWithModels; catalog?: CatalogEntry[] }) => {
        const refs = new Set<string>();
        const policy = resolvePolicyRefs(cfg);
        const policyRefs = policy.refs;
        for (const raw of policyRefs) {
          const parsed = parseModelRefImpl(raw, "openai");
          if (parsed) {
            refs.add(modelKey(parsed.provider, parsed.model));
          }
        }
        const primary = resolveDefaultRef(cfg);
        refs.add(modelKey(primary.provider, primary.model));
        const allowAny = policyRefs.length === 0;
        const wildcardModelKeys = new Set(
          policyRefs.filter((key) => key.endsWith("/*")).map((key) => key.trim().toLowerCase()),
        );
        const wildcardProviders = new Set(
          [...wildcardModelKeys].map((key) => key.slice(0, key.indexOf("/"))),
        );
        const allowsKey = (key: string) => allowAny || isModelKeyAllowedBySet(refs, key);
        return {
          allowAny,
          catalog,
          allowedKeys: refs,
          allowedCatalog: catalog,
          exactModelRefs: policyRefs.filter((key) => !key.endsWith("/*")),
          providerWildcards: wildcardProviders,
          hasConfiguredEntries: policyRefs.length > 0,
          hasProviderWildcards: wildcardModelKeys.size > 0,
          allowConfigPath: policy.configPath,
          allowRepairConfigPath: "agents.defaults.modelPolicy.allow",
          allows: ({ provider, model }: ModelRef) => allowsKey(modelKey(provider, model)),
          allowsByWildcard: ({ provider, model }: ModelRef) =>
            isModelKeyAllowedBySet(wildcardModelKeys, modelKey(provider, model)),
          resolveSelection: ({ provider, model }: ModelRef) => {
            const key = modelKey(provider, model);
            if (allowsKey(key)) {
              return { provider, model };
            }
            const fallback = catalog[0];
            return fallback?.id ? { provider: "openai", model: fallback.id } : null;
          },
          visibleCatalog: ({ catalog: visibleCatalog }: { catalog: CatalogEntry[] }) =>
            visibleCatalog,
        };
      },
    ),
    buildConfiguredModelCatalog: vi.fn(() => []),
    buildModelAliasIndex: vi.fn(() => new Map()),
    isModelKeyAllowedBySet,
    inferUniqueProviderFromConfiguredModels,
    isCliProvider: vi.fn(() => false),
    modelKey,
    normalizeModelRef,
    normalizeStoredOverrideModel,
    normalizeProviderId,
    normalizeProviderIdForAuth: normalizeProviderId,
    parseModelRef,
    resolvePersistedSelectedModelRef,
    resolveConfiguredModelRef: vi.fn(
      ({ cfg }: { cfg?: ConfigWithModels; defaultProvider?: string; defaultModel?: string }) =>
        resolveDefaultRef(cfg),
    ),
    resolveDefaultModelForAgent: vi.fn(({ cfg }: { cfg?: ConfigWithModels }) =>
      resolveDefaultRef(cfg),
    ),
    resolveModelRefFromString: vi.fn(
      ({
        raw,
        defaultProvider,
        ...options
      }: { raw: string; defaultProvider?: string } & NonNullable<
        Parameters<typeof parseModelRefImpl>[2]
      >) => {
        const ref = parseModelRef(raw, defaultProvider ?? "openai", options);
        return ref ? { ref, source: "parsed" } : null;
      },
    ),
  };
});

vi.mock("../agents/subagents/announce/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(),
}));

vi.mock("../agents/workspace.js", () => ({
  DEFAULT_AGENT_WORKSPACE_DIR: "/tmp/openclaw-workspace",
  DEFAULT_AGENTS_FILENAME: "AGENTS.md",
  DEFAULT_IDENTITY_FILENAME: "IDENTITY.md",
  resolveDefaultAgentWorkspaceDir: () => "/tmp/openclaw-workspace",
  ensureAgentWorkspace: vi.fn(async ({ dir }: { dir: string }) => ({ dir })),
}));

vi.mock("../skills/loading/workspace-skill-prompt.js", () => ({
  buildSkillSnapshot: vi.fn(() => undefined),
}));

vi.mock("../skills/loading/workspace-skill-loader.js", () => {
  const loadVisibleSkills = vi.fn<
    typeof import("../skills/loading/workspace-skill-loader.js").loadVisibleSkills
  >(() => []);
  return {
    filterWorkspaceSkills: (entries: unknown[]) => entries,
    loadVisibleSkills,
    prepareWorkspaceSkills: async (...args: Parameters<typeof loadVisibleSkills>) =>
      loadVisibleSkills(...args),
    loadWorkspaceSkills: vi.fn(() => []),
  };
});

vi.mock("../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => undefined),
}));

vi.mock("../plugins/bundle-commands.js", () => ({
  loadEnabledClaudeBundleCommands: vi.fn(() => []),
}));

vi.mock("../skills/discovery/agent-filter.js", () => ({
  resolveEffectiveAgentSkillFilter: vi.fn(() => undefined),
}));

vi.mock("../skills/runtime/session-snapshot.js", () => ({
  resolveReusableWorkspaceSkillSnapshot: vi.fn(
    (params?: { existingSnapshot?: unknown; skillFilter?: string[] }) => ({
      snapshot: params?.existingSnapshot ?? {
        prompt: "",
        skills: [],
        resolvedSkills: [],
        ...(params?.skillFilter === undefined ? {} : { skillFilter: params.skillFilter }),
        version: 0,
      },
      shouldRefresh: !params?.existingSnapshot,
      snapshotVersion: 0,
    }),
  ),
}));

vi.mock("../agents/exec-defaults.js", () => ({
  resolveNodeExecEligibility: vi.fn(() => ({ canExec: false })),
}));
