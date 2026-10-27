import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { expect, test, vi } from "vitest";
import { SessionRunStatusSchema } from "../../packages/gateway-protocol/src/schema/sessions-row.js";
import { resolveSessionModelIdentityRef } from "../agents/session-model-ref.js";
import { buildSubagentRunReadIndexFromRuns } from "../agents/subagents/registry/subagent-registry-queries.js";
import { isTerminalSessionStatus, type SessionEntry } from "../config/sessions/types.js";
import { formatAgentRuntimeLabel } from "../shared/agent-runtime-display.js";
import { formatGoalSummary } from "../shared/session-goal-display.js";
import { isSessionRunStateActive } from "../shared/session-run-state.js";
import { normalizeSessionSearchText } from "../shared/session-search-text.js";
import { filterSessionEntries, type SessionListFilterParams } from "./session-list-filters.js";
import {
  readSessionListSelectionFacts,
  type SessionListModelFactsLookup,
} from "./session-list-target.js";
import {
  projectGatewaySessionActiveRun,
  projectGatewaySessionRunState,
  resolveGatewaySessionDisplayName,
  resolveGatewaySessionKind,
  resolveGatewaySessionGoal,
} from "./session-utils-display.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

test("non-status searches do not project run state for every static miss", () => {
  const now = 1_800_000_000_000;
  const rowContext = buildSessionListRowMetadataContext({ now });
  const display = vi.spyOn(rowContext.subagentRuns, "getDisplaySubagentRun");
  const projectActiveRun = vi.fn(() => ({ active: false }));
  const rows = Array.from({ length: 40 }, (_, index): [string, SessionEntry] => [
    `agent:main:thread-${index}`,
    { sessionId: `session-${index}`, updatedAt: index, modelProvider: "openai", model: "gpt-4.1" },
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
  const params: SessionListFilterParams = {
    cfg: { agents: { entries: { main: {} } } },
    opts: { search: "zz-no-match" },
    now,
    entries: () => rows,
    getTarget: (key) => targets.get(key),
    getModelFacts: () => ({
      selectedModel: { provider: "openai", model: "gpt-4.1", storedOverrideSource: null },
      rowModelIdentity: { provider: "openai", model: "gpt-4.1" },
      thinkingProjection: {
        agentRuntime: { id: "openclaw", source: "implicit" },
        acpMeta: undefined,
      },
    }),
    configuredAgentIds: new Set(["main"]),
    getRowContext: () => rowContext,
    involvementKeys: () => new Set(),
    projectActiveRun,
  };
  expect(filterSessionEntries(params).entries).toEqual([]);
  expect(projectActiveRun).not.toHaveBeenCalled();
  expect(display.mock.calls.length).toBeLessThanOrEqual(rows.length);
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
    rows.map(([key]): [string, ReturnType<SessionListModelFactsLookup>] => [
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
    "openclaw",
    "codex",
    "acp",
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
