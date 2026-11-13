import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createQueueCase } from "./queue.case.test-support.js";
import {
  createQueueTestRun as createRun,
  installQueueRuntimeErrorSilencer,
} from "./queue.test-helpers.js";
import { clearFollowupQueue } from "./queue/state.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-overflow-naming-");
installQueueRuntimeErrorSilencer();

it("notifies overflow source observers with only the committed summary and its media", async () => {
  const storePath = path.join(sessionDirs.make(), "sessions.json");
  const sessionKey = "agent:agent:main";
  const sessionId = "summary-session";
  const q = createQueueCase({ mode: "followup", cap: 1 });
  const observed = vi.fn();
  await replaceSessionEntry({ storePath, sessionKey }, { sessionId, updatedAt: Date.now() });
  const source = createUserTurnTranscriptRecorder({
    input: {
      text: "Private original request",
      media: [{ url: "media://inbound/private-upload", contentType: "text/plain" }],
    },
    target: createTestUserTurnTranscriptTarget({
      storePath,
      sessionKey,
      sessionId,
      agentId: "agent",
    }),
    onApprovedMessagePersisted: observed,
  });
  const first = createRun({ prompt: "Private original request" });
  first.summaryLine = "A summarized task";
  first.userTurnTranscriptRecorder = source;
  first.run.sessionId = sessionId;
  first.run.sessionKey = sessionKey;
  first.run.config = { session: { store: storePath } };
  const second = createRun({ prompt: "Next task" });
  second.run = first.run;
  q.add(first);
  q.add(second);
  try {
    q.start(async (run) => {
      q.calls.push(run);
      q.done.resolve();
    });
    await q.done.promise;
    const aggregate = q.calls[0]?.userTurnTranscriptRecorder;
    expect(aggregate).toBeDefined();
    const persisted = await aggregate?.persistFallback();
    expect(persisted?.appended).toBe(true);
    expect(observed).toHaveBeenCalledOnce();
    const message = observed.mock.calls[0]?.[0];
    expect(message?.content).toContain("A summarized task");
    expect(message?.content).not.toContain("Private original request");
    expect(message?.["__openclaw"]?.media).toEqual([]);
  } finally {
    clearFollowupQueue(q.key);
  }
});
