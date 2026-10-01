import { isDeepStrictEqual } from "node:util";
import { expect, it } from "vitest";
import type { InternalSessionEntry as SessionEntry } from "../config/sessions/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  acquireSessionRowEntry,
  create,
  readSessionRowParents,
  type Row,
} from "./session-row-projection-record.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";

const cfg = { agents: { list: [{ id: "main", default: true }] } };
const noop = () => {};
const archive = { demote: (row: Row) => row, forget: noop };

function entry(index = 0): SessionEntry {
  return {
    sessionId: `session-${index}`,
    updatedAt: 1_750_000_000_000 + index,
    lifecycleRevision: "generation-1",
    label: `Synthetic session ${index}`,
    chatType: "direct",
    visibility: "shared",
    modelProvider: "unit-test",
    model: "model",
    status: "running",
    inputTokens: index * 100,
    outputTokens: index * 10,
    totalTokens: index * 110,
    createdActor: { type: "human", source: "profile", id: "profile", label: "Synthetic user" },
  };
}

function rowFor(storedEntry: SessionEntry): Row {
  return {
    ...create({
      key: `agent:main:${storedEntry.sessionId}`,
      agentId: "main",
      storeTarget: { agentId: "main", storePath: "/synthetic/sessions.sqlite" },
    }),
    storedEntry,
    entry: storedEntry,
  };
}

it("preserves deep change detection for entry metadata and unordered parent membership", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = buildSessionListRowMetadataContext({ now: 1 });
    const original = entry();
    const variants: Array<SessionEntry | undefined> = [
      undefined,
      original,
      structuredClone(original),
      { ...original, updatedAt: original.updatedAt + 1 },
      { ...original, sessionId: "replacement" },
      { ...original, lifecycleRevision: "generation-2" },
      {
        ...original,
        createdActor: { type: "human", source: "profile", id: "profile", label: "changed" },
      },
      { ...original, label: undefined },
      { ...original, updatedAt: Number.NaN },
      { ...original, updatedAt: 0 },
      { ...original, updatedAt: -0 },
      { ...original, parentSessionKey: "agent:main:parent", spawnedBy: "agent:main:requester" },
    ];
    for (const previous of variants) {
      for (const storedEntry of variants) {
        if (!storedEntry) {
          continue;
        }
        const row = { ...rowFor(original), storedEntry: previous, entry: previous };
        const parents = readSessionRowParents(row, storedEntry, cfg, context);
        for (const oldParents of [
          new Set<string>(),
          new Set(parents),
          new Set([...parents].toReversed()),
          new Set(["logical:main\0agent:main:other"]),
          new Set([...parents, "logical:main\0agent:main:other"]),
        ]) {
          row.parents = oldParents;
          const changed = !isDeepStrictEqual([storedEntry, parents], [previous, oldParents]);
          const marked: Row[] = [];
          const next = acquireSessionRowEntry({
            row,
            storedEntry,
            cfg,
            context,
            remove: noop,
            put: noop,
            markRelated: (related) => marked.push(related),
            archive,
          });
          expect(marked).toEqual(changed ? [row, next] : []);
          expect(next?.storedEntry).toBe(storedEntry);
          expect(next?.parents).toEqual(parents);
        }
      }
    }
  });
});

it("benchmarks repeated acquisition over 4,428 synthetic session rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const context = buildSessionListRowMetadataContext({ now: 1 });
    for (const scenario of ["cached", "equal-clone", "updatedAt", "nested-same-time"] as const) {
      let marked = 0;
      let acquired = 0;
      const inputs = Array.from({ length: 4_428 }, (_, index) => {
        const previous = entry(index);
        const row = rowFor(previous);
        const storedEntry = scenario === "cached" ? previous : structuredClone(previous);
        if (scenario === "updatedAt") {
          storedEntry.updatedAt++;
        } else if (scenario === "nested-same-time") {
          storedEntry.createdActor = {
            type: "human",
            source: "profile",
            id: "profile",
            label: "changed",
          };
        }
        return {
          row,
          storedEntry,
          cfg,
          context,
          remove: noop,
          put: () => acquired++,
          markRelated: () => marked++,
          archive,
        };
      });
      const cpuNsPerCall: number[] = [];
      for (let round = 0; round < 7; round++) {
        const start = process.threadCpuUsage();
        for (let pass = 0; pass < 4; pass++) {
          for (const input of inputs) {
            acquireSessionRowEntry(input);
          }
        }
        const elapsed = process.threadCpuUsage(start);
        if (round >= 2) {
          cpuNsPerCall.push(((elapsed.user + elapsed.system) * 1_000) / (inputs.length * 4));
        }
      }
      const calls = inputs.length * 4 * 7;
      expect(acquired).toBe(calls);
      expect(marked).toBe(scenario === "cached" || scenario === "equal-clone" ? 0 : calls * 2);
      cpuNsPerCall.sort((a, b) => a - b);
      console.log(
        JSON.stringify({ scenario, rows: inputs.length, medianCpuNsPerCall: cpuNsPerCall[2] }),
      );
    }
  });
});
