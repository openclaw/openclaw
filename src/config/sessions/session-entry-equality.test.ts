import "./session-entry-patch-delivery.test-support.js";
import { expect, it } from "vitest";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { patchSessionEntryCore, replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import { createSessionCompoundWorkerFixture as fixture } from "./session-compound-worker.test-support.js";

it("patches a replaced entry whose retained fields have a different insertion order", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const identity = { sessionId: f.scope.sessionId };
    const writer = { ...identity, activeWriterRunId: "current-writer" };
    await replaceSessionEntry(f.scope, { ...identity, updatedAt: 1 });
    await replaceSessionEntry(f.scope, { ...writer, updatedAt: 1, totalTokens: 0 });
    const result = await patchSessionEntryCore(f.scope, () => ({ totalTokens: 13_357 }), {
      workerGuard: {},
    });
    expect(result).toMatchObject({ ...writer, totalTokens: 13_357, delivery: { kind: "none" } });
    expect(f.read()).toEqual(result);
  });
});
