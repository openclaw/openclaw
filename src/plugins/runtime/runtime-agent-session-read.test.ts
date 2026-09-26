import { expect, it } from "vitest";
import { patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createRuntimeAgent } from "./runtime-agent.js";

it("reads exact lifecycle identity on the worker and fences a retired caller", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const getSessionEntryAsync = createRuntimeAgent().session.getSessionEntryAsync;
    if (!getSessionEntryAsync) {
      throw new Error("Missing asynchronous session reader");
    }
    const scope = { agentId: "main", sessionKey: "agent:main:async-identity" };
    const seed = async (lifecycleRevision: string) => {
      const entry = { sessionId: "same-id", updatedAt: 1, lifecycleRevision };
      await patchSessionEntryCore(scope, () => entry, {
        fallbackEntry: entry,
        replaceEntry: true,
        skipMaintenance: true,
      });
    };
    await seed("first");
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("retired reader");
      }
    };
    const sql = observeMainThreadSql();
    try {
      expect(await getSessionEntryAsync({ ...scope, assertCurrent })).toMatchObject({
        sessionId: "same-id",
        lifecycleRevision: "first",
      });
      sql.expectIdle();
    } finally {
      sql.restore();
    }
    await seed("second");
    expect(await getSessionEntryAsync({ ...scope, assertCurrent })).toMatchObject({
      sessionId: "same-id",
      lifecycleRevision: "second",
    });
    const pending = getSessionEntryAsync({ ...scope, assertCurrent });
    current = false;
    await expect(pending).rejects.toThrow("retired reader");
  });
});
