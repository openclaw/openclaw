import { expect, it, vi } from "vitest";
import { projectGatewaySessionEntry } from "../config/sessions/combined-store-gateway.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { filterSessionEntries } from "./session-list-filters.js";
import { indexSessionRow } from "./session-row-projection-identities.js";
import { createSessionRowLookup } from "./session-row-projection-materialize.js";
import * as records from "./session-row-projection-record.js";
import { createSessionRowProjectionRevisions } from "./session-row-projection-revisions.js";
import * as display from "./session-utils-display.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

const cfg = { agents: { entries: { main: {} } } };
const noop = () => {};
const archive = { demote: (row: records.Row) => row, forget: noop };

const original: SessionEntry = {
  sessionId: "session",
  updatedAt: 1_750_000_000_000,
  lifecycleRevision: "generation-1",
  label: "Synthetic session",
  createdActor: { type: "human", source: "profile", id: "profile", label: "Synthetic user" },
};
const target = {
  key: "agent:main:session",
  agentId: "main",
  storeTarget: { agentId: "main", storePath: "/synthetic/sessions.sqlite" },
};

it("shares singleton index buckets without coupling alias collisions or removals", () => {
  const indexes = {
    byStore: new Map<string, Set<string>>(),
    byAgent: new Map<string, Set<string>>(),
    byKey: new Map<string, Set<string>>(),
    byParent: new Map<string, Set<string>>(),
  };
  const first = { ...records.create(target, original), entry: original };
  first.parents.add("logical:main\0agent:main:parent");
  indexSessionRow(first, indexes);
  const buckets = Object.values(indexes).flatMap((index) => Array.from(index.values()));
  // One retained bucket per row, not one copy per lookup alias.
  expect(new Set(buckets).size).toBe(1);
  const singleton = buckets[0]!;
  const second = { ...first, key: "agent:main:other" };
  const firstId = records.identity(first);
  const secondId = records.identity(second);
  indexSessionRow(second, indexes);
  indexSessionRow(second, indexes);
  expect([...indexes.byKey.get("id:session")!]).toEqual([firstId, secondId]);
  expect([...indexes.byKey.get(`key:${first.key}`)!]).toEqual([firstId]);
  expect([...singleton]).toEqual([firstId]);
  indexSessionRow(first, indexes, true);
  expect(indexes.byKey.has(`key:${first.key}`)).toBe(false);
  expect([...indexes.byKey.get("id:session")!]).toEqual([secondId]);
  expect([...singleton]).toEqual([firstId]);
  indexSessionRow(first, indexes);
  expect([...indexes.byKey.get("id:session")!]).toEqual([secondId, firstId]);
  expect([...indexes.byKey.get(`key:${second.key}`)!]).toEqual([secondId]);
  for (const row of [second, first]) {
    indexSessionRow(row, indexes, true);
  }
  expect(Object.values(indexes).map((index) => index.size)).toEqual([0, 0, 0, 0]);
});

it("captures current published entries without preparing acquisition state", () => {
  let current: records.Row | undefined = { ...records.create(target, original), entry: original };
  const state = vi.fn(() => {
    throw new Error("Published entries do not need acquisition state");
  });
  const lookup = createSessionRowLookup({
    state,
    lookup: () => current,
    assertCurrent: noop,
    matching: () => [],
    acquireEntry: () => {
      throw new Error("Published entries do not need acquisition");
    },
    env: {},
    runInOwner: (consume) => consume(),
  });
  expect(lookup.capture(target)).toBe(current);
  const previous = current;
  current = { ...previous, entry: { ...original, visibility: "draft" } };
  expect(lookup.capture(target)).toBe(current);
  expect(lookup.capture(target)?.entry?.visibility).toBe("draft");
  current = undefined;
  expect(lookup.capture(target)).toBeUndefined();
  expect(state).not.toHaveBeenCalled();
});

