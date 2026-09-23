import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { expect, it, vi } from "vitest";
import { writeSessionEntry } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

it.runIf(process.env.OPENCLAW_SESSION_DIRTY_PARENT_BENCH === "1")(
  "measures a 245-row page after parent publications over 5,000 candidates",
  async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = {
        agents: {
          list: [{ id: "main", default: true }],
          defaults: { model: "unit-test/model" },
        },
      };
      const parentKey = "agent:main:parent";
      const candidates = 5_000;
      const children = 2_000;
      const samples = Number(process.env.OPENCLAW_SESSION_DIRTY_PARENT_SAMPLES ?? 100);
      expect(Number.isSafeInteger(samples) && samples > 0).toBe(true);
      runOpenClawAgentWriteTransaction(
        (database) => {
          for (let index = 0; index < candidates; index++) {
            const parent = index === 0;
            writeSessionEntry(
              database,
              parent ? parentKey : `agent:main:row-${index}`,
              {
                sessionId: parent ? "parent" : `row-${index}`,
                label: `Session ${index}`,
                updatedAt: index > 0 && index <= children ? 1_000 + index : 1,
                ...(index > 0 && index <= children ? { parentSessionKey: parentKey } : {}),
                ...(index > children ? { archivedAt: 1 } : {}),
              },
              { canonicalPreviousEntry: null, previousEntry: null },
            );
          }
        },
        { agentId: "main" },
      );
      const release = retainSessionListForegroundWork();
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);
      const projection = await createSessionRowProjection({
        cfg,
        modelCatalog: [{ provider: "unit-test", id: "model", name: "Model" }],
      });
      try {
        await projection.ensureMaterialized();
        const list = () =>
          listProjectedSessions({ projection, opts: { limit: 245, archived: "all" } });
        const golden = await list();
        expect(golden.sessions).toHaveLength(245);
        expect(golden.totalCount).toBe(candidates);
        const digest = (value: unknown) =>
          createHash("sha256").update(JSON.stringify(value)).digest("hex");
        const checksum = digest(golden);
        const normalizedChecksum = digest({ ...golden, path: "<fixture>" });
        const search = () =>
          listProjectedSessions({
            projection,
            opts: { limit: 245, archived: "all", search: "Session" },
          });
        expect(await search()).toEqual(golden);
        const cleanMs: number[] = [];
        const searchMs: number[] = [];
        const dirtyMs: number[] = [];
        const dirtyCounts: number[] = [];
        const materialized: number[] = [];
        for (let index = 0; index < samples + 5; index++) {
          const cleanStart = performance.now();
          const clean = await list();
          const cleanElapsed = performance.now() - cleanStart;
          expect(digest(clean)).toBe(checksum);
          const searchStart = performance.now();
          const searched = await search();
          const searchElapsed = performance.now() - searchStart;
          expect(digest(searched)).toBe(checksum);
          sessionChanges.emit({ agentId: "main", sessionKey: parentKey });
          const dirtyCount = projection.dirtyRowCount;
          const before = projection.materializedCount;
          const dirtyStart = performance.now();
          const dirty = await list();
          const dirtyElapsed = performance.now() - dirtyStart;
          expect(digest(dirty)).toBe(checksum);
          if (index >= 5) {
            cleanMs.push(cleanElapsed);
            searchMs.push(searchElapsed);
            dirtyMs.push(dirtyElapsed);
            dirtyCounts.push(dirtyCount);
            materialized.push(projection.materializedCount - before);
          }
        }
        const distribution = (values: number[]) => {
          const sorted = values.toSorted((a, b) => a - b);
          return {
            p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
            p99: sorted[Math.ceil(sorted.length * 0.99) - 1],
          };
        };
        console.log(
          JSON.stringify({
            candidates,
            children,
            selected: golden.sessions.length,
            samples,
            checksum,
            normalizedChecksum,
            cleanMs: distribution(cleanMs),
            searchMs: distribution(searchMs),
            dirtyMs: distribution(dirtyMs),
            dirtyRows: distribution(dirtyCounts),
            materializedRows: distribution(materialized),
          }),
        );
      } finally {
        projection.dispose();
        clock.mockRestore();
        release();
      }
    });
  },
  180_000,
);
