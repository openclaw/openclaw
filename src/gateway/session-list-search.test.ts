import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { expect, onTestFinished, test, vi } from "vitest";
import { SessionRunStatusSchema } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import * as harnessPolicy from "../agents/harness/policy.js";
import { registerAgentHarness } from "../agents/harness/registry.js";
import type { AgentHarnessSessionRuntimeOwnership } from "../agents/harness/types.js";
import { resolveSessionModelIdentityRef } from "../agents/session-model-ref.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import {
  isTerminalSessionStatus,
  SESSION_TOTAL_TOKENS_VERSION,
  type SessionEntry,
} from "../config/sessions/types.js";
import type { ProviderNormalizeModelIdContext } from "../plugins/provider-runtime.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { formatAgentRuntimeLabel } from "../shared/agent-runtime-display.js";
import * as searchCase from "../shared/search-case.js";
import { formatGoalSummary } from "../shared/session-goal-display.js";
import { isSessionRunStateActive } from "../shared/session-run-state.js";
import { normalizeSessionSearchText } from "../shared/session-search-text.js";
import { createSessionGoalFixture } from "./session-goal.test-support.js";
import { filterSessionEntries, type SessionListFilterParams } from "./session-list-filters.js";
import {
  readSessionListSelectionFacts,
  type SessionListModelFactsLookup,
} from "./session-list-target.js";
import * as modelFacts from "./session-row-model-facts.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import {
  projectGatewaySessionActiveRun,
  projectGatewaySessionRunState,
  resolveGatewaySessionDisplayName,
  resolveGatewaySessionKind,
  resolveGatewaySessionGoal,
} from "./session-utils-display.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

const now = 1_800_000_000_000;
const searchKeys = (params: SessionListFilterParams) =>
  filterSessionEntries(params).entries.map(([key]) => key);

function searchTargets(rows: [string, SessionEntry][]) {
  return new Map(
    rows.map(([key, entry]) => [
      key,
      { agentId: key.split(":")[1]!, entry, selection: readSessionListSelectionFacts(key, entry) },
    ]),
  );
}

type ModelSearchRow =
  Parameters<typeof modelFacts.prepareSessionRowModelSearch>[0]["rows"] extends Iterable<infer Row>
    ? Row
    : never;
function searchFixture(
  rows: [string, SessionEntry][],
  overrides: Partial<SessionListFilterParams> = {},
  extraFacts?: (key: string) => Partial<ModelSearchRow>,
) {
  const rowContext = overrides.getRowContext?.() ?? buildSessionListRowMetadataContext({ now });
  const targets = searchTargets(rows);
  const params: SessionListFilterParams = {
    cfg: {},
    opts: {},
    now,
    entries: () => rows,
    getTarget: (key) => targets.get(key),
    configuredAgentIds: new Set([...targets.values()].map((target) => target.agentId)),
    getRowContext: () => rowContext,
    involvementKeys: () => new Set(),
    getModelFacts: (key) =>
      modelFacts.readSessionRowModelFacts({
        cfg: params.cfg,
        key,
        ...targets.get(key)!,
        rowContext,
        modelCatalog: params.modelCatalog,
        preparedRuntimeOwnership: null,
        preparedAcpMeta: null,
        preparedModelMetadata: null,
        source: { entry: targets.get(key)!.entry, readSourceEntry: () => undefined },
        ...extraFacts?.(key),
      }),
    modelSearchMayMatch: (search) =>
      modelFacts.prepareSessionRowModelSearch({
        cfg: params.cfg,
        modelCatalog: params.modelCatalog,
        rowContext,
        rows: rows.map(([key]) => ({ ...targets.get(key)!, ...extraFacts?.(key) })),
      })(search),
    ...overrides,
  };
  return { params, rowContext, targets };
}