it("reuses search fields across equal reads and refreshes replaced entries", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = buildSessionListRowMetadataContext({ now: 1 });
    let row: records.Row = { ...records.create(target, original), entry: original };
    const rebuild = vi.spyOn(display, "resolveGatewaySessionKind");
    const search = (query: string) =>
      filterSessionEntries({
        cfg,
        opts: { search: query },
        now: 1,
        entries: () => [[row.key, row.entry!]],
        getTarget: () => records.selectionRow(row),
        configuredAgentIds: new Set(["main"]),
        getRowContext: () => context,
        involvementKeys: () => new Set(),
      }).entries.map(([key]) => key);
    const acquire = (entry: SessionEntry) => {
      row = records.acquireSessionRowEntry({
        row,
        rows: new Map([[records.identity(row), row]]),
        storedEntry: structuredClone(entry),
        cfg,
        context,
        remove: noop,
        put: noop,
        markRelated: noop,
        archive,
      })!;
    };
    try {
      expect(search("Synthetic session")).toEqual([target.key]);
      const selection = row.selection;
      const parents = row.parents;
      acquire(original);
      expect(search("Synthetic session")).toEqual([target.key]);
      expect(rebuild).toHaveBeenCalledOnce();
      acquire({ ...original, updatedAt: original.updatedAt + 1 });
      expect(search("Synthetic session")).toEqual([target.key]);
      expect(row.selection).toBe(selection);
      expect(row.parents).toBe(parents);
      expect(rebuild).toHaveBeenCalledTimes(2);

      for (const [fields, query] of [
        [{ label: "Renamed session" }, "Renamed session"],
        [{ label: undefined, displayName: "New display title" }, "New display title"],
        [{ modelProvider: "synthetic", model: "new-model" }, "synthetic/new-model"],
      ] satisfies [Partial<SessionEntry>, string][]) {
        acquire({ ...row.entry!, ...fields });
        expect(search(query)).toEqual([target.key]);
        expect(row.parents).toBe(parents);
      }
      expect(rebuild).toHaveBeenCalledTimes(5);
    } finally {
      rebuild.mockRestore();
    }
  });
});

it("keeps accepted facts and sharing revisions when database reads return equal entries", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = buildSessionListRowMetadataContext({ now: 1 });
    const row: records.Row = { ...records.create(target, original), entry: original };
    const facts: records.PreparedSessionRowDatabaseFacts = {
      sessionKey: target.key,
      entry: original,
      hasBoard: false,
      transcriptAssistantMessage: "unknown",
      acpMeta: null,
      runtimeOwnership: null,
      runtimeOwnershipDependencies: [],
      repositoryWorkspace: null,
    };
    Object.assign(row, { retainedDatabaseFacts: facts, pendingDatabaseFacts: facts });
    const rows = new Map([[records.identity(row), row]]);
    const revisions = createSessionRowProjectionRevisions(rows, new Map());
    const sharing = revisions.sharing();
    const put = vi.fn((next: records.Row) => {
      rows.set(records.identity(next), next);
      revisions.replace(row, next);
    });
    const acquisition = {
      rows,
      cfg,
      context,
      remove: noop,
      put,
      markRelated: noop,
      archive,
    };
    const acquire = (candidate: records.Row, storedEntry: SessionEntry) =>
      records.acquireSessionRowEntry({ ...acquisition, row: candidate, storedEntry });
    const next = acquire(row, structuredClone(original));
    expect(next).toBe(row);
    expect(put).not.toHaveBeenCalled();
    expect(next?.databaseFactsRevision).toBe(0);
    expect(next?.retainedDatabaseFacts).toBe(facts);
    expect(next?.pendingDatabaseFacts).toBe(facts);
    expect(next?.sharingEntry).toBe(original);
    expect(revisions.sharing()).toBe(sharing);

    const accepted = { ...row, hasBoard: true };
    expect(acquire(accepted, structuredClone(original))).toBe(accepted);
    expect(rows.get(records.identity(row))).toBe(accepted);
    expect(put).toHaveBeenCalledOnce();
    expect(revisions.sharing()).not.toBe(sharing);

    const committed = {
      ...original,
      createdActor: { type: "human", source: "profile", id: "profile", label: "Changed user" },
    } satisfies SessionEntry;
    const deferred = acquire(
      { ...row, storedEntry: committed, sharingEntry: committed, entryAcquisitionPending: true },
      committed,
    );
    expect(deferred?.entry).toBe(committed);
    expect(deferred?.entryAcquisitionPending).toBeUndefined();

    const lineage = {
      ...original,
      parentSessionKey: "agent:main:parent",
      spawnedBy: "agent:main:requester",
    };
    const parented = acquire(row, lineage)!;
    const parents = new Set([
      "logical:main\0agent:main:requester",
      "logical:main\0agent:main:parent",
    ]);
    parented.parents = parents;
    expect(acquire(parented, structuredClone(lineage))).toBe(parented);
    expect(parented.parents).toBe(parents);
    const reparented = acquire(parented, { ...lineage, spawnedBy: undefined })!;
    expect([...reparented.parents]).toEqual(["logical:main\0agent:main:parent"]);
  });
});

it("shares unchanged lineage and copies only changed global aliases without mutating storage", () => {
  const stored = Object.freeze({
    ...original,
    parentSessionKey: "agent:main:parent",
    spawnedBy: "agent:main:requester",
  });
  expect(projectGatewaySessionEntry(cfg, stored)).toBe(stored);
  const global = { ...cfg, session: { scope: "global" as const } };
  expect(projectGatewaySessionEntry(global, stored, (key) => key)).toBe(stored);
  expect(projectGatewaySessionEntry(global, stored, () => "global")).toEqual({
    ...stored,
    parentSessionKey: "global",
    spawnedBy: "global",
  });
});
