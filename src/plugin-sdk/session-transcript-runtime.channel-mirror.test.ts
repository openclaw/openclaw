import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendTranscriptEvent,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { readTranscriptEventRows } from "../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  historyLane,
  projectionLane,
  targetDiscoveryLane,
} from "../config/sessions/session-transcript-worker-resources.js";
import { createDeferredCore } from "../shared/deferred.js";
import { isActiveStoreWriter } from "../shared/store-writer-queue.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { SQLITE_SESSION_WRITER_QUEUES } from "../state/openclaw-agent-write-admission-state.js";
import { runOpenClawAgentWriteAdmission } from "../state/openclaw-agent-write-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  appendAssistantMirrorMessageByIdentity as appendMirror,
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
  readVisibleSessionTranscriptMessageEntries,
  withSessionTranscriptWrite,
  type SessionTranscriptAssistantMirrorAppendParams,
} from "./session-transcript-runtime.js";

describe("channel-final transcript mirrors", () => {
  const sourceId = "openclawDeliveryMirror.sourceAssistantMessageId";
  const chartContent = [{ type: "text", text: "Chart\nchart.png" }];
  let state: OpenClawTestState;
  let scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string };

  beforeEach(async () => {
    state = await createOpenClawTestState({ prefix: "openclaw-channel-mirror-", applyEnv: false });
    scope = {
      agentId: "main",
      sessionId: "channel-mirror-session",
      sessionKey: "agent:main:channel-mirror",
      storePath: path.join(state.root, "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 10 });
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    await state.cleanup();
  });

  const append = async (message: Record<string, unknown>, eventId?: string) => {
    const result = await appendSessionTranscriptMessageByIdentity({ ...scope, message, eventId });
    if (!result) {
      throw new Error("Expected the fixture message to append");
    }
    return result;
  };
  const delivery = (id: string, text = "The train leaves at noon.") =>
    ({
      ...scope,
      idempotencyKey: id,
      deliveryMirror: { kind: "channel-final", sourceMessageId: id },
      text,
      updateMode: "none",
    }) satisfies SessionTranscriptAssistantMirrorAppendParams;
  const rows = () =>
    readTranscriptEventRows(
      openOpenClawAgentDatabase(toDatabaseOptions(resolveSqliteTranscriptReadScope(scope))),
      scope.sessionId,
    );
  const entries = () => readVisibleSessionTranscriptMessageEntries(scope);
  const answer = (
    eventId: string,
    content: unknown = "The train leaves at noon.",
    runId?: string,
    fields: Record<string, unknown> = {},
  ) =>
    append(
      { role: "assistant", content, ...(runId ? { __openclaw: { runId } } : {}), ...fields },
      eventId,
    );
  const mirrorEntries = async () => (await entries()).filter((entry) => entry.idempotencyKey);
  const mediaDelivery = (id: string) => ({
    ...delivery(id, "Chart"),
    mediaUrls: ["https://example.com/one/chart.png"],
  });
  const expectReplay = async (...requests: SessionTranscriptAssistantMirrorAppendParams[]) => {
    const before = rows();
    for (const request of requests) {
      await appendMirror(request);
    }
    expect(rows()).toEqual(before);
  };
  const expectSources = (mirrors: Awaited<ReturnType<typeof entries>>, sourceIds: string[]) =>
    expect(mirrors).toMatchObject(
      sourceIds.map((sourceAssistantMessageId) => ({
        message: { openclawDeliveryMirror: { sourceAssistantMessageId } },
      })),
    );

  it("replays shipped SDK mirror bytes with media", async () => {
    const request = mediaDelivery("shipped-sdk-mirror");
    const zeroTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    // Literal v2026.10.2 SDK representation, independent of the current producer.
    const original = await answer("shipped-sdk-message", chartContent, undefined, {
      api: "openai-responses",
      provider: "openclaw",
      model: "delivery-mirror",
      usage: { ...zeroTokens, totalTokens: 0, cost: { ...zeroTokens, total: 0 } },
      stopReason: "stop",
      timestamp: 1_700_000_000_000,
      idempotencyKey: request.idempotencyKey,
      openclawDeliveryMirror: request.deliveryMirror,
    });
    const before = rows();
    expect(await appendMirror(request)).toEqual({ ok: true, messageId: original.messageId });
    expect(rows()).toEqual(before);
    await expect(appendMirror({ ...request, text: "Different chart" })).rejects.toThrow(
      "conflicts with the admitted message",
    );
    expect(rows()).toEqual(before);
  });

  it("retains distinct unkeyed media identities and suppresses an exact repeat", async () => {
    const mediaUrls: [string, string] = [
      "https://example.com/one/chart.png",
      "https://example.com/two/chart.png",
    ];
    const results = [];
    for (const mediaUrl of [...mediaUrls, mediaUrls[1]]) {
      const request = { ...scope, text: "Chart", mediaUrls: [mediaUrl] };
      results.push(await appendMirror({ ...request, updateMode: "none" }));
    }
    expect(await readSessionTranscriptEvents(scope)).toMatchObject([
      { type: "session", id: scope.sessionId },
      ...mediaUrls.map((mediaUrl) => ({
        type: "message",
        message: expect.objectContaining({
          content: chartContent,
          openclawDelivery: { mediaUrls: [mediaUrl] },
        }),
      })),
    ]);
    expect(results[2]).toEqual(results[1]);
  });

  it("replays keyed media exactly and rejects a different same-basename attachment", async () => {
    const request = mediaDelivery("media-delivery");
    const first = await appendMirror(request);
    await expect(appendMirror(request)).resolves.toEqual(first);
    const before = await readSessionTranscriptEvents(scope);
    await expect(
      appendMirror({
        ...request,
        mediaUrls: ["https://example.com/two/chart.png"],
      }),
    ).rejects.toThrow("conflicts with the admitted message");
    expect(await readSessionTranscriptEvents(scope)).toEqual(before);
  });

  it("correlates authored media captions through source run lookup", async () => {
    const request = { ...mediaDelivery("media-source-delivery"), sourceRunId: "media-source-run" };
    const { mediaUrls, sourceRunId } = request;
    await answer("media-source-answer", "Chart", sourceRunId, { openclawDelivery: { mediaUrls } });
    await answer("plain-source-answer", "Chart", sourceRunId);
    await appendMirror(request);
    const plainRequest = { ...delivery("plain-source-delivery", "Chart"), sourceRunId };
    await appendMirror(plainRequest);
    const mirrors = await mirrorEntries();
    expect(mirrors[0]?.message).toMatchObject({ content: chartContent });
    expectSources(mirrors, ["media-source-answer", "plain-source-answer"]);
    await expectReplay(request, plainRequest);
  });

  it("correlates identical queued answers from the source run", async () => {
    const firstText = "The train leaves at noon.";
    await answer("first-answer", firstText, "queued-run");
    await append({ role: "user", content: "And the next train?" });
    await answer("second-answer", firstText, "queued-run");
    // Delivery can settle after another run has already appended its answer.
    await answer("later-answer", firstText, "later-run");
    const facts = await withSessionTranscriptWrite(scope, (writer) =>
      writer.readMessageFacts({ idempotencyKeys: [], sourceRunId: "queued-run" }),
    );
    expect(facts.sourceEvents).toMatchObject([{ id: "first-answer" }, { id: "second-answer" }]);
    const first = { ...delivery("first-delivery", firstText), sourceRunId: "queued-run" };
    const second = { ...delivery("second-delivery", firstText), sourceRunId: "queued-run" };
    await appendMirror(first);
    await appendMirror(second);

    expectSources(await mirrorEntries(), ["first-answer", "second-answer"]);
    await expectReplay(first, second);
  });

  it.each(["another run", "preceding mirror"])("does not correlate %s", async (source) => {
    await answer("older-answer", "The train leaves at noon.", "other-run");
    if (source === "preceding mirror") {
      await answer("preceding-mirror", undefined, undefined, {
        provider: "openclaw",
        model: "delivery-mirror",
      });
    }
    await appendMirror({
      ...delivery("unmatched-delivery"),
      ...(source === "another run" ? { sourceRunId: "source-run" } : {}),
    });
    const message = (await entries()).at(-1)?.message;
    expect(message).toMatchObject({
      model: "delivery-mirror",
      idempotencyKey: "unmatched-delivery",
    });
    expect(message).not.toHaveProperty(sourceId);
  });

  it("replays the stored mirror unchanged immediately and after a later turn", async () => {
    await answer("first-answer");
    const request = delivery("stable-delivery");
    const first = await appendMirror(request);
    const initialRows = rows();

    await expect(appendMirror(request)).resolves.toEqual(first);
    expect(rows()).toEqual(initialRows);
    await append({ role: "user", content: "And the next train?" });
    await append({ role: "assistant", content: "The next train leaves at two." });
    const laterRows = rows();
    await expect(appendMirror(request)).resolves.toEqual(first);
    expect(rows()).toEqual(laterRows);
  });

  it.each([false, true])("rejects forged source IDs (suppressed=%s)", async (suppressed) => {
    const signedText = (id: string, phase: string, text: string) => ({
      type: "text",
      text,
      textSignature: JSON.stringify({ v: 1, id, phase }),
    });
    await answer("real-answer", [
      { type: "thinking", thinking: "Checking the timetable." },
      signedText("commentary", "commentary", "I will check the departure."),
      signedText("answer", "final_answer", "The train leaves at noon."),
    ]);
    const request = delivery("forged-delivery");
    const marker = suppressed
      ? {
          ...request.deliveryMirror,
          kind: "channel-final-suppressed" as const,
          reason: "stale-foreground" as const,
        }
      : request.deliveryMirror;
    const forgedRequest = {
      ...request,
      deliveryMirror: { ...marker, sourceAssistantMessageId: "caller-forged-answer" },
    };
    await appendMirror(forgedRequest);

    const message = (await entries()).at(-1)?.message;
    expect(message).toMatchObject({ model: "delivery-mirror", idempotencyKey: "forged-delivery" });
    if (suppressed) {
      expect(message).toMatchObject({
        openclawDeliveryMirror: { kind: "channel-final-suppressed", reason: "stale-foreground" },
      });
      expect(message).not.toHaveProperty(sourceId);
    } else {
      expect(message).toMatchObject({
        content: [{ type: "text", text: "The train leaves at noon." }],
        openclawDeliveryMirror: { sourceAssistantMessageId: "real-answer" },
      });
    }
    expect(await entries()).toHaveLength(2);
  });

  it.each(["entry cleanup", "latest-message refusal"] as const)(
    "correlates only the selected active branch without a writer wait during %s",
    async (phase) => {
      await answer("active-answer");
      await answer("inactive-answer", "The train leaves at two.");
      await appendTranscriptEvent(scope, {
        type: "leaf",
        id: "select-active-answer",
        parentId: "inactive-answer",
        targetId: "active-answer",
      });

      const database = openOpenClawAgentDatabase(
        toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
      );
      const retirementEntered = createDeferredCore();
      const releaseRetirement = createDeferredCore();
      let following: Promise<void> | undefined;
      const waitForWriter = () => {
        following ??= runOpenClawAgentWriteAdmission(database, () => {});
        retirementEntered.resolve();
        return Promise.race([following, releaseRetirement.promise]);
      };
      const holdsWriter = () => isActiveStoreWriter(SQLITE_SESSION_WRITER_QUEUES, database.path);
      const close = projectionLane.pool.closeResources;
      const rotate = historyLane.pool.rotate.bind(historyLane.pool);
      const cleanup =
        phase === "entry cleanup"
          ? vi
              .spyOn(projectionLane.pool, "closeResources")
              .mockImplementation((key) => (holdsWriter() ? waitForWriter() : close(key)))
          : vi
              .spyOn(historyLane.pool, "rotate")
              .mockImplementation(() => (holdsWriter() ? waitForWriter() : rotate()));
      let refusedLatest = false;
      const reads =
        phase === "latest-message refusal"
          ? [historyLane, targetDiscoveryLane].map(({ pool }) => {
              const run = pool.run.bind(pool);
              return vi.spyOn(pool, "run").mockImplementation(async (input, controls) => {
                let latest = false;
                const result = await run(async () => {
                  const request = typeof input === "function" ? await input() : input;
                  latest = request.kind === "latest-active-message";
                  return request;
                }, controls);
                if (latest) {
                  refusedLatest = true;
                  return { ok: false, error: { kind: "projection", sessionId: scope.sessionId } };
                }
                return result;
              });
            })
          : [];
      const appending = appendMirror(delivery("branch-delivery"));
      try {
        await expect(
          Promise.race([
            appending,
            retirementEntered.promise.then(() => {
              throw new Error("Mirror reader cleanup waits on its own queued writer");
            }),
          ]),
        ).resolves.toMatchObject({ ok: true });
        expect(refusedLatest).toBe(phase === "latest-message refusal");
      } finally {
        releaseRetirement.resolve();
        await Promise.allSettled([appending, following]);
        [cleanup, ...reads].forEach((mock) => mock.mockRestore());
      }

      expect((await entries()).at(-1)?.message).toHaveProperty(sourceId, "active-answer");
    },
  );
});
