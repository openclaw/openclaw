import { expect } from "vitest";
import { upsertSessionEntryCore } from "./session-accessor.sqlite-entry.js";
import { appendTranscriptEventSnapshotSync } from "./session-accessor.sqlite-transcript-write.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

export async function createLegacyUnsequencedTurnFixture(storePath: string) {
  const scope = {
    agentId: "main",
    sessionId: "session-legacy-unsequenced-turn",
    sessionKey: "agent:main:legacy-unsequenced-turn",
    storePath,
  };
  await upsertSessionEntryCore(scope, {
    lifecycleRevision: "legacy-unsequenced-revision",
    sessionId: scope.sessionId,
    updatedAt: 10,
  });
  await persistSessionTranscriptTurn(scope, {
    messages: [
      transcriptMessage("legacy-unsequenced-root", null, {
        role: "user",
        content: "canonical root",
      }),
    ],
    updateMode: "none",
  });
  // Keep the legacy projection dirty until the turn captures its committed cursors.
  let projectionNeedsReconcile = false;
  expect(
    appendTranscriptEventSnapshotSync(
      scope,
      {
        id: "legacy-unsequenced-child",
        parentId: "legacy-unsequenced-root",
        message: { role: "assistant", content: "legacy raw event" },
      },
      {},
      {
        scheduleProjectionReconcile: false,
        onProjectionReconcileNeeded: () => {
          projectionNeedsReconcile = true;
        },
      },
    ),
  ).toMatchObject({ ok: true, value: { result: { appended: true } } });
  expect(projectionNeedsReconcile).toBe(true);
  return scope;
}
