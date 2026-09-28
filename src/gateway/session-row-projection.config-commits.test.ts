import { expect, it } from "vitest";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  assignSessionOwner,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createAgentDatabaseInspectionRefusal,
  preparePendingAgentDatabase,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions } from "./session-utils-list.js";

it("retains resident rows across projection-neutral commits and unchanged admission", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const count = Number(process.env.OPENCLAW_PROJECTION_BENCH_ROWS ?? 16);
    let cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    setRuntimeConfigSnapshot(cfg);
    for (let index = 0; index < count; index++) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:config-${index}` },
        {
          sessionId: `config-${index}`,
          updatedAt: index + 1,
        },
      );
    }
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg,
      getConfig: () => getRuntimeConfigSnapshot()!,
      modelCatalog: [],
    });
    try {
      const readmit = async () => {
        const refusal = createAgentDatabaseInspectionRefusal({
          agentId: "main",
          paths: [resolveOpenClawAgentSqlitePath({ agentId: "main" })],
          pending: true,
          reason: "Reverification",
        });
        recordAgentDatabaseAdmissions([refusal], { source: "startup" });
        await preparePendingAgentDatabase(refusal, { assertCurrent() {} }, async () => {});
      };
      await projection.ensureMaterialized();
      const measurements = [];
      const preferenceConfig: OpenClawConfig = {
        ...cfg,
        ui: { prefs: { sidebarEntries: ["sessions"] } },
      };
      for (const event of ["ui.prefs", "unchanged admission"] as const) {
        const before = projection.materializedCount;
        const started = performance.now();
        if (event === "ui.prefs") {
          cfg = preferenceConfig;
          setRuntimeConfigSnapshot(cfg);
        } else {
          await readmit();
        }
        const dirtyRows = projection.dirtyRowCount;
        const result = await listProjectedSessions({ projection, opts: { limit: 247 } });
        await projection.ensureMaterialized();
        const materializations = projection.materializedCount - before;
        measurements.push({
          event,
          count,
          dirtyRows,
          materializations,
          elapsedMs: performance.now() - started,
        });
        expect(result.totalCount).toBe(count);
        expect.soft(dirtyRows, event).toBe(0);
        expect.soft(materializations, event).toBe(0);
        expect(projection.state.cfg).toBe(cfg);
      }
      console.log(JSON.stringify(measurements));
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "agent:main:config-0" },
        {
          sessionId: "config-0",
          updatedAt: count + 1,
          archivedAt: 1,
        },
      );
      assignSessionOwner(
        { agentId: "main", sessionKey: "agent:main:config-0" },
        { owner: { type: "agent", id: "main" }, assignedBy: { type: "system", id: "test" } },
      );
      await listProjectedSessions({ projection, opts: { archived: "all", limit: 247 } });
      const beforeRename = projection.materializedCount;
      cfg = { ...cfg, agents: { entries: { main: { identity: { name: "After" } } } } };
      setRuntimeConfigSnapshot(cfg);
      const renamed = await listProjectedSessions({
        projection,
        opts: { archived: "all", limit: 247 },
      });
      expect(renamed.sessions[0]?.owner?.actor.label).toBe("After");
      expect(projection.materializedCount).toBe(beforeRename);
      await readmit();
      const retained = await listProjectedSessions({
        projection,
        opts: { archived: "all", limit: 247 },
      });
      expect(retained.sessions[0]?.owner?.actor.label).toBe("After");
      expect(projection.dirtyRowCount).toBe(0);
      expect(projection.materializedCount).toBe(beforeRename);
    } finally {
      projection.dispose();
      release();
    }
  });
});
