import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { SQLITE_SESSION_WRITER_QUEUES } from "../../state/openclaw-agent-write-admission.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createWorkerLiveEventReceiver } from "./live-events.js";
import {
  SID,
  KEY,
  RUN,
  ID,
  EPOCH,
  msg,
  captureWorkerTranscriptSource,
} from "./live-events.test-support.js";
import * as turnCapabilities from "./placement-turn-claim-events.js";

describe("worker live reply media", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-worker-live-media-");
  let source: turnCapabilities.WorkerTurnTranscriptSource;
  let rx: ReturnType<typeof createWorkerLiveEventReceiver>;
  let events: Event[];
  let unsubscribe: () => void;
  const readAckedSeq = () => 0;
  const sourceFor = () => source;
  const deltas = () => events.map((event) => event.data.delta);
  const ack = async (request: ReturnType<typeof msg>, ackedSeq: number) => {
    expect(await rx.apply({ identity: ID, request, source, readAckedSeq })).toEqual({
      ok: true,
      result: { ackedSeq },
    });
  };
  beforeEach(async () => {
    const storePath = path.join(sessionDirs.make(), "agents", "main", "sessions", "sessions.json");
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: KEY, storePath },
      {
        sessionId: SID,
        updatedAt: 10,
        lifecycleRevision: "live-media-10",
        activeWriterRunId: RUN,
      },
    );
    source = captureWorkerTranscriptSource({
      agentId: "main",
      sessionId: SID,
      sessionKey: KEY,
      storePath,
    });
    setRuntimeConfigSnapshot({ session: { store: storePath } });
    rx = createWorkerLiveEventReceiver();
    events = [];
    unsubscribe = onAgentRuntimeEvent((event) => events.push(event));
  });
  afterEach(async () => {
    unsubscribe();
    rx.clear();
    clearRuntimeConfigSnapshot();
    await drainStoreWriterQueuesForTest(SQLITE_SESSION_WRITER_QUEUES, "live media test cleanup");
    closeOpenClawAgentDatabasesForTest();
  });

  it.each([false, true])(
    "prepares buffered reply media before publishing and fences revoked readers (%s)",
    async (revoke) => {
      const started = createDeferredCore<void>();
      const prepared = createDeferredCore<ReplyPayload>();
      const reader = vi
        .spyOn(turnCapabilities, "captureWorkerReplyMedia")
        .mockReturnValue(async () => {
          started.resolve();
          return prepared.promise;
        });
      try {
        await ack(
          {
            ...msg(2),
            event: {
              kind: "assistant",
              payload: {
                text: "MEDIA:./reply.txt",
                delta: "",
                mediaUrls: ["./reply.txt"],
              },
            },
          },
          0,
        );
        // Buffered publication retains its original reader across later capability changes.
        reader.mockReturnValue(undefined);
        const applying = rx.apply({
          identity: ID,
          request: msg(1, "first"),
          source: sourceFor(),
          readAckedSeq,
        });
        await started.promise;
        expect(deltas()).toEqual(["first"]);
        if (revoke) {
          rx.clearEnvironment(ID.environmentId, EPOCH);
        }
        prepared.resolve({
          text: "ready",
          mediaUrl: "/managed/reply.txt",
          mediaUrls: ["/managed/reply.txt"],
        });
        const result = await applying;
        if (revoke) {
          expect(result.ok).toBe(false);
          expect(deltas()).toEqual(["first"]);
        } else {
          expect(result).toEqual({ ok: true, result: { ackedSeq: 2 } });
          expect(events.at(-1)?.data).toMatchObject({
            text: "ready",
            delta: "ready",
            replace: true,
            mediaUrls: ["/managed/reply.txt"],
          });
        }
      } finally {
        reader.mockRestore();
      }
    },
  );
});
