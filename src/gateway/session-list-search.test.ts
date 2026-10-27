import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { expect, test, vi } from "vitest";
import { SessionRunStatusSchema } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { registerAgentHarness } from "../agents/harness/registry.js";
import type { AgentHarnessSessionRuntimeOwnership } from "../agents/harness/types.js";
import { resolveSessionModelIdentityRef } from "../agents/session-model-ref.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import { isTerminalSessionStatus, type SessionEntry } from "../config/sessions/types.js";
import type { ProviderNormalizeModelIdContext } from "../plugins/provider-runtime.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { formatAgentRuntimeLabel } from "../shared/agent-runtime-display.js";
import { formatGoalSummary } from "../shared/session-goal-display.js";
import { isSessionRunStateActive } from "../shared/session-run-state.js";
import { normalizeSessionSearchText } from "../shared/session-search-text.js";
import { filterSessionEntries, type SessionListFilterParams } from "./session-list-filters.js";
import {
  readSessionListSelectionFacts,
  type SessionListModelFactsLookup,
} from "./session-list-target.js";
import * as modelFacts from "./session-row-model-facts.js";
import {
  projectGatewaySessionActiveRun,
  projectGatewaySessionRunState,
  resolveGatewaySessionDisplayName,
  resolveGatewaySessionKind,
  resolveGatewaySessionGoal,
} from "./session-utils-display.js";
import { resolveSessionSelectedModelRef } from "./session-utils-model-selection.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

test("non-status vocabulary misses skip per-row run state and model facts", () => {
  const now = 1_800_000_000_000;
  const rowContext = buildSessionListRowMetadataContext({ now });
  const display = vi.spyOn(rowContext.subagentRuns, "getDisplaySubagentRun");
  const projectActiveRun = vi.fn(() => ({ active: false }));
  const rows = Array.from({ length: 40 }, (_, index): [string, SessionEntry] => [
    `agent:main:thread-${index}`,
    {
      sessionId: `session-${index}`,
      updatedAt: index,
      providerOverride: "fixture",
      modelOverride: "raw-alias",
    },
  ]);
  const targets = new Map(
    rows.map(([key, entry]) => [
      key,
      {
        agentId: "main",
        entry,
        selection: readSessionListSelectionFacts(key, entry),
      },
    ]),
  );
  const normalizeModelId = vi.fn(({ modelId }: ProviderNormalizeModelIdContext) =>
    modelId === "raw-alias" ? "hidden-canonical" : modelId,
  );
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: "fixture",
    source: "fixture.ts",
    provider: { id: "fixture", label: "Fixture", auth: [], normalizeModelId },
  });
  const getModelFacts = vi.fn<SessionListModelFactsLookup>((key) => {
    const entry = targets.get(key)!.entry;
    const selectedModel = resolveSessionSelectedModelRef({
      cfg: params.cfg,
      agentId: "main",
      sessionKey: key,
      rowContext,
      source: { entry, readSourceEntry: () => undefined },
      preparedRuntimeOwnership: null,
      manifestPlugins: [],
    });
    return {
      selectedModel,
      rowModelIdentity: selectedModel,
      thinkingProjection: {
        agentRuntime: { id: "openclaw", source: "implicit" },
        acpMeta: undefined,
      },
    };
  });
  const params: SessionListFilterParams = {
    cfg: { agents: { defaults: { model: "openai/gpt-4.1" }, entries: { main: {} } } },
    opts: { search: "zz-no-match" },
    now,
    entries: () => rows,
    getTarget: (key) => targets.get(key),
    getModelFacts,
    modelCatalog: [{ provider: "fixture", id: "raw-alias", name: "Fixture" }],
    modelSearchMayMatch: (search) =>
      modelFacts.mayMatchSessionRowModelSearch(
        {
          cfg: params.cfg,
          modelCatalog: params.modelCatalog,
          rowContext,
          rows: rows.map(([, entry]) => ({ agentId: "main", entry })),
        },
        search,
      ),
    configuredAgentIds: new Set(["main"]),
    getRowContext: () => rowContext,
    involvementKeys: () => new Set(),
    projectActiveRun,
  };
  withPluginRuntimeRegistryScope(registry, () => {
    expect(filterSessionEntries(params).entries).toEqual([]);
    expect(projectActiveRun).not.toHaveBeenCalled();
    expect(getModelFacts).not.toHaveBeenCalled();
    expect(normalizeModelId).toHaveBeenCalledOnce();
    expect(display.mock.calls.length).toBeLessThanOrEqual(rows.length);
    normalizeModelId.mockClear();
    params.opts.search = "hidden-canonical";
    expect(filterSessionEntries(params).entries.map(([key]) => key)).toEqual(
      rows.map(([key]) => key),
    );
    expect(getModelFacts).toHaveBeenCalledTimes(rows.length);
    expect(normalizeModelId).toHaveBeenCalledTimes(rows.length + 1);
  });
});

