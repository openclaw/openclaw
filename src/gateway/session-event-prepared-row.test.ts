import { expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withPreparedSessionEventRow } from "./session-event-prepared-row.js";
import { retainSessionListForegroundWork } from "./session-projection-work.js";
import { createSessionRowProjection } from "./session-row-projection.js";

it("publishes without forwarding the prepared view while exact rows and ancestors are ready", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { list: [{ id: "main", default: true }] } };
    setRuntimeConfigSnapshot(cfg);
    const parentKey = "agent:main:event-parent";
    const childKey = "agent:main:event-child";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: parentKey },
      { sessionId: "parent", updatedAt: 1, archivedAt: 1 },
    );
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: childKey },
      { sessionId: "child", updatedAt: 1, archivedAt: 1, spawnedBy: parentKey },
    );
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({ cfg });
    try {
      await projection.ensureMaterialized();
      expect(projection.materializedCount).toBe(0);
      const publish = vi.fn((..._args: unknown[]) => {
        const row = projection.describe({ key: childKey, agentId: "main" });
        expect(row?.entry.sessionId).toBe("child");
        expect(
          row && projection.ancestorRows(row)?.map((ancestor) => ancestor.entry.sessionId),
        ).toEqual(["parent"]);
      });
      await withPreparedSessionEventRow(projection, childKey, "main", publish);
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish.mock.calls[0]?.length).toBe(0);
    } finally {
      projection.dispose();
      release();
    }
  });
});
