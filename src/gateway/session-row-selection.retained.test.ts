import { expect, it, vi } from "vitest";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/index.js";
import * as pinPolicy from "../config/sessions/session-pin-policy.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { createSessionIdentityProjection } from "./session-identity-projection.js";
import type { SessionListFilteredEntries } from "./session-list-filters.js";
import { readSessionListSelectionFacts } from "./session-list-target.js";
import { identity, type SelectionRow } from "./session-row-projection-record.js";
import { createSessionRowSelection } from "./session-row-selection.js";
import { selectSessionEntries } from "./session-utils-list.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

const now = 1_800_000_000_000;
const storePath = "/synthetic/retained.sqlite";
const outsidePath = "/synthetic/outside.sqlite";
const cfg = { agents: { entries: { main: {}, ops: {} } } };
const agents = new Set(["main", "ops"]);

function fixture() {
  const context = buildSessionListRowMetadataContext({ now });
  context.identityProjection = createSessionIdentityProjection();
  for (const id of ["ada", "bob"]) {
    context.userProfileIdentityById.set(id, {
      kind: "resolved",
      profileId: id,
      label: id,
      avatarUrl: "/synthetic/avatar",
      hasUploadedAvatar: false,
    });
  }
  const create = () =>
    createSessionRowSelection(
      cfg,
      {
        agentId: undefined,
        path: storePath,
        paths: new Map([[storePath, 0]]),
        configuredAgentIds: agents,
        ownerAgentIds: agents,
      },
      false,
      () => context,
      true,
    );
  const selection = create();
  const rows = new Map<string, SelectionRow>();
  const remove = (key: string) => {
    const previous = rows.get(key);
    if (previous) {
      selection.change({
        kind: "row",
        id: identity(previous),
        key,
        agentId: previous.agentId,
        row: undefined,
      });
      rows.delete(key);
    }
  };
  const put = (
    key: string,
    entry: SessionEntry,
    options?: { hasBoard?: boolean; path?: string },
  ) => {
    const previous = rows.get(key);
    const agentId = key.startsWith("agent:ops:") ? "ops" : "main";
    const nextPath = options?.path ?? previous?.storeTarget.storePath ?? storePath;
    const row: SelectionRow = {
      key,
      agentId,
      storeTarget: { agentId, storePath: nextPath },
      entry,
      selection: readSessionListSelectionFacts(key, entry),
      hasBoard: options?.hasBoard ?? previous?.hasBoard ?? false,
      generation:
        previous &&
        previous.storeTarget.storePath === nextPath &&
        previous.entry.sessionId === entry.sessionId &&
        previous.entry.lifecycleRevision === entry.lifecycleRevision
          ? previous.generation
          : Symbol("generation"),
    };
    if (previous && identity(previous) !== identity(row)) {
      remove(key);
    }
    rows.set(key, row);
    selection.change({ kind: "row", id: identity(row), key, agentId, row, scope: "session-entry" });
  };
  const select = (
    owner: ReturnType<typeof create>,
    opts: SessionsListParams,
    retained?: WeakMap<object, SessionListFilteredEntries>,
  ) => {
    const selected = owner.read(opts.sortBy ?? "updatedAt");
    return selectSessionEntries({
      cfg,
      opts,
      now,
      entries: selected.entries,
      entriesSorted: true,
      partitions: selected.partitions,
      retained,
      getTarget: selected.get,
      configuredAgentIds: selected.configuredAgentIds,
      getRowContext: () => context,
      userProfileIdentityById: context.userProfileIdentityById,
      involvementKeys: selected.involvementKeys,
      involvingActorId: opts.involvingMe ? "ada" : undefined,
      ownerFirstActorId: opts.ownerFirst ? "ada" : undefined,
      entryFilter: (_key, _entry, target) =>
        opts.hasBoard === undefined || target.hasBoard === opts.hasBoard,
    });
  };
  return {
    selection,
    rows,
    put,
    remove,
    select,
    fresh() {
      const result = create();
      for (const row of rows.values()) {
        result.add(row);
      }
      return result;
    },
  };
}

