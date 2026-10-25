import { expect, it, vi } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import type { SessionListFilteredEntries } from "./session-list-filters.js";
import type { SessionListModelFactsLookup } from "./session-list-target.js";
import { create, identity, selectionRow } from "./session-row-projection-record.js";
import { createSessionRowSelection } from "./session-row-selection.js";
import { selectSessionEntries } from "./session-utils-list.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

const cfg = { agents: { entries: { main: {} } } };
const storeTarget = { agentId: "main", storePath: "/synthetic/list-partitions.sqlite" };
const scope = {
  path: storeTarget.storePath,
  paths: new Map([[storeTarget.storePath, 0]]),
  ownerAgentIds: new Set(["main"]),
  agentId: undefined,
  configuredAgentIds: undefined,
};
const context = buildSessionListRowMetadataContext({
  now: 10_000,
  userProfileIdentityById: new Map(
    ["profile-a", "profile-b"].map((profileId) => [
      profileId,
      {
        kind: "resolved" as const,
        profileId,
        label: profileId,
        avatarUrl: "/synthetic/avatar",
        hasUploadedAvatar: false,
      },
    ]),
  ),
});
function row(index: number, fields: Partial<SessionEntry> = {}) {
  const key = `agent:main:partition-${index}`;
  const record = create(
    { key, agentId: "main", storeTarget },
    {
      sessionId: key,
      updatedAt: index,
      ...fields,
    },
  );
  record.entry = record.storedEntry;
  return selectionRow(record)!;
}

it("filters only the changed key and ignores unchanged selection publications", () => {
  const selection = createSessionRowSelection(cfg, scope, false, () => context);
  const rows = Array.from({ length: 1200 }, (_, index) => row(index));
  for (const target of rows) {
    selection.add(target);
  }
  const retained = new WeakMap<object, SessionListFilteredEntries>();
  const entryFilter = vi.fn(() => true);
  const read = () => {
    const prepared = selection.read("updatedAt");
    return selectSessionEntries({
      ...prepared,
      cfg,
      getTarget: prepared.get,
      getRowContext: () => context,
      now: 10_000,
      opts: { limit: 3, offset: 4 },
      entryFilter,
      retained,
    });
  };
  expect(read().entries.map(([key]) => key)).toEqual(
    [1195, 1194, 1193].map((index) => rows[index]!.key),
  );
  entryFilter.mockClear();
  selection.add({ ...rows[1199]! });
  read();
  expect(entryFilter).not.toHaveBeenCalled();
  selection.add(row(0, { updatedAt: 2000 }));
  expect(read().entries.map(([key]) => key)).toEqual(
    [1196, 1195, 1194].map((index) => rows[index]!.key),
  );
  expect(entryFilter).toHaveBeenCalledTimes(1);
});

it("matches fresh selection across churn, archive toggles, filters, and page windows", () => {
  const modelFacts: ReturnType<SessionListModelFactsLookup> = {
    selectedModel: { provider: "openai", model: "synthetic", storedOverrideSource: null },
    rowModelIdentity: { provider: "openai", model: "synthetic" },
    thinkingProjection: {
      acpMeta: undefined,
      agentRuntime: { id: "openclaw", source: "implicit" },
    },
  };
  const selection = createSessionRowSelection(cfg, scope, false, () => context);
  const targets = new Map(Array.from({ length: 96 }, (_, index) => [index, row(index)]));
  for (const target of targets.values()) {
    selection.add(target);
  }
  const queries = [
    { opts: { limit: 4 } },
    { opts: { limit: 3, offset: 7, archived: "all" as const, sortBy: "activity" as const } },
    { opts: { limit: 2, archived: true, creatorId: "profile-a" } },
    { opts: { limit: 3, archived: "all" as const, search: "agent:main:partition-1" } },
    {
      opts: { limit: 5, archived: "all" as const },
      involvingActorId: "profile-a",
      ownerFirstActorId: "profile-a",
    },
  ].map((query) =>
    Object.assign(query, { retained: new WeakMap<object, SessionListFilteredEntries>() }),
  );
  const read = (owner: typeof selection, query: (typeof queries)[number], cached: boolean) => {
    const prepared = owner.read(query.opts.sortBy ?? "updatedAt");
    return selectSessionEntries({
      ...prepared,
      ...query,
      retained: cached ? query.retained : undefined,
      cfg,
      getTarget: prepared.get,
      getRowContext: () => context,
      now: 10_000,
      getModelFacts: () => modelFacts,
    });
  };
  let seed = 203;
  const random = (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
  for (let step = 0; step < 160; step++) {
    const fresh = createSessionRowSelection(cfg, scope, false, () => context);
    for (const target of targets.values()) {
      fresh.add(target);
    }
    for (const query of queries) {
      expect(read(selection, query, true), `step ${step}: ${JSON.stringify(query.opts)}`).toEqual(
        read(fresh, query, false),
      );
    }
    // Some consumers lag beyond a partition journal's bound; others read every change.
    for (let change = 0; change < (step % 13 === 0 ? 70 : 1); change++) {
      const index = step % 13 === 0 ? 0 : random(96);
      if (random(5) === 0) {
        const previous = targets.get(index);
        if (previous) {
          selection.change({
            kind: "row",
            id: identity(previous),
            key: previous.key,
            agentId: previous.agentId,
            row: undefined,
          });
          targets.delete(index);
        }
      } else {
        const id = random(2) ? "profile-a" : "profile-b";
        const target = row(index, {
          updatedAt: random(20),
          createdAt: random(10),
          lastInteractionAt: random(30),
          archivedAt: random(3) === 0 ? 1 : undefined,
          createdActor: { type: "human", source: "profile", id },
          profileInvolvement: {
            key: `involvement-${index}`,
            profiles: { [id]: { updatedAt: step, hidden: random(2) === 0 } },
          },
        });
        selection.add(target);
        targets.set(index, target);
      }
    }
  }
});