test("automatic runtime labels use loaded vocabulary without per-row support checks", () => {
  const now = 1_800_000_000_000;
  const cfg = { agents: { defaults: { model: "fixture/auto-model" }, entries: { main: {} } } };
  const key = "agent:main:fixture";
  const entry: SessionEntry = { sessionId: "fixture", updatedAt: now };
  const rowContext = buildSessionListRowMetadataContext({ now });
  const supports = vi.fn(() => ({ supported: true as const }));
  withPluginRuntimeRegistryScope(createEmptyPluginRegistry(), () => {
    registerAgentHarness({
      id: "dynamic-runtime",
      label: "Dynamic runtime",
      supports,
      runAttempt: () => {
        throw new Error("Search must not run an agent");
      },
    });
    const facts = modelFacts.readSessionRowModelFacts({
      cfg,
      key,
      agentId: "main",
      entry,
      rowContext,
      preparedRuntimeOwnership: null,
      preparedAcpMeta: null,
      preparedModelMetadata: null,
      source: { entry, readSourceEntry: () => undefined },
    });
    expect(facts.thinkingProjection.agentRuntime.id).toBe("dynamic-runtime");
    supports.mockClear();
    expect(
      modelFacts.mayMatchSessionRowModelSearch(
        { cfg, rowContext, rows: [{ agentId: "main", entry }] },
        "dynamic-runtime",
      ),
    ).toBe(true);
    expect(supports).not.toHaveBeenCalled();
  });
});

test("native models and prepared runtime labels outside the catalog retain their matches", () => {
  const now = 1_800_000_000_000;
  const cfg = {
    agents: {
      defaults: { model: "short", models: { "openai/gpt-4.1": { alias: "short" } } },
      entries: { main: {} },
    },
  };
  const key = "agent:main:fixture";
  const entry: SessionEntry = { sessionId: "fixture", updatedAt: now, status: "done" };
  const ownership: AgentHarnessSessionRuntimeOwnership = {
    model: "native",
    auth: "native",
    modelRef: { provider: "fixture-native", model: "native-only-target" },
  };
  const acp: NonNullable<SessionEntry["acp"]> = {
    backend: "fixture-runtime",
    agent: "main",
    runtimeSessionName: key,
    mode: "persistent",
    state: "idle",
    lastActivityAt: now,
  };
  const rowContext = buildSessionListRowMetadataContext({ now });
  const getModelFacts = vi.fn(() =>
    modelFacts.readSessionRowModelFacts({
      cfg,
      key,
      agentId: "main",
      entry,
      rowContext,
      modelCatalog: [],
      preparedRuntimeOwnership: ownership,
      preparedAcpMeta: acp,
      preparedModelMetadata: null,
      source: { entry, readSourceEntry: () => undefined },
    }),
  );
  const params: SessionListFilterParams = {
    cfg,
    opts: {},
    now,
    entries: () => [[key, entry]],
    getTarget: () => ({
      agentId: "main",
      entry,
      selection: readSessionListSelectionFacts(key, entry),
    }),
    getModelFacts,
    modelSearchMayMatch: (search) =>
      modelFacts.mayMatchSessionRowModelSearch(
        {
          cfg,
          rowContext,
          modelCatalog: [],
          rows: [
            { agentId: "main", entry, preparedRuntimeOwnership: ownership, preparedAcpMeta: acp },
          ],
        },
        search,
      ),
    configuredAgentIds: new Set(["main"]),
    getRowContext: () => rowContext,
    involvementKeys: () => new Set(),
    projectActiveRun: () => ({ active: false }),
  };
  for (const model of ["native-only-target", "different-native-target"]) {
    ownership.modelRef = { provider: "fixture-native", model };
    for (const search of [
      model,
      `fixture-native/${model}`,
      "fixture-runtime",
      "running",
      "idle",
      "zz-no-match",
    ]) {
      params.opts = { search };
      const expected = eagerSearch(params, key, entry);
      getModelFacts.mockClear();
      expect(
        filterSessionEntries(params).entries.map(([value]) => value),
        search,
      ).toEqual(expected ? [key] : []);
      expect(getModelFacts.mock.calls.length, search).toBe(
        search === model || search === `fixture-native/${model}` || search === "fixture-runtime"
          ? 1
          : 0,
      );
    }
  }
  ownership.modelRef = undefined;
  for (const [search, factReads] of [
    ["gpt-4.1", 0],
    ["openai/gpt-4.1", 0],
    ["short", 1],
  ] as const) {
    params.opts = { search };
    const expected = eagerSearch(params, key, entry);
    expect(expected, search).toBe(search !== "short");
    getModelFacts.mockClear();
    expect(
      filterSessionEntries(params).entries.map(([value]) => value),
      search,
    ).toEqual(expected ? [key] : []);
    expect(getModelFacts.mock.calls.length, search).toBe(factReads);
  }
  params.projectActiveRun = () => ({ active: true });
  params.opts = { search: "running" };
  getModelFacts.mockClear();
  expect(filterSessionEntries(params).entries.map(([value]) => value)).toEqual([key]);
  expect(getModelFacts).not.toHaveBeenCalled();
  acp.backend = "agent:fixture-runtime";
  params.opts = { search: acp.backend };
  expect(filterSessionEntries(params).entries.map(([value]) => value)).toEqual([key]);
});

