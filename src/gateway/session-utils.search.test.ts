import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { SessionEntry } from "../config/sessions.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import {
  filterAndSortSessionEntries,
  prepareSessionRowSelection,
  selectSessionEntries,
} from "./session-utils-list.js";

vi.mock("../agents/provider-model-normalization.runtime.js", () => ({
  normalizeProviderModelIdWithRuntime: () => undefined,
}));

const cfg = { session: { mainKey: "main" }, agents: { entries: { main: {} } } };
let projection: ReturnType<typeof createSessionRowProjectionFixture> | undefined;
beforeEach(() => setRuntimeConfigSnapshot(cfg));
afterEach(() => {
  projection?.dispose();
  projection = undefined;
  clearRuntimeConfigSnapshot();
});

function entry(id: string, updatedAt: number, fields: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: id, updatedAt, ...fields };
}

function selection(store: Record<string, SessionEntry>, now = Date.now()) {
  const owner = createSessionRowProjectionFixture({ cfg, store, agentId: "main" });
  projection = owner;
  return (opts: Parameters<typeof prepareSessionRowSelection>[1]) =>
    filterAndSortSessionEntries({ ...prepareSessionRowSelection(owner, opts), now }).map(
      ([key]) => key,
    );
}

test("search matches title punctuation and spacing before selecting the result window", () => {
  const key = "agent:main:communication";
  const select = selection({
    [key]: entry("communication", 1, { displayName: "Per-session communication controls in UI" }),
    "agent:main:unrelated": entry("unrelated", 2, { displayName: "Unrelated discussion" }),
  });
  const search = (query: string) => select({ search: query, limit: 1 });
  for (const query of [
    "per session communi",
    "per-session communication controls",
    "PER—SESSION   COMMUNICATION",
    key,
  ]) {
    expect(search(query), query).toEqual([key]);
  }
  for (const query of ["per session missing", "---", "agent main communication"]) {
    expect(search(query), query).toEqual([]);
  }
});

test.each(["München", "한국어"])("search finds both canonical forms of %s", (title) => {
  const decomposedTitle = title.normalize("NFD");
  const select = selection({
    "agent:main:composed": entry("composed", 1, { displayName: title }),
    "agent:main:decomposed": entry("decomposed", 2, { displayName: decomposedTitle }),
    "agent:main:unrelated": entry("unrelated", 3, { displayName: "Unrelated discussion" }),
  });
  for (const search of [title, decomposedTitle]) {
    expect(select({ search, limit: 2 }), search).toEqual([
      "agent:main:decomposed",
      "agent:main:composed",
    ]);
  }
});

test("sigma variants preserve permitted membership, totals and page boundaries", () => {
  const searchConfig = { agents: { entries: { main: {}, other: {} } } };
  setRuntimeConfigSnapshot(searchConfig);
  const first = "agent:main:first";
  const second = "agent:main:second";
  const denied = "agent:main:denied";
  projection = createSessionRowProjectionFixture({
    cfg: searchConfig,
    store: {
      [first]: entry("first", 3, { label: "Handoff review — ΕΛΕΓΧΟΣ" }),
      [second]: entry("second", 1, { displayName: "κόσμος" }),
      [denied]: entry("denied", 4, { label: "ΕΛΕΓΧΟΣ" }),
      "agent:other:outside": entry("outside", 5, { label: "ΕΛΕΓΧΟΣ" }),
      "agent:main:unrelated": entry("unrelated", 6, { label: "Review notes" }),
    },
  });
  const select = (search: string, offset = 0) =>
    selectSessionEntries({
      ...prepareSessionRowSelection(projection!, { search, agentId: "main", limit: 1, offset }),
      entryFilter: (key) => key !== denied,
    });
  for (const search of ["Σ", "σ", "ς", " Σ "]) {
    for (const [offset, expected] of [first, second].entries()) {
      const result = select(search, offset);
      expect(
        result.entries.map(([key]) => key),
        search,
      ).toEqual([expected]);
      expect(result, search).toMatchObject({
        totalCount: 2,
        offset,
        nextOffset: offset === 0 ? 1 : null,
        hasMore: offset === 0,
      });
    }
  }
  projection.setEntry(first, entry("first", 3, { label: "Ready" }));
  expect(select("Σ")).toMatchObject({ totalCount: 1, hasMore: false });
  expect(select("Σ").entries.map(([key]) => key)).toEqual([second]);
});

test("search reuses row owners and reads model facts only after the resolved identity misses", () => {
  const parentKey = "agent:main:parent";
  const childKey = "agent:main:subagent:child";
  const modelConfig = {
    ...cfg,
    agents: { entries: { main: { model: "openai/gpt-4.1" } } },
  };
  setRuntimeConfigSnapshot(modelConfig);
  projection = createSessionRowProjectionFixture({
    cfg: modelConfig,
    agentId: "main",
    store: {
      [parentKey]: entry("parent", 1, {
        displayName: "Investigation parent",
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4",
      }),
      [childKey]: entry("child", 2, {
        label: "Investigation child",
        parentSessionKey: parentKey,
        spawnedBy: parentKey,
      }),
    },
  });
  for (const [search, expected, factKeys] of [
    ["investigation", [childKey, parentKey], []],
    ["gpt-4.1", [childKey], [parentKey]],
    ["claude-sonnet-4", [childKey, parentKey], [childKey]],
    ["zz-no-match", [], []],
  ] as const) {
    const prepared = prepareSessionRowSelection(projection, { search });
    const getTarget = vi.fn(prepared.getTarget);
    const getModelFacts = vi.fn(prepared.getModelFacts);
    const result = filterAndSortSessionEntries({ ...prepared, getTarget, getModelFacts });
    expect(
      result.map(([key]) => key),
      search,
    ).toEqual(expected);
    expect(getTarget).toHaveBeenCalledTimes(2);
    expect(getModelFacts.mock.calls.map(([key]) => key).toSorted(), search).toEqual(
      [...factKeys].toSorted(),
    );
  }
});

test("ranks by real interaction without heartbeat or cron noise", () => {
  const now = Date.now();
  const select = selection(
    {
      "agent:main:main": entry("main", now - 10_000, { lastInteractionAt: now - 1_000 }),
      "agent:main:heartbeat-noise": entry("heartbeat-noise", now, {
        lastInteractionAt: now - 5_000,
        pinnedAt: now,
      }),
      "agent:main:background-only": entry("background-only", now + 1_000),
      "agent:main:main:heartbeat": entry("isolated-heartbeat", now + 3_000, {
        lastInteractionAt: now + 3_000,
        heartbeatIsolatedBaseSessionKey: "agent:main:main",
      }),
      "agent:main:cron:job-1:run:run-abc": entry("run-abc", now + 2_000, {
        lastInteractionAt: now + 2_000,
      }),
    },
    now,
  );
  expect(select({ requireLastInteraction: true, sortBy: "lastInteractionAt" })).toEqual([
    "agent:main:main",
    "agent:main:heartbeat-noise",
  ]);
});