it("retains filtered partitions while publishing current usage and bookkeeping metadata", () => {
  const state = fixture();
  const key = "agent:main:metadata";
  const entry = { sessionId: "metadata", updatedAt: now, lastInteractionAt: now };
  state.put(key, entry);
  const retained = new WeakMap<object, SessionListFilteredEntries>();
  const opts = { archived: "all", limit: 2 } satisfies SessionsListParams;
  state.select(state.selection, opts, retained);
  const revisions = () => state.selection.read().partitions!.map((part) => part.revision);
  const before = new Set(revisions());
  const next: SessionEntry = {
    ...entry,
    activeWriterRunId: "writer-2",
    inputTokens: 100,
    outputTokens: 20,
    cacheRead: 5,
    cacheWrite: 10,
    estimatedCostUsd: 0.001,
    contextTokens: 200,
    contextTokensSource: "runtime",
    totalTokens: 120,
    totalTokensFresh: true,
    usageReport: { state: "available" },
    activitySummary: {
      version: 1,
      text: "Synthetic activity",
      updatedAt: now + 1,
      sessionId: entry.sessionId,
      generation: null,
      maxSeq: null,
      leafEntryId: null,
      coveredMessages: 0,
      totalMessages: 0,
      omittedContent: false,
    },
    pendingFinalDelivery: { kind: "transport-only", createdAt: now },
    sessionDiffBaseline: { version: 1, sessionId: entry.sessionId, root: "/synthetic", files: [] },
    sessionDiffBaselineCapture: { version: 1, captureId: "capture-2", status: "pending" },
  };
  state.put(key, next);
  expect(revisions().every((revision) => before.has(revision))).toBe(true);
  expect(state.select(state.selection, opts, retained).entries).toEqual([[key, next]]);
  state.put(key, entry);
  expect(revisions().every((revision) => before.has(revision))).toBe(true);
  expect(state.select(state.selection, opts, retained).entries).toEqual([[key, entry]]);
  state.put(key, { ...entry, updatedAt: now + 1 });
  expect(revisions().every((revision) => before.has(revision))).toBe(false);
  expect(state.select(state.selection, opts, retained)).toEqual(state.select(state.fresh(), opts));
});

it("reads only the requested page from retained ordered partitions", () => {
  const state = fixture();
  const count = 10_800;
  for (let index = 0; index < count; index++) {
    state.put(`agent:main:page-${index}`, {
      sessionId: String(index),
      updatedAt: now + index,
      pinnedAt: now + index,
      createdActor: { type: "human", source: "profile", id: index % 2 ? "bob" : "ada" },
    });
  }
  for (const opts of [
    { limit: 200, offset: 7 },
    { limit: 200, ownerFirst: true },
  ]) {
    const retained = new WeakMap<object, SessionListFilteredEntries>();
    state.select(state.selection, opts, retained);
    const reads = { entries: 0, ownerEntries: 0 };
    for (const partition of state.selection.read().partitions!) {
      const part = retained.get(partition.revision)!;
      for (const field of ["entries", "ownerEntries"] as const) {
        part[field] = new Proxy(part[field], {
          get(target, key, receiver) {
            if (typeof key === "string" && /^\d+$/.test(key)) {
              reads[field]++;
            }
            return Reflect.get(target, key, receiver);
          },
        });
      }
    }
    using pins = vi.spyOn(pinPolicy, "isPinnableSessionEntry");
    const result = state.select(state.selection, opts, retained);
    const shared = Array.from({ length: opts.limit }, (_, i) => count - 1 - (opts.offset ?? 0) - i);
    const owned = opts.ownerFirst ? Array.from({ length: 60 }, (_, i) => count - 2 - i * 2) : [];
    expect(result.entries.map(([, entry]) => entry.sessionId)).toEqual(
      [...owned, ...shared.filter((index) => !owned.includes(index))].map(String),
    );
    expect(result).toMatchObject({
      totalCount: count,
      ownerCount: owned.length,
      hasMore: true,
      nextOffset: (opts.offset ?? 0) + opts.limit,
    });
    expect(result.ownerFacet.map((owner) => owner.id)).toEqual(["ada", "bob"]);
    expect(reads.entries).toBeLessThanOrEqual((opts.offset ?? 0) + opts.limit + 64);
    expect(reads.ownerEntries).toBeLessThanOrEqual(owned.length + 64);
    expect(pins).toHaveBeenCalledTimes(reads.entries + reads.ownerEntries);
  }
});