// The original eager predicate is the oracle for query gates and per-call memo keys.
function eagerSearch(params: SessionListFilterParams, key: string, entry: SessionEntry) {
  const search = normalizeLowercaseStringOrEmpty(params.opts.search);
  if (!search) {
    return true;
  }
  const target = params.getTarget(key)!;
  const rowContext = params.getRowContext();
  const storeKey = target.storeKey ?? key;
  const titles = [
    entry.label,
    entry.subject,
    entry.category,
    entry.displayName ?? entry.label,
    resolveGatewaySessionDisplayName(storeKey, entry),
  ];
  const fields = [storeKey, entry.sessionId, ...titles, resolveGatewaySessionKind(storeKey, entry)];
  const modelFields = (identity: { provider?: string; model?: string }) => {
    const provider = identity.provider?.trim();
    const model = identity.model?.trim();
    fields.push(provider, model, provider && model ? `${provider}/${model}` : undefined);
  };
  modelFields({ provider: entry.modelProvider, model: entry.model });
  const run = projectGatewaySessionRunState({
    key: storeKey,
    entry,
    now: params.now,
    rowContext,
  }).fields;
  const state = projectGatewaySessionActiveRun(
    params.projectActiveRun?.(key, entry, target.agentId),
    run.status,
  );
  const goal = resolveGatewaySessionGoal(entry, params.now);
  fields.push(
    state.status,
    isSessionRunStateActive(state)
      ? "live running"
      : state.hasActiveRun === false
        ? "idle"
        : undefined,
    goal
      ? `${goal.objective} ${goal.status} ${formatGoalSummary(goal)} ${goal.lastStatusNote ?? ""}`
      : undefined,
    params.identityNames?.get(target.agentId),
  );
  const source = params.getModelFacts!(key);
  if (!search.startsWith("agent:")) {
    modelFields(
      resolveSessionModelIdentityRef(
        params.cfg,
        entry,
        target.agentId,
        rowContext.subagentRuns.getDisplaySubagentRun(storeKey)?.model,
        {
          allowPluginNormalization: false,
          configuredDefaultModelByAgent: rowContext.configuredDefaultModelByAgent,
        },
      ),
    );
    modelFields(source.selectedModel);
    modelFields(source.rowModelIdentity);
  }
  fields.push(formatAgentRuntimeLabel(source.thinkingProjection.agentRuntime));
  const titleSearch = normalizeSessionSearchText(search);
  return (
    fields.some(
      (field) =>
        typeof field === "string" && normalizeLowercaseStringOrEmpty(field).includes(search),
    ) ||
    Boolean(
      titleSearch &&
      titles.some((field) => normalizeSessionSearchText(field).includes(titleSearch)),
    )
  );
}