test("unchanged goal searches normalize only the query and refresh with the entry revision", () => {
  const rows: [string, SessionEntry][] = Array.from({ length: 40 }, (_, index) => [
    `agent:main:goal-${index}`,
    {
      sessionId: `session-${index}`,
      updatedAt: now,
      totalTokens: 1200,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      goal: createSessionGoalFixture(`goal-${index}`, "Investigate 日本語 🦞 MiXeD", {
        tokenBudget: 2000,
      }),
    },
  ]);
  const { params, targets } = searchFixture(rows, { modelSearchMayMatch: () => false });
  using lower = vi.spyOn(searchCase, "foldSearchCase");
  for (const search of ["日本語", "🦞", "MIXED", "Pursuing goal (1.2k/2k)"]) {
    params.opts = { search };
    expect(searchKeys(params)).toEqual(rows.map(([key]) => key));
    lower.mockClear();
    params.now += 1000;
    expect(searchKeys(params)).toEqual(rows.map(([key]) => key));
    expect(lower.mock.calls).toEqual([[search], [search.toLowerCase()]]);
  }
  const [key, previous] = rows[0]!;
  rows[0] = [key, { ...previous, totalTokens: 2500 }];
  targets.set(key, searchTargets([rows[0]]).get(key)!);
  params.opts = { search: "Goal unmet (2.5k/2k)" };
  expect(searchKeys(params)).toEqual([key]);
  rows[0] = [key, { ...rows[0][1], goal: undefined }];
  targets.set(key, searchTargets([rows[0]]).get(key)!);
  expect(searchKeys(params)).toEqual([]);
});

test("non-status vocabulary misses skip per-row run state and model facts", () => {
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
  const normalizeModelId = vi.fn(({ modelId }: ProviderNormalizeModelIdContext) =>
    modelId === "raw-alias" ? "hidden-canonical" : modelId,
  );
  const registry = createEmptyPluginRegistry();
  registry.providers.push({
    pluginId: "fixture",
    source: "fixture.ts",
    provider: { id: "fixture", label: "Fixture", auth: [], normalizeModelId },
  });
  const { params, rowContext } = searchFixture(rows, {
    cfg: { agents: { defaults: { model: "openai/gpt-4.1" }, entries: { main: {} } } },
    opts: { search: "zz-no-match" },
    modelCatalog: [{ provider: "fixture", id: "raw-alias", name: "Fixture" }],
    projectActiveRun,
  });
  using getModelFacts = vi.spyOn(params, "getModelFacts");
  const display = vi.spyOn(rowContext.subagentRuns, "getDisplaySubagentRun");
  withPluginRuntimeRegistryScope(registry, () => {
    using probe = vi.spyOn(String.prototype, "includes");
    expect(filterSessionEntries(params).entries).toEqual([]);
    expect(probe.mock.contexts.filter((field) => field === "").length).toBe(0);
    expect(projectActiveRun).not.toHaveBeenCalled();
    expect(getModelFacts).not.toHaveBeenCalled();
    expect(normalizeModelId).toHaveBeenCalledOnce();
    expect(display.mock.calls.length).toBeLessThanOrEqual(rows.length);
    normalizeModelId.mockClear();
    params.opts.search = "hidden-canonical";
    expect(searchKeys(params)).toEqual(rows.map(([key]) => key));
    expect(getModelFacts).toHaveBeenCalledTimes(rows.length);
    expect(normalizeModelId).toHaveBeenCalledTimes(rows.length + 1);
  });
});

test("sigma searches reach literal goals and prepared model identities", () => {
  const goalKey = "agent:main:goal";
  const modelKey = "agent:main:model";
  const { params } = searchFixture(
    [
      [
        goalKey,
        {
          sessionId: "goal",
          updatedAt: now,
          goal: createSessionGoalFixture("goal", "ΕΛΕΓΧΟΣ — Cafe\u0301"),
        },
      ],
      [modelKey, { sessionId: "model", updatedAt: now }],
    ],
    { cfg: { agents: { defaults: { model: "fixture/default" }, entries: { main: {} } } } },
    (key) => ({
      preparedRuntimeOwnership:
        key === modelKey
          ? {
              model: "native",
              auth: "native",
              modelRef: { provider: "fixture", model: "ΟΔΗΓΟΣ" },
            }
          : null,
      preparedAcpMeta: null,
    }),
  );
  for (const search of ["Σ", "σ", "ς"]) {
    params.opts = { search };
    expect(searchKeys(params), search).toEqual([goalKey, modelKey]);
  }
  for (const search of ["café", "ελεγχος cafe"]) {
    params.opts = { search };
    expect(searchKeys(params), search).toEqual([]);
  }
});