it.for([0x12e7, 0x4b91])("matches fresh selection after seeded write sequences (%i)", (seed) => {
  const state = fixture();
  let randomState = seed;
  const random = (limit: number) => {
    randomState = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
    return (randomState >>> 8) % limit;
  };
  const keys = Array.from({ length: 96 }, (_, index) =>
    index === 0
      ? "global"
      : index === 1
        ? "unknown"
        : index === 2
          ? "agent:main:cron:fixture"
          : `agent:${index % 3 === 0 ? "ops" : "main"}:row-${index}`,
  );
  const initial = (key: string, index: number): SessionEntry => ({
    sessionId: `${key}-session`,
    updatedAt: now - index * 60_000,
    createdAt: now - index * 60_000,
    lastInteractionAt: index % 4 ? now - index * 60_000 : undefined,
    label: index % 2 ? "alpha" : "beta",
    category: index % 2 ? "work" : "personal",
    projectId: index % 2 ? "one" : "two",
    spawnedWorkspaceDir: index % 2 ? "/one" : "/two",
    boardFace: index % 2 ? "chat" : "dashboard",
    createdActor: { type: "human", source: "profile", id: index % 2 ? "ada" : "bob" },
    participants: [{ identity: { type: "profile", id: index % 2 ? "ada" : "bob" } }],
  });
  for (const [index, key] of keys.entries()) {
    state.put(key, initial(key, index));
  }
  const queries: SessionsListParams[] = [
    ...(["updatedAt", "lastInteractionAt", "activity"] as const).map((sortBy) => ({
      sortBy,
      limit: 1,
    })),
    ...(["updatedAt", "lastInteractionAt", "activity"] as const).flatMap((sortBy) =>
      ([false, true, "all"] as const).map((archived) => ({
        sortBy,
        archived,
        limit: 5,
        offset: 2,
      })),
    ),
    ...([
      { label: "alpha" },
      { boardFace: "dashboard" },
      { group: "work" },
      { projectId: "one" },
      { workspaceDir: "/one" },
      { requireLastInteraction: true },
      { pinned: true },
      { agentId: "ops" },
      { excludeSystem: true, excludeDock: true, excludeSubagents: true, excludeCron: true },
      { hasBoard: true },
      { creatorId: "ada", ownerFirst: true },
      { ownerId: "bob", involvingMe: true },
      { profileRelation: { profileId: "ada", relationship: "involving" } },
      { profileRelation: { profileId: "bob", relationship: "owned" } },
      { activeMinutes: 15, sortBy: "activity" },
    ] satisfies SessionsListParams[]),
  ].map((query): SessionsListParams =>
    Object.assign(
      {
        archived: "all",
        limit: 7,
        includeGlobal: true,
        includeUnknown: true,
      } satisfies SessionsListParams,
      query,
    ),
  );
  const retained = queries.map(() => new WeakMap<object, SessionListFilteredEntries>());
  const check = () => {
    const fresh = state.fresh();
    for (const [index, query] of queries.entries()) {
      expect(state.select(state.selection, query, retained[index])).toEqual(
        state.select(fresh, query),
      );
    }
    for (const profileId of ["ada", "bob"]) {
      expect([...state.selection.createdEntries(new Set([profileId]))]).toEqual([
        ...fresh.createdEntries(new Set([profileId])),
      ]);
    }
  };
  check();
  for (let step = 0; step < 72; step++) {
    const index = random(keys.length);
    const key = keys[index]!;
    const previous = state.rows.get(key);
    const entry = previous?.entry ?? initial(key, index);
    const value = random(2) === 0;
    let patch: Partial<SessionEntry> = {};
    switch (random(22)) {
      case 0:
        state.remove(key);
        break;
      case 1:
        patch = { updatedAt: now + step + 1 };
        break;
      case 2:
        patch = { lastInteractionAt: value ? now + step + 1 : undefined };
        break;
      case 3:
        patch = { lastActivityAt: value ? now + step + 1 : undefined };
        break;
      case 4:
        patch = { archivedAt: value ? 0 : undefined };
        break;
      case 5:
        patch = {
          pinnedAt: value ? now + step : undefined,
          sidebarRoot: value,
          parentSessionKey: keys[4],
        };
        break;
      case 6:
        patch = { label: value ? "alpha" : "beta" };
        break;
      case 7:
        patch = { category: value ? "work" : "personal" };
        break;
      case 8:
        patch = { projectId: value ? "one" : "two" };
        break;
      case 9:
        patch = { spawnedCwd: value ? "/one" : undefined, spawnedWorkspaceDir: "/two" };
        break;
      case 10:
        patch = { boardFace: value ? "chat" : "dashboard" };
        break;
      case 11:
        patch = {
          createdActor: value
            ? { type: "human", source: "profile", id: "ada" }
            : { type: "system", id: "fixture" },
        };
        break;
      case 12:
        patch = { owner: { actor: { type: "human", id: value ? "ada" : "bob" } } };
        break;
      case 13:
        patch = { participants: value ? [{ identity: { type: "profile", id: "ada" } }] : [] };
        break;
      case 14:
        patch = {
          profileInvolvement: { key, profiles: { ada: { hidden: value, updatedAt: now + step } } },
        };
        break;
      case 15:
        patch = { heartbeatIsolatedBaseSessionKey: value ? keys[4] : undefined };
        break;
      case 16:
        patch = {
          createdSurface: value ? "plugin-dock" : undefined,
          spawnedBy: value ? keys[4] : undefined,
        };
        break;
      case 17:
        patch = {
          sessionId: `${key}-replacement-${step}`,
          lifecycleRevision: `generation-${step}`,
        };
        break;
      case 18:
        patch = {
          inputTokens: step,
          estimatedCostUsd: step / 100,
          activeWriterRunId: `writer-${step}`,
        };
        break;
      case 19:
        patch = {
          startedAt: now + step,
          abortedLastRun: value,
          pendingFinalDelivery: value
            ? { kind: "transport-only", createdAt: now + step }
            : undefined,
        };
        break;
      case 20:
        state.put(key, entry, { hasBoard: value });
        break;
      case 21:
        state.put(key, entry, { path: value ? storePath : outsidePath });
        break;
    }
    if (Object.keys(patch).length) {
      state.put(key, { ...entry, ...patch });
    }
    check();
  }
});
