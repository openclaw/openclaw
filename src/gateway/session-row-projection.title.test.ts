import { expect, it } from "vitest";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { sessionTitleRequests } from "./session-title-state.js";

it("samples title pending from the exact live owner without rematerializing stored rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = { agents: { entries: { main: {} } } };
    const key = "agent:main:dashboard:title";
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: key },
      { sessionId: "title", updatedAt: 1 },
    );
    const projection = await createSessionRowProjection({ cfg });
    await projection.ensureMaterialized();
    const record = projection.capture({ agentId: "main", key })!;
    const target = { storePath: record.storeTarget.storePath, sessionKey: key, sessionId: "title" };
    const generation = createDeferredCore<boolean>();
    const snapshot = () => projection.snapshot({ agentId: "main", key }).row;
    const before = projection.materializedCount;
    expect(snapshot()?.titlePending).toBe(false);
    const request = sessionTitleRequests.run(target, () => generation.promise);
    try {
      expect(snapshot()?.titlePending).toBe(true);
      expect(record.entry).not.toHaveProperty("titlePending");
      expect(projection.materializedCount).toBe(before);
    } finally {
      generation.resolve(false);
      await request;
      expect(snapshot()?.titlePending).toBe(false);
      projection.dispose();
    }
  });
});