test("search preserves the eager predicate's rows and order across vocabulary substrings and request scopes", () => {
  const now = 1_800_000_000_000;
  let seed = 242;
  const choose = <T>(items: readonly T[]): T => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return items[(seed >>> 0) % items.length]!;
  };
  const statuses = SessionRunStatusSchema.anyOf.map((status) => status.const);
  const persistedStatuses = statuses.filter(isTerminalSessionStatus);
  const providers = [undefined, "openai", "anthropic"];
  const models = [undefined, "gpt-4.1", "claude-sonnet-4", "vendor/custom"];
  const rows = Array.from({ length: 64 }, (_, index): [string, SessionEntry] => [
    `agent:${index % 2 ? "main" : "research"}:thread-${index}`,
    {
      sessionId: `row-${index}`,
      updatedAt: index,
      displayName: choose([undefined, "Per-session controls", "München", "한국어"]),
      label: choose([undefined, "Sparse title", "Investigation"]),
      status: choose([undefined, ...persistedStatuses]),
      modelProvider: choose(providers),
      model: choose(models),
      providerOverride: choose(providers),
      modelOverride: choose(models),
      modelOverrideRouteResolution: choose([undefined, "resolved"] as const),
      modelOverrideFallbackOriginProvider: choose(providers),
      modelOverrideFallbackOriginModel: choose(models),
      ...(index % 3
        ? {}
        : {
            goal: {
              schemaVersion: 1,
              id: `goal-${index}`,
              objective: "Investigate sparse targets",
              status: "paused",
              createdAt: now - 100,
              updatedAt: now,
              tokenStart: 0,
              tokensUsed: 1200,
              continuationTurns: 0,
              lastStatusNote: "Waiting for review",
            },
          }),
    },
  ]);
  const targets = new Map(
    rows.map(([key, entry]) => [
      key,
      {
        agentId: key.split(":")[1]!,
        entry,
        selection: readSessionListSelectionFacts(key, entry),
      },
    ]),
  );
  const runs = rows
    .filter((_, index) => index % 5 === 0)
    .map(([key], index) => ({
      runId: `run-${index}`,
      childSessionKey: key,
      requesterSessionKey: "agent:main:parent",
      requesterDisplayKey: "parent",
      task: "Synthetic search",
      cleanup: "keep" as const,
      createdAt: now - 2000,
      model: choose(["openai/gpt-4.1", "anthropic/claude-sonnet-4", "vendor/other"]),
      execution: { status: "terminal" as const, startedAt: now - 1000, endedAt: now - 100 },
    }));
  const rowContext = buildSessionListRowMetadataContext({
    now,
    subagentRuns: buildSubagentRunReadIndexFromRuns({
      runs: new Map(runs.map((run) => [run.runId, run])),
      now,
    }),
  });
  const facts = new Map<string, ReturnType<SessionListModelFactsLookup>>(
    rows.map(([key], index): [string, ReturnType<SessionListModelFactsLookup>] => [
      key,
      {
        selectedModel: {
          provider: choose(providers) ?? "openai",
          model: choose(models) ?? "gpt-4.1",
          storedOverrideSource: null,
        },
        rowModelIdentity: { provider: choose(providers), model: choose(models) },
        thinkingProjection: {
          agentRuntime: {
            id: index < 2 ? "shared-runtime" : choose(["openclaw", "codex", "acp"]),
            source: "implicit",
            ...(index === 0 ? { fallback: "openclaw" } : index === 1 ? { fallback: "none" } : {}),
          },
          acpMeta: undefined,
        },
      },
    ]),
  );
  const params: SessionListFilterParams = {
    cfg: {
      agents: {
        defaults: { model: "openai/gpt-4.1" },
        entries: { main: {}, research: { model: "anthropic/claude-sonnet-4" } },
      },
    },
    opts: {},
    now,
    entries: () => rows,
    getTarget: (key) => targets.get(key),
    getModelFacts: (key) => facts.get(key)!,
    modelSearchMayMatch: (search) =>
      modelFacts.mayMatchSessionRowModelSearch(
        {
          cfg: params.cfg,
          rowContext,
          rows: rows.map(([key, entry]) => ({
            agentId: targets.get(key)!.agentId,
            entry,
            materialized: { source: facts.get(key)! },
          })),
        },
        search,
      ),
    configuredAgentIds: new Set(["main", "research"]),
    identityNames: new Map([
      ["main", "Helpful Assistant"],
      ["research", "Research Partner"],
    ]),
    getRowContext: () => rowContext,
    involvementKeys: () => new Set(),
    projectActiveRun: (_key, entry) => ({
      active: entry.updatedAt! % 4 === 0,
      status: entry.updatedAt! % 8 ? undefined : "queued",
    }),
  };
  const vocabulary = [
    "",
    "zz-no-match",
    "live running",
    "idle",
    ...statuses,
    "Helpful Assistant",
    "Research Partner",
    "gpt-4.1",
    "openai/gpt-4.1",
    "anthropic/claude-sonnet-4",
    "vendor/custom",
    "shared-runtime (fallback openclaw)",
    "shared-runtime (fallback none)",
    "Pursuing goal",
    "Goal paused (1.2k used)",
    "Waiting for review",
    "per session controls",
    "München",
    "한국어",
    "agent:main",
  ];
  const searches = [...vocabulary];
  for (let index = 0; index < 256; index++) {
    const word = choose(vocabulary);
    const start = choose(Array.from({ length: word.length + 1 }, (_, i) => i));
    searches.push(word.slice(start, start + 1 + (index % 16)));
  }
  for (const search of searches) {
    params.opts = { search };
    const expected = rows
      .filter(([key, entry]) => eagerSearch(params, key, entry))
      .map(([key]) => key);
    expect(
      filterSessionEntries(params).entries.map(([key]) => key),
      search,
    ).toEqual(expected);
  }
});
