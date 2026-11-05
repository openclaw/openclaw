import path from "node:path";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { drainStoreWriterQueuesForTest } from "../../../test/helpers/promise.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  onAgentRuntimeEvent,
  type AgentEventRuntimePayload as Event,
} from "../../infra/agent-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission-state.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createWorkerLiveEventReceiver } from "./live-events.js";
import { LOCAL, RUN, ID, msg, captureWorkerTranscriptSource } from "./live-events.test-support.js";
import * as turnCapabilities from "./placement-turn-claim-events.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-worker-live-media-");
let source: Awaited<ReturnType<typeof captureWorkerTranscriptSource>>;
let rx: ReturnType<typeof createWorkerLiveEventReceiver>;
let events: Event[];
let unsubscribe: () => void;
const readAckedSeq = () => 0;
const deltas = () => events.map((event) => event.data.delta);
const apply = (request: ReturnType<typeof msg>) =>
  rx.apply({ identity: ID, request, source, readAckedSeq });
beforeEach(async () => {
  const storePath = path.join(sessionDirs.make(), "agents", "main", "sessions", "sessions.json");
  const target = { ...LOCAL, storePath };
  await upsertSessionEntryCore(target, {
    sessionId: LOCAL.sessionId,
    updatedAt: 10,
    lifecycleRevision: "live-media-10",
    activeWriterRunId: RUN,
  });
  source = await captureWorkerTranscriptSource(target);
  setRuntimeConfigSnapshot({ session: { store: storePath } });
  rx = createWorkerLiveEventReceiver();
  events = [];
  unsubscribe = onAgentRuntimeEvent((event) => events.push(event));
});
afterEach(async () => {
  unsubscribe();
  rx.clear();
  await source.release();
  clearRuntimeConfigSnapshot();
  await drainStoreWriterQueuesForTest(SQLITE_SESSION_WRITER_QUEUES, "live media test cleanup");
  closeOpenClawAgentDatabasesForTest();
});

it.each([false, true])(
  "prepares buffered reply media before publishing and fences revoked readers (%s)",
  async (revoke) => {
    const mediaUrl = "/managed/reply.txt";
    const reply = { text: "ready", mediaUrl, mediaUrls: [mediaUrl] };
    const started = createDeferredCore();
    const prepared = createDeferredCore<ReplyPayload>();
    using reader = vi
      .spyOn(turnCapabilities, "captureWorkerReplyMedia")
      .mockReturnValue(async () => {
        started.resolve();
        return prepared.promise;
      });
    await expect(
      apply({
        ...msg(2),
        event: {
          kind: "assistant",
          payload: { text: "MEDIA:./reply.txt", delta: "", mediaUrls: ["./reply.txt"] },
        },
      }),
    ).resolves.toEqual({ ok: true, result: { ackedSeq: 0 } });
    // Buffered publication retains its original reader across later capability changes.
    reader.mockReturnValue(undefined);
    const applying = apply(msg(1, "first"));
    await started.promise;
    expect(deltas()).toEqual(["first"]);
    if (revoke) {
      rx.clearEnvironment(ID.environmentId);
    }
    prepared.resolve(reply);
    const result = await applying;
    if (revoke) {
      expect(result.ok).toBe(false);
      expect(deltas()).toEqual(["first"]);
    } else {
      expect(result).toEqual({ ok: true, result: { ackedSeq: 2 } });
      expect(events.at(-1)?.data).toMatchObject({
        text: reply.text,
        delta: reply.text,
        replace: true,
        mediaUrls: reply.mediaUrls,
      });
    }
  },
);
