import { expect, it } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import type { CronJob } from "../cron/types.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  invalidateSessionAutomationIndex,
  registerSessionAutomationSource,
} from "./session-automation-index.js";
import { ready } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";

it("rebuilds only changed automation bindings and preserves complete unrelated rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    const keys = ["agent:main:bound", "agent:main:next", "agent:main:parent", "agent:main:other"];
    for (const [index, sessionKey] of keys.entries()) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey },
        {
          sessionId: `session-${index}`,
          updatedAt: 1,
          ...(index === 0 ? { parentSessionKey: keys[2] } : {}),
        },
      );
    }
    const jobs: CronJob[] = [];
    registerSessionAutomationSource({ getJobs: () => jobs, getDefaultAgentId: () => "main" });
    const projection = await createSessionRowProjection({ cfg });
    const snapshot = () =>
      projection
        .selectEntries()
        .filter(ready)
        .map((row) => projection.present(row, { now: 1 }));
    try {
      await projection.ensureMaterialized();
      const before = snapshot();
      let count = projection.materializedCount;
      invalidateSessionAutomationIndex();
      await projection.ensureMaterialized();
      expect(projection.materializedCount - count).toBe(0);
      expect(snapshot()).toEqual(before);

      const binding = {
        id: "binding",
        enabled: true,
        sessionTarget: `session:${keys[0]}`,
      } as CronJob;
      jobs.push(binding);
      invalidateSessionAutomationIndex();
      await projection.ensureMaterialized();
      expect(projection.materializedCount - count).toBe(1);
      const bound = snapshot();
      expect(bound).toEqual(
        before.map((row) =>
          row.key === keys[0] ? Object.assign({}, row, { hasAutomation: true }) : row,
        ),
      );

      count = projection.materializedCount;
      binding.sessionTarget = `session:${keys[1]}`;
      invalidateSessionAutomationIndex();
      await projection.ensureMaterialized();
      expect(projection.materializedCount - count).toBe(2);
      expect(snapshot()).toEqual(
        before.map((row) =>
          row.key === keys[1] ? Object.assign({}, row, { hasAutomation: true }) : row,
        ),
      );

      // A real store publication still rebuilds its resident rows.
      count = projection.materializedCount;
      sessionChanges.emit({ all: true, scope: "stores" });
      await projection.ensureMaterialized();
      expect(projection.materializedCount - count).toBe(keys.length);
    } finally {
      projection.dispose();
      registerSessionAutomationSource(null);
    }
  });
});

it("keeps automation aliases scoped to their logical agent in a shared store", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const storePath = `${stateDir}/shared-sessions.json`;
    const cfg = {
      session: { store: storePath, scope: "global" as const },
      agents: { list: [{ id: "main", default: true }, { id: "work" }] },
    };
    for (const agentId of ["main", "work"]) {
      replaceSessionEntrySync(
        { agentId, storePath, sessionKey: "global" },
        { sessionId: `${agentId}-global`, updatedAt: 1 },
      );
    }
    const binding = { id: "binding", enabled: true, sessionTarget: "main" } as CronJob;
    const jobs = [binding];
    registerSessionAutomationSource({ getJobs: () => jobs, getDefaultAgentId: () => "main" });
    const projection = await createSessionRowProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      const work = projection.describe({ agentId: "work", key: "global", storePath });
      const count = projection.materializedCount;
      binding.enabled = false;
      invalidateSessionAutomationIndex();
      await projection.ensureMaterialized();
      expect(projection.materializedCount - count).toBe(1);
      expect(projection.describe({ agentId: "work", key: "global", storePath })).toBe(work);
      expect(
        projection.snapshot({ agentId: "main", key: "global", storePath }).row?.hasAutomation,
      ).toBeUndefined();
    } finally {
      projection.dispose();
      registerSessionAutomationSource(null);
    }
  });
});
