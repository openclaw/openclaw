import { vi } from "vitest";
import { normalizeStringEntries } from "../shared/string-normalization.js";

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
  loadModelCatalog: vi.fn(),
}));

vi.mock("../agents/model-selection.js", () => {
  type ConfigWithModels = {
    agents?: {
      defaults?: {
        model?: string | { primary?: string; fallbacks?: string[] };
        models?: Record<string, { params?: { thinking?: string } } | undefined>;
        thinkingDefault?: string;
      };
    };
  };
  type ModelRef = { provider: string; model: string };
  type ModelAliasIndex = {
    byAlias: Map<string, { alias: string; ref: ModelRef }>;
    byKey: Map<string, string[]>;
  };
  type CatalogEntry = { id?: string; model?: string; name?: string; reasoning?: boolean };

  const parseModelRefImpl = (raw: string, defaultProvider = "openai"): ModelRef | null => {
    const value = raw.trim();
    if (!value) {
      return null;
    }
    const slash = value.indexOf("/");
    if (slash >= 0) {
      return {
        provider: value.slice(0, slash).trim(),
        model: value.slice(slash + 1).trim(),
      };
    }
    return { provider: defaultProvider, model: value };
  };
  const parseModelRef = vi.fn(parseModelRefImpl);
  const normalizeModelRef = (provider: string, model: string): ModelRef => ({
    provider: provider.trim().toLowerCase(),
    model: model.trim(),
  });
  const modelKey = (provider: string, model: string) =>
    `${provider.trim().toLowerCase()}/${model.trim().toLowerCase()}`;
  const isModelKeyAllowedBySet = (allowedKeys: ReadonlySet<string>, key: string) => {
    if (allowedKeys.has(key)) {
      return true;
    }
    const slash = key.indexOf("/");
    return slash > 0 && allowedKeys.has(`${key.slice(0, slash)}/*`);
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
  const resolveModelConfig = (cfg: ConfigWithModels | undefined, ref: ModelRef) => {
    const models = cfg?.agents?.defaults?.models ?? {};
    return models[`${ref.provider}/${ref.model}`] ?? models[modelKey(ref.provider, ref.model)];
  };
  const buildModelAliasIndexImpl = ({
    cfg,
    defaultProvider = "openai",
  }: {
    cfg?: ConfigWithModels;
    defaultProvider?: string;
  }): ModelAliasIndex => {
    const byAlias = new Map<string, { alias: string; ref: ModelRef }>();
    const byKey = new Map<string, string[]>();
    const models = cfg?.agents?.defaults?.models ?? {};
    for (const [rawKey, entry] of Object.entries(models)) {
      if (rawKey.trim().endsWith("/*")) {
        continue;
      }
      const alias = (entry as { alias?: string } | undefined)?.alias?.trim();
      if (!alias) {
        continue;
      }
      const parsed = parseModelRefImpl(rawKey, defaultProvider);
      if (!parsed) {
        continue;
      }
      const ref = normalizeModelRef(parsed.provider, parsed.model);
      byAlias.set(alias.toLowerCase(), { alias, ref });
      const key = modelKey(ref.provider, ref.model);
      byKey.set(key, [...(byKey.get(key) ?? []), alias]);
    }
    return { byAlias, byKey };
  };
  const buildModelAliasIndex = vi.fn(buildModelAliasIndexImpl);
  const resolveModelRefFromString = vi.fn(
    ({
      raw,
      defaultProvider = "openai",
      aliasIndex,
    }: {
      cfg?: ConfigWithModels;
      raw: string;
      defaultProvider?: string;
      aliasIndex?: ModelAliasIndex;
    }): { ref: ModelRef; alias?: string } | null => {
      const value = raw.trim();
      if (!value) {
        return null;
      }
      const aliasMatch = aliasIndex?.byAlias.get(value.toLowerCase());
      if (aliasMatch) {
        return { ref: aliasMatch.ref, alias: aliasMatch.alias };
      }
      const parsed = parseModelRefImpl(value, defaultProvider);
      return parsed ? { ref: normalizeModelRef(parsed.provider, parsed.model) } : null;
    },
  );

  return {
    buildAllowedModelSet: vi.fn(({ cfg }: { cfg?: ConfigWithModels; catalog?: CatalogEntry[] }) => {
      const refs = new Set<string>();
      const modelConfig = cfg?.agents?.defaults?.models ?? {};
      for (const raw of Object.keys(modelConfig)) {
        const parsed = parseModelRefImpl(raw, "openai");
        if (parsed) {
          refs.add(modelKey(parsed.provider, parsed.model));
        }
      }
      const primary = resolveDefaultRef(cfg);
      refs.add(modelKey(primary.provider, primary.model));
      const fallbackRefs =
        typeof cfg?.agents?.defaults?.model === "object"
          ? (cfg.agents.defaults.model.fallbacks ?? [])
          : [];
      for (const fallback of fallbackRefs) {
        const parsed = parseModelRefImpl(fallback, primary.provider);
        if (parsed) {
          refs.add(modelKey(parsed.provider, parsed.model));
        }
      }
      return {
        allowedKeys: refs,
        allowedCatalog: [],
        allowAny: Object.keys(modelConfig).length === 0,
      };
    }),
    createModelVisibilityPolicy: vi.fn(
      ({ cfg, catalog = [] }: { cfg?: ConfigWithModels; catalog?: CatalogEntry[] }) => {
        const refs = new Set<string>();
        const modelConfig = cfg?.agents?.defaults?.models ?? {};
        for (const raw of Object.keys(modelConfig)) {
          const parsed = parseModelRefImpl(raw, "openai");
          if (parsed) {
            refs.add(modelKey(parsed.provider, parsed.model));
          }
        }
        const primary = resolveDefaultRef(cfg);
        refs.add(modelKey(primary.provider, primary.model));
        const allowAny = Object.keys(modelConfig).length === 0;
        const allowsKey = (key: string) => allowAny || isModelKeyAllowedBySet(refs, key);
        return {
          allowAny,
          allowedKeys: refs,
          allowedCatalog: catalog,
          exactModelRefs: Object.keys(modelConfig).filter((key) => !key.endsWith("/*")),
          providerWildcards: new Set(
            Object.keys(modelConfig)
              .filter((key) => key.endsWith("/*"))
              .map((key) => key.slice(0, -2).trim().toLowerCase()),
          ),
          hasConfiguredEntries: Object.keys(modelConfig).length > 0,
          hasProviderWildcards: Object.keys(modelConfig).some((key) => key.endsWith("/*")),
          allowsKey,
          allows: ({ provider, model }: ModelRef) => allowsKey(modelKey(provider, model)),
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
    buildModelAliasIndex,
    resolveModelRefFromString,
    isModelKeyAllowedBySet,
    isCliProvider: vi.fn(() => false),
    modelKey,
    normalizeModelRef,
    parseModelRef,
    resolveConfiguredModelRef: vi.fn(
      ({ cfg }: { cfg?: ConfigWithModels; defaultProvider?: string; defaultModel?: string }) =>
        resolveDefaultRef(cfg),
    ),
    resolveDefaultModelForAgent: vi.fn(({ cfg }: { cfg?: ConfigWithModels }) =>
      resolveDefaultRef(cfg),
    ),
    resolveThinkingDefault: vi.fn(
      ({
        cfg,
        provider,
        model,
        catalog,
      }: {
        cfg?: ConfigWithModels;
        provider: string;
        model: string;
        catalog?: CatalogEntry[];
      }) => {
        const ref = normalizeModelRef(provider, model);
        const modelThinking = resolveModelConfig(cfg, ref)?.params?.thinking;
        if (modelThinking) {
          return modelThinking;
        }
        const defaultThinking = cfg?.agents?.defaults?.thinkingDefault;
        if (defaultThinking) {
          return defaultThinking;
        }
        const entry = catalog?.find((item) => item.id === model || item.model === model);
        if (entry?.reasoning && entry.name?.includes("4.6")) {
          return "adaptive";
        }
        return entry?.reasoning ? "low" : "off";
      },
    ),
  };
});

vi.mock("../agents/subagent-announce.js", () => ({
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

vi.mock("../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: vi.fn(() => undefined),
  loadWorkspaceSkillEntries: vi.fn(() => []),
}));

vi.mock("../agents/skills/refresh.js", () => ({
  getSkillsSnapshotVersion: vi.fn(() => 0),
}));

vi.mock("../agents/skills/refresh-state.js", () => ({
  getSkillsSnapshotVersion: vi.fn(() => 0),
  shouldRefreshSnapshotForVersion: vi.fn(() => false),
}));

vi.mock("../agents/skills/filter.js", () => ({
  normalizeSkillFilter: vi.fn((skillFilter?: ReadonlyArray<unknown>) =>
    skillFilter ? normalizeStringEntries(skillFilter) : undefined,
  ),
  normalizeSkillFilterForComparison: vi.fn((skillFilter?: ReadonlyArray<unknown>) =>
    skillFilter
      ?.map((entry) => String(entry).trim())
      .filter(Boolean)
      .toSorted(),
  ),
  matchesSkillFilter: vi.fn(() => true),
}));

vi.mock("../agents/exec-defaults.js", () => ({
  canExecRequestNode: vi.fn(() => false),
}));

vi.mock("../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => undefined),
}));
