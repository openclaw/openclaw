import { expect, it } from "vitest";
import {
  appendTranscriptEvent as appendEvent,
  appendTranscriptMessage as appendMessage,
  loadSessionEntry as readEntry,
  rewindSessionToMessage as rewind,
  switchSessionBranch as switchBranch,
} from "./session-accessor.js";
import {
  agentId,
  sessionKey,
  useSessionMessageCutFixtures,
} from "./session-accessor.sqlite-message-cut.test-support.js";

const { createSession } = useSessionMessageCutFixtures();

it("tracks degraded compaction on the selected history branch", async () => {
  const { env, scope, params } = await createSession();
  const select = (leafEntryId: string) => switchBranch({ agentId, env, sessionKey, leafEntryId });
  await appendEvent(scope, {
    type: "compaction",
    id: "lossy-summary",
    parentId: "assistant-2",
    firstKeptEntryId: "user-2",
    timestamp: "2026-07-18T02:00:00.000Z",
    summary: "Partial summary",
    tokensBefore: 10,
    details: { readFiles: [], modifiedFiles: [], qualityDegraded: true },
  });
  await appendMessage(scope, {
    eventId: "after-compaction",
    parentId: "lossy-summary",
    message: { role: "assistant", content: "Compacted branch" },
  });
  await appendMessage(scope, {
    eventId: "follow-up",
    parentId: "after-compaction",
    message: { role: "user", content: "Follow-up" },
  });
  expect(readEntry(scope)?.compactionQualityDegraded).toBe(true);

  expect(await rewind(params)).toMatchObject({ status: "created" });
  expect(readEntry(scope)?.compactionQualityDegraded).toBeUndefined();

  expect(await select("follow-up")).toMatchObject({ status: "created" });
  expect(readEntry(scope)?.compactionQualityDegraded).toBe(true);

  expect(await rewind({ ...params, entryId: "follow-up" })).toMatchObject({ status: "created" });
  expect(readEntry(scope)?.compactionQualityDegraded).toBe(true);

  expect(await select("off-path-user")).toMatchObject({ status: "created" });
  expect(readEntry(scope)?.compactionQualityDegraded).toBeUndefined();
});
