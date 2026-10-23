import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import { projectGatewaySessionEntry } from "../config/sessions/combined-store-gateway.js";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as records from "./session-row-projection-record.js";
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
        const row = { ...records.create(target), storedEntry: previous, entry: previous };
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
            storedEntry,
            markRelated: (related) => marked.push(related),
          });
          expect(marked).toEqual(changed ? [row, next] : []);
          expect(next?.storedEntry).toBe(storedEntry);
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
