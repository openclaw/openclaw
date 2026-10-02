import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { expect, it } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { ready } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { listProjectedSessions, prepareSessionRowSelection } from "./session-utils-list.js";

function createCollectionControl() {
  return new WeakRef({});
}

it("collects superseded resident rows and their materializations after metadata refreshes", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(cfg);
    const keys = Array.from({ length: 4 }, (_, index) => `agent:main:retention-${index}`);
    const write = (key: string, revision: number) =>
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: key },
        {
          sessionId: key,
          updatedAt: revision + 1,
          label: `Revision ${revision}`,
          lastRunError: `${key}: ${"synthetic error ".repeat(2_048)}`,
        },
      );
    for (const key of keys) {
      write(key, 0);
    }
    // Optional transcript work must not borrow a row while collection is measured.
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    const retired: {
      row: WeakRef<object>;
      entry: WeakRef<object>;
      materialized: WeakRef<object>;
    }[] = [];
    const selections: WeakRef<object>[] = [];
    function captureSelections() {
      for (const opts of [{}, { agentId: "main" }, { configuredAgentsOnly: true }]) {
        for (const activeOnly of [false, true]) {
          selections.push(
            new WeakRef(prepareSessionRowSelection(projection, { ...opts, activeOnly }).entries),
          );
        }
      }
    }
    const control = createCollectionControl();
    function refreshEntries(revision: number) {
      for (const row of projection.selectEntries().filter(ready)) {
        retired.push({
          row: new WeakRef(row),
          entry: new WeakRef(row.entry),
          materialized: new WeakRef(row.materialized),
        });
        write(row.key, revision);
      }
    }
    try {
      await projection.ensureMaterialized();
      for (let revision = 1; revision <= 4; revision++) {
        refreshEntries(revision);
        await projection.ensureMaterialized();
        const result = await listProjectedSessions({
          projection,
          opts: { limit: keys.length, includePeople: true },
        });
        expect(result.sessions.map((row) => row.label)).toEqual(
          keys.map(() => `Revision ${revision}`),
        );
        captureSelections();
      }
      // A publication must release the last list even when no subsequent viewer arrives.
      refreshEntries(5);
      await projection.ensureMaterialized();
      // End the WeakRef creation job before forcing a full collection. Do not dereference
      // retired objects before collecting: doing so keeps them alive for that job.
      await nextTurn();
      queryObjects(WeakRef);
      expect(control.deref()).toBeUndefined();
      expect(retired.filter(({ row }) => row.deref())).toHaveLength(0);
      expect(retired.filter(({ entry }) => entry.deref())).toHaveLength(0);
      expect(selections.filter((selection) => selection.deref())).toHaveLength(0);
      expect(retired.filter(({ materialized }) => materialized.deref())).toHaveLength(0);
      expect(projection.selectEntries().filter(ready)).toHaveLength(keys.length);
      await listProjectedSessions({ projection, opts: {} });
      const disposedEntries = projection.selectEntries().map((row) => new WeakRef(row.entry));
      captureSelections();
      projection.dispose();
      await nextTurn();
      queryObjects(WeakRef);
      expect(disposedEntries.filter((entry) => entry.deref())).toHaveLength(0);
      expect(selections.filter((selection) => selection.deref())).toHaveLength(0);
    } finally {
      projection.dispose();
      release();
      await nextTurn();
    }
  });
});
