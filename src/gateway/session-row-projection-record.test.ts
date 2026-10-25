import { isDeepStrictEqual } from "node:util";
import { expect, it, vi } from "vitest";
import { projectGatewaySessionEntry } from "../config/sessions/combined-store-gateway.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { filterSessionEntries } from "./session-list-filters.js";
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
  });
});

it("preserves deep change detection for entry metadata and unordered parent membership", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = buildSessionListRowMetadataContext({ now: 1 });
    const acquisition = { cfg, context, remove: noop, put: noop, archive };
    const variants: SessionEntry[] = [
      original,
      structuredClone(original),
      ...[original.updatedAt + 1, Number.NaN, 0, -0].map((updatedAt) =>
        Object.assign({}, original, { updatedAt }),
      ),
      { ...original, sessionId: "replacement" },
      { ...original, lifecycleRevision: "generation-2" },
      {
        ...original,
        createdActor: { type: "human", source: "profile", id: "profile", label: "changed" },
      },
      { ...original, label: undefined },
      { ...original, parentSessionKey: "agent:main:parent", spawnedBy: "agent:main:requester" },
    ];
    for (const previous of [undefined, ...variants]) {
      for (const storedEntry of variants) {
        const row = { ...records.create(target, previous), entry: previous };
        const parents = records.readSessionRowParents(row, storedEntry, cfg, context);
        for (const oldParents of [
          new Set<string>(),
          new Set(parents),
          new Set([...parents].toReversed()),
          new Set(["logical:main\0agent:main:other"]),
          new Set([...parents, "logical:main\0agent:main:other"]),
        ]) {
          row.parents = oldParents;
          const changed = !isDeepStrictEqual([storedEntry, parents], [previous, oldParents]);
          const marked: records.Row[] = [];
          const next = records.acquireSessionRowEntry({
            ...acquisition,
            row,
            rows: new Map([[records.identity(row), row]]),
            storedEntry,
            markRelated: (related) => marked.push(related),
          });
          expect(marked).toEqual(changed ? [row, next] : []);
          expect(next?.storedEntry).toBe(changed ? storedEntry : previous);
          expect(next?.entry).toBe(
            isDeepStrictEqual(previous, storedEntry) ? previous : storedEntry,
          );
          expect(next?.parents).toEqual(parents);
        }
      }
    }
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