test("reuses model search vocabulary until the row facts owner publishes a change", () => {
  const key = "agent:main:search";
  const entry = {
    sessionId: "search",
    updatedAt: 1,
    modelProvider: "fixture",
    model: "first-model",
  };
  const cfg = { agents: { defaults: { model: "fixture/auto-model" } } };
  const reader = createSessionRowProjectionFixture({ cfg, store: { [key]: entry } });
  const { params } = searchFixture([[key, entry]], { cfg });
  onTestFinished(() => reader.dispose());
  using preparations = vi.spyOn(modelFacts, "prepareSessionRowModelSearch");
  expect(reader.modelSearchMayMatch("first-model")).toBe(true);
  expect(reader.modelSearchMayMatch("unmatched")).toBe(false);
  expect(preparations).toHaveBeenCalledOnce();
  reader.setEntry(key, { ...entry, model: "next-model" });
  expect(reader.modelSearchMayMatch("next-model")).toBe(true);
  expect(reader.modelSearchMayMatch("first-model")).toBe(false);
  expect(preparations).toHaveBeenCalledTimes(2);
  for (const alias of ["first-scope", "second-scope", "first-scope"]) {
    const registry = createEmptyPluginRegistry();
    registry.providers.push({
      pluginId: "fixture",
      source: "fixture.ts",
      provider: {
        id: "fixture",
        label: "Fixture",
        auth: [],
        normalizeModelId: ({ modelId }) => (modelId === "next-model" ? alias : modelId),
      },
    });
    withPluginRuntimeRegistryScope(registry, () => {
      expect(reader.modelSearchMayMatch(alias)).toBe(true);
      expect(reader.modelSearchMayMatch("other-scope")).toBe(false);
      expect(reader.modelSearchMayMatch("late-runtime")).toBe(false);
      const scans = preparations.mock.calls.length;
      const supports = vi.fn(() => ({ supported: true as const }));
      registerAgentHarness({
        id: "late-runtime",
        label: "Late runtime",
        supports,
        runAttempt: () => {
          throw new Error("Search must not execute a turn");
        },
      });
      expect(params.getModelFacts!(key).thinkingProjection.agentRuntime.id).toBe("late-runtime");
      supports.mockClear();
      expect(reader.modelSearchMayMatch("late-runtime")).toBe(true);
      expect(supports).not.toHaveBeenCalled();
      expect(preparations).toHaveBeenCalledTimes(scans);
    });
  }
});

test("native models and prepared runtime labels outside the catalog retain their matches", () => {
  using policies = vi.spyOn(harnessPolicy, "resolveAgentHarnessPolicy");
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
  const { params } = searchFixture(
    [[key, entry]],
    {
      cfg,
      modelCatalog: [],
      projectActiveRun: () => ({ active: false }),
    },
    () => ({ preparedRuntimeOwnership: ownership, preparedAcpMeta: acp }),
  );
  const getModelFacts = vi.fn(params.getModelFacts!);
  params.getModelFacts = getModelFacts;
  const assertSearch = (search: string, factReads: number) => {
    params.opts = { search };
    const expected = eagerSearch(params, key, entry);
    getModelFacts.mockClear();
    expect(searchKeys(params), search).toEqual(expected ? [key] : []);
    expect(getModelFacts.mock.calls.length, search).toBe(factReads);
    return expected;
  };
  for (const model of ["native-only-target", "different-native-target"]) {
    ownership.modelRef = { provider: "fixture-native", model };
    for (const [search, factReads] of [
      [model, 1],
      [`fixture-native/${model}`, 1],
      ["fixture-runtime", 1],
      ["running", 0],
      ["idle", 0],
      ["zz-no-match", 0],
    ] as const) {
      assertSearch(search, factReads);
    }
  }
  ownership.modelRef = undefined;
  for (const [search, factReads] of [
    ["gpt-4.1", 0],
    ["openai/gpt-4.1", 0],
    ["short", 1],
  ] as const) {
    expect(assertSearch(search, factReads), search).toBe(search !== "short");
  }
  params.projectActiveRun = () => ({ active: true });
  expect(assertSearch("running", 0)).toBe(true);
  acp.backend = "agent:fixture-runtime";
  params.opts = { search: acp.backend };
  expect(searchKeys(params)).toEqual([key]);
  expect(policies).not.toHaveBeenCalled();
});

