import path from "node:path";
import { afterAll, expect, it } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.sqlite-entry.js";
import { forkSessionEntryFromParentTargetWithPatch } from "./session-accessor.sqlite-parent-session.js";
import { readTranscriptEventAtSeqInTransaction } from "./session-accessor.sqlite-read.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-parent-fork-worker-");

it("forks 512 MiB historical bodies within the production worker heap and confirms the copy", async () => {
  const storePath = path.join(sessionDirs.make(), "large.sqlite");
  const parentKey = "agent:main:large-parent";
  const childKey = "agent:main:large-child";
  const parentScope = { agentId: "main", sessionKey: parentKey, storePath };
  await replaceSessionEntry(parentScope, {
    sessionId: "large-parent",
    updatedAt: 1,
  });
  const count = 8192;
  const content = "x".repeat(64 * 1024);
  function* events() {
    yield { type: "session", version: 3, id: "large-parent", timestamp: "2026-09-15T00:00:00Z" };
    for (let index = 0; index < count; index++) {
      yield {
        type: "message",
        id: "event-" + index,
        parentId: index === 0 ? null : "event-" + (index - 1),
        message: { role: "assistant", content, usage: { input: 10, output: 10 } },
      };
    }
  }
  runOpenClawAgentWriteTransaction(
    (database) => {
      appendTranscriptEventsInTransaction(
        database,
        { agentId: "main", path: storePath, sessionKey: parentKey, sessionId: "large-parent" },
        events(),
      );
    },
    { agentId: "main", path: storePath },
  );
  const parent = loadSessionEntry(parentScope);
  const result = await forkSessionEntryFromParentTargetWithPatch({
    agentId: "main",
    storePath,
    parentTarget: { canonicalKey: parentKey, storeKeys: [parentKey] },
    sessionTarget: { canonicalKey: childKey, storeKeys: [childKey] },
    fallbackEntry: { sessionId: "", updatedAt: 1 },
  });
  expect(result.status).toBe("forked");
  if (result.status !== "forked") {
    throw new Error("expected fork");
  }
  const database = openOpenClawAgentDatabase({ agentId: "main", path: storePath });
  expect(
    database.db
      .prepare("SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?")
      .get(result.fork.sessionId)?.count,
  ).toBe(count + 1);
  expect(
    readTranscriptEventAtSeqInTransaction(database, result.fork.sessionId, 0)?.event,
  ).toMatchObject({
    inheritedThrough: ["event-" + (count - 1)],
  });
  expect(result.decision).toMatchObject({ status: "fork", parentTokens: 20 });
  for (const seq of [1, count]) {
    expect(
      readTranscriptEventAtSeqInTransaction(database, result.fork.sessionId, seq)?.event,
    ).toMatchObject({
      id: "event-" + (seq - 1),
      message: { role: "assistant", content, usage: { input: 10, output: 10 } },
    });
  }
  expect(loadSessionEntry(parentScope)).toEqual(parent);
});
