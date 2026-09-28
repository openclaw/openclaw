import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../../sessions/user-turn-transcript.test-support.js";
import type { QueueSettings } from "./queue.js";
import {
  admitFollowupRunLifecycle,
  enqueueFollowupRun,
  refreshQueuedFollowupSession,
} from "./queue.js";
import {
  createQueueTestRun as createRun,
  createDrainRecorder,
  drainRecordedQueue,
} from "./queue.test-helpers.js";
import { getExistingFollowupQueue } from "./queue/state.js";

describe("collected followup transcripts", () => {
  it("keeps collected transcript ownership across an admitted session rotation", async () => {
    const key = `test-collect-transcript-owner-${Date.now()}`;
    const { calls, done, runFollowup } = createDrainRecorder();
    const firstComplete = vi.fn();
    const settled = createDeferred();
    const secondComplete = vi.fn(() => settled.resolve());
    const firstCorrelation = { begin: vi.fn() };
    const secondCorrelation = { begin: vi.fn() };
    const createRecorder = (text: string, mediaPath: string) =>
      createUserTurnTranscriptRecorder({
        input: {
          text,
          media: [{ path: mediaPath, contentType: "image/png" }],
          mentions: [
            { profileId: "ada", start: text.indexOf("@Ada"), end: text.indexOf("@Ada") + 4 },
          ],
        },
        target: createTestUserTurnTranscriptTarget(),
        updateMode: "none",
      });
    const firstRecorder = createRecorder("first transcript @Ada", "/tmp/first.png");
    const secondRecorder = createRecorder("second transcript 🦞 @Ada", "/tmp/second.png");
    const settings: QueueSettings = { mode: "collect", debounceMs: 0 };

    for (const [prompt, recorder, onComplete, deliveryCorrelation] of [
      ["first", firstRecorder, firstComplete, firstCorrelation],
      ["second", secondRecorder, secondComplete, secondCorrelation],
    ] as const) {
      enqueueFollowupRun(
        key,
        {
          ...createRun({ prompt }),
          transcriptPrompt: `${prompt} transcript`,
          userTurnTranscriptRecorder: recorder,
          currentInboundContext: { text: "shared gateway context", promptJoiner: " " },
          deliveryCorrelations: [deliveryCorrelation],
          abortSignal: new AbortController().signal,
          turnAdoptionLifecycle: { onAdopted: async () => {}, onSettled: onComplete },
        },
        settings,
      );
    }

    let queuedSourcesAfterAdmission: number | undefined;
    await drainRecordedQueue(
      key,
      async (run) => {
        await admitFollowupRunLifecycle(run);
        queuedSourcesAfterAdmission = getExistingFollowupQueue(key)?.items.length;
        refreshQueuedFollowupSession({
          key,
          previousSessionId: run.run.sessionId,
          nextSessionId: "after-preflight-compaction",
        });
        await runFollowup(run);
      },
      done,
    );

    expect(calls).toHaveLength(1);
    expect(queuedSourcesAfterAdmission).toBe(0);
    expect(calls[0]?.prompt).toContain("first");
    expect(calls[0]?.prompt).toContain("second");
    expect(calls[0]?.transcriptPrompt).toContain("first transcript");
    expect(calls[0]?.transcriptPrompt).toContain("second transcript");
    expect(calls[0]?.currentInboundContext?.text).toContain(
      "Queued #1 context:\nshared gateway context",
    );
    expect(calls[0]?.currentInboundContext?.text).toContain(
      "Queued #2 context:\nshared gateway context",
    );
    expect(calls[0]?.currentInboundContext?.promptJoiner).toBe("\n\n");
    expect(calls[0]?.deliveryCorrelations).toEqual([firstCorrelation, secondCorrelation]);
    expect(calls[0]?.userTurnTranscriptRecorder).not.toBe(firstRecorder);
    expect(calls[0]?.userTurnTranscriptRecorder).not.toBe(secondRecorder);
    const message = await calls[0]?.userTurnTranscriptRecorder?.resolveMessage();
    expect(message?.idempotencyKey).toMatch(/^followup-collect:after-preflight-compaction:/);
    expect(message?.content).toContain("first transcript");
    expect(message?.content).toContain("second transcript");
    const mentions = message?.["__openclaw"]?.humanMentions;
    expect(mentions).toHaveLength(2);
    expect(
      mentions?.map((mention) =>
        typeof message?.content === "string"
          ? message.content.slice(mention.start, mention.end)
          : undefined,
      ),
    ).toEqual(["@Ada", "@Ada"]);
    expect(mentions?.[1]?.start).toBeGreaterThan(mentions?.[0]?.end ?? 0);
    expect(
      (message as unknown as { __openclaw?: { media?: Array<{ path?: string }> } } | undefined)?.[
        "__openclaw"
      ]?.media?.map((fact) => fact.path),
    ).toEqual(["/tmp/first.png", "/tmp/second.png"]);
    await settled.promise;
    expect(firstComplete).toHaveBeenCalledTimes(1);
    expect(secondComplete).toHaveBeenCalledTimes(1);
  });
});