// The original eager predicate is the oracle for query gates and per-call memo keys.
function eagerSearchFields(params: SessionListFilterParams, key: string, entry: SessionEntry) {
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
  const models: Array<string | undefined> = [];
  const modelFields = (identity: { provider?: string; model?: string }) => {
    const provider = identity.provider?.trim();
    const model = identity.model?.trim();
    models.push(provider, model, provider && model ? `${provider}/${model}` : undefined);
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
  if (!normalizeLowercaseStringOrEmpty(params.opts.search).startsWith("agent:")) {
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
  models.push(formatAgentRuntimeLabel(source.thinkingProjection.agentRuntime));
  return { fields: [...fields, ...models], models, titles };
}

function eagerSearch(params: SessionListFilterParams, key: string, entry: SessionEntry) {
  const search = normalizeLowercaseStringOrEmpty(params.opts.search);
  if (!search) {
    return true;
  }
  const { fields, titles } = eagerSearchFields(params, key, entry);
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
      displayName: choose([
        undefined,
        "Per-session controls",
        "München",
        "한국어",
        "日本語 🦞 MiXeD",
      ]),
      label: choose([undefined, "Sparse title", "Investigation"]),
      status: choose([undefined, ...persistedStatuses]),
      modelProvider: choose(providers),
      model: choose(models),
      providerOverride: choose(providers),
      modelOverride: choose(models),
      modelOverrideRouteResolution: choose([undefined, "resolved"] as const),
      modelOverrideFallbackOriginProvider: choose(providers),
      modelOverrideFallbackOriginModel: choose(models),
      goal:
        index % 3
          ? undefined
          : createSessionGoalFixture(`goal-${index}`, "Investigate sparse targets", {
              status: "paused",
              tokensUsed: 1200,
              lastStatusNote: "Waiting for review",
            }),
    },
  ]);
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
            id: choose(["openclaw", "codex", "acp"]),
            source: "implicit",
            ...(index % 2 ? { fallback: "portable-mode" } : {}),
          },
          acpMeta: undefined,
        },
      },
    ]),
  );
  const { params } = searchFixture(
    rows,
    {
      cfg: {
        agents: {
          defaults: { model: "openai/gpt-4.1" },
          entries: { main: {}, research: { model: "anthropic/claude-sonnet-4" } },
        },
      },
      getModelFacts: (key) => facts.get(key)!,
      identityNames: new Map([
        ["main", "Helpful Assistant"],
        ["research", "Research Partner"],
      ]),
      getRowContext: () => rowContext,
      projectActiveRun: (_key, entry) => ({
        active: entry.updatedAt! % 4 === 0,
        status: entry.updatedAt! % 8 ? undefined : "queued",
      }),
    },
    (key) => ({ materialized: { source: facts.get(key)! } }),
  );
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
    "openclaw",
    "codex",
    "acp",
    "Pursuing goal",
    "Goal paused (1.2k used)",
    "Waiting for review",
    "per session controls",
    "München",
    "한국어",
    "日本語",
    "🦞",
    "MIXED",
    "agent:main",
  ];
  const searches = [...vocabulary];
  // Every field the model matcher can emit must survive its vocabulary gate.
  const modelFields = rows.flatMap(([key, entry]) => eagerSearchFields(params, key, entry).models);
  for (const field of new Set(modelFields.map(normalizeLowercaseStringOrEmpty))) {
    for (const query of [field, field.slice(1), field.slice(0, -1)]) {
      if (query) {
        expect(params.modelSearchMayMatch!(query), query).toBe(true);
        searches.push(query);
      }
    }
  }
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
    expect(searchKeys(params), search).toEqual(expected);
  }
});
