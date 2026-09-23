import { expect, it } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";

it("benchmarks 10,000 keyed publications over 4,428 resident session rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const liveRows = 2_300;
    const totalRows = 4_428;
    for (let index = 0; index < totalRows; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:benchmark-${index}` },
        {
          sessionId: `benchmark-${index}`,
          updatedAt: 1,
          ...(index >= liveRows ? { archivedAt: 1 } : {}),
        },
      );
    }
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    try {
      await projection.ensureMaterialized();
      const rows = projection.selectEntries();
      expect(rows).toHaveLength(totalRows);
      const storePath = rows[0]!.storeTarget.storePath;
      const changes = Array.from({ length: 10_000 }, (_, index) => ({
        agentId: "main",
        storePath,
        sessionKey: `agent:main:benchmark-${index % liveRows}`,
      }));
      const cpuMs: number[] = [];
      for (let round = 0; round < 7; round++) {
        const started = process.threadCpuUsage();
        for (const change of changes) {
          sessionChanges.emit(change);
        }
        const elapsed = process.threadCpuUsage(started);
        if (round >= 2) {
          cpuMs.push((elapsed.user + elapsed.system) / 1_000);
        }
        expect(projection.dirtyRowCount).toBe(liveRows);
        await projection.ensureMaterialized();
      }
      expect(projection.findBySessionId({ sessionId: "benchmark-0" })).toHaveLength(1);
      expect(
        projection.snapshot({ agentId: "main", key: changes[0]!.sessionKey }).row?.sessionId,
      ).toBe("benchmark-0");
      cpuMs.sort((a, b) => a - b);
      console.log(
        JSON.stringify({
          totalRows,
          liveRows,
          marks: changes.length,
          cpuMs,
          medianCpuMs: cpuMs[2],
        }),
      );
    } finally {
      projection.dispose();
      release();
    }
  });
});
