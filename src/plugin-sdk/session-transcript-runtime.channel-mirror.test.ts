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
  appendAssistantMirrorMessageByIdentity,
  appendSessionTranscriptMessageByIdentity,
  readSessionTranscriptEvents,
  readVisibleSessionTranscriptMessageEntries,
  withSessionTranscriptWrite,
  type SessionTranscriptAssistantMirrorAppendParams,
} from "./session-transcript-runtime.js";

describe("channel-final transcript mirrors", () => {
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

  it.each([true])("replays shipped SDK mirror bytes with media=%s", async (media) => {
    const request = {
      ...delivery("shipped-sdk-mirror", "Chart"),
      ...(media ? { mediaUrls: ["https://example.com/one/chart.png"] } : {}),
    };
    // Literal v2026.10.2 SDK representation, independent of the current producer.
    const original = await append({
      role: "assistant",
      content: [{ type: "text", text: media ? "Chart\nchart.png" : "Chart" }],
      api: "openai-responses",
      provider: "openclaw",
      model: "delivery-mirror",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 1_700_000_000_000,
      idempotencyKey: request.idempotencyKey,
      openclawDeliveryMirror: request.deliveryMirror,
    });
    const before = rows();
    await expect(appendAssistantMirrorMessageByIdentity(request)).resolves.toEqual({
      ok: true,
      messageId: original.messageId,
    });
    expect(rows()).toEqual(before);
    await expect(
      appendAssistantMirrorMessageByIdentity({ ...request, text: "Different chart" }),
    ).rejects.toThrow("conflicts with the admitted message");
    expect(rows()).toEqual(before);
  });

  it("retains distinct unkeyed media identities and suppresses an exact repeat", async () => {
    const mediaUrls: [string, string] = [
      "https://example.com/one/chart.png",
      "https://example.com/two/chart.png",
    ];
    const results = [];
    for (const mediaUrl of [...mediaUrls, mediaUrls[1]]) {
      results.push(
        await appendAssistantMirrorMessageByIdentity({
          ...scope,
          text: "Chart",
          mediaUrls: [mediaUrl],
          updateMode: "none",
        }),
      );
    }
    expect(await readSessionTranscriptEvents(scope)).toEqual([
      expect.objectContaining({ type: "session", id: scope.sessionId }),
      ...mediaUrls.map((mediaUrl) =>
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({
            content: [{ type: "text", text: "Chart\nchart.png" }],
            openclawDelivery: { mediaUrls: [mediaUrl] },
          }),
        }),
      ),
    ]);
    expect(results[2]).toEqual(results[1]);
  });

  it("replays keyed media exactly and rejects a different same-basename attachment", async () => {
    const request = {
      ...delivery("media-delivery", "Chart"),
      mediaUrls: ["https://example.com/one/chart.png"],
    };
    const first = await appendAssistantMirrorMessageByIdentity(request);
    await expect(appendAssistantMirrorMessageByIdentity(request)).resolves.toEqual(first);
    const before = await readSessionTranscriptEvents(scope);
    await expect(
      appendAssistantMirrorMessageByIdentity({
        ...request,
        mediaUrls: ["https://example.com/two/chart.png"],
      }),
    ).rejects.toThrow("conflicts with the admitted message");
    expect(await readSessionTranscriptEvents(scope)).toEqual(before);
  });

  it.each(["source run"])(
    "correlates authored media captions through %s source lookup",
    async (lookup) => {
      const mediaUrls = ["https://example.com/one/chart.png"];
      await append(
        {
          role: "assistant",
          content: "Chart",
          openclawDelivery: { mediaUrls },
          __openclaw: { runId: "media-source-run" },
        },
        "media-source-answer",
      );
      if (lookup === "source run") {
        await append(
          { role: "assistant", content: "Chart", __openclaw: { runId: "media-source-run" } },
          "plain-source-answer",
        );
      }
      const request = {
        ...delivery("media-source-delivery", "Chart"),
        mediaUrls,
        ...(lookup === "source run" ? { sourceRunId: "media-source-run" } : {}),
      };
      await appendAssistantMirrorMessageByIdentity(request);
      const plainRequest = {
        ...delivery("plain-source-delivery", "Chart"),
        sourceRunId: "media-source-run",
      };
      if (lookup === "source run") {
        await appendAssistantMirrorMessageByIdentity(plainRequest);
      }
      const mirrors = (await entries()).filter((entry) => entry.idempotencyKey);
      expect(mirrors[0]?.message).toMatchObject({
        content: [{ type: "text", text: "Chart\nchart.png" }],
      });
      const sourceIds = [
        "media-source-answer",
        ...(lookup === "source run" ? ["plain-source-answer"] : []),
      ];
      expect(mirrors).toMatchObject(
        sourceIds.map((sourceAssistantMessageId) => ({
          message: { openclawDeliveryMirror: { sourceAssistantMessageId } },
        })),
      );
      const beforeReplay = rows();
      await appendAssistantMirrorMessageByIdentity(request);
      if (lookup === "source run") {
        await appendAssistantMirrorMessageByIdentity(plainRequest);
      }
      expect(rows()).toEqual(beforeReplay);
    },
  );

  it.each([true])(
    "correlates queued answers from the source run (identical text: %s)",
    async (identical) => {
      const firstText = "The train leaves at noon.";
      const secondText = identical ? firstText : "The next train leaves at two.";
      await append(
        { role: "assistant", content: firstText, __openclaw: { runId: "queued-run" } },
        "first-answer",
      );
      await append({ role: "user", content: "And the next train?" });
      await append(
        { role: "assistant", content: secondText, __openclaw: { runId: "queued-run" } },
        "second-answer",
      );
      // Delivery can settle after another run has already appended its answer.
      await append(
        { role: "assistant", content: firstText, __openclaw: { runId: "later-run" } },
        "later-answer",
      );
      const facts = await withSessionTranscriptWrite(scope, (writer) =>
        writer.readMessageFacts({ idempotencyKeys: [], sourceRunId: "queued-run" }),
      );
      expect(facts.sourceEvents).toMatchObject([{ id: "first-answer" }, { id: "second-answer" }]);
      const first = { ...delivery("first-delivery", firstText), sourceRunId: "queued-run" };
      const second = { ...delivery("second-delivery", secondText), sourceRunId: "queued-run" };
      await appendAssistantMirrorMessageByIdentity(first);
      await appendAssistantMirrorMessageByIdentity(second);

      expect((await entries()).filter((entry) => entry.idempotencyKey)).toMatchObject([
        { message: { openclawDeliveryMirror: { sourceAssistantMessageId: "first-answer" } } },
        { message: { openclawDeliveryMirror: { sourceAssistantMessageId: "second-answer" } } },
      ]);
      const beforeReplay = rows();
      await appendAssistantMirrorMessageByIdentity(first);
      await appendAssistantMirrorMessageByIdentity(second);
      expect(rows()).toEqual(beforeReplay);
    },
  );

  it("does not correlate another run's matching text when the source run does not match", async () => {
    await append(
      {
        role: "assistant",
        content: "The train leaves at noon.",
        __openclaw: { runId: "other-run" },
      },
      "other-answer",
    );
    const request = {
      ...delivery("unmatched-run-delivery"),
      sourceRunId: "source-run",
    };
    await appendAssistantMirrorMessageByIdentity(request);
    expect((await entries()).at(-1)?.message).not.toHaveProperty(
      "openclawDeliveryMirror.sourceAssistantMessageId",
    );
  });

  it.each([
    {
      name: "another delivery mirror",
      message: {
        role: "assistant",
        provider: "openclaw",
        model: "delivery-mirror",
        content: "The train leaves at noon.",
      },
    },
  ])("leaves the mirror uncorrelated after $name", async ({ message: precedingMessage }) => {
    await append({ role: "assistant", content: "The train leaves at noon." }, "older-answer");
    await append(precedingMessage);

    await appendAssistantMirrorMessageByIdentity(delivery("unmatched-delivery"));

    const message = (await entries()).at(-1)?.message;
    expect(message).toMatchObject({
      model: "delivery-mirror",
      idempotencyKey: "unmatched-delivery",
    });
    expect(message).not.toHaveProperty("openclawDeliveryMirror.sourceAssistantMessageId");
  });

  it("replays the stored mirror unchanged immediately and after a later turn", async () => {
    await append({ role: "assistant", content: "The train leaves at noon." }, "first-answer");
    const request = delivery("stable-delivery");
    const first = await appendAssistantMirrorMessageByIdentity(request);
    const initialRows = rows();

    await expect(appendAssistantMirrorMessageByIdentity(request)).resolves.toEqual(first);
    expect(rows()).toEqual(initialRows);
    await append({ role: "user", content: "And the next train?" });
    await append({ role: "assistant", content: "The next train leaves at two." });
    const laterRows = rows();
    await expect(appendAssistantMirrorMessageByIdentity(request)).resolves.toEqual(first);
    expect(rows()).toEqual(laterRows);
  });

  it("correlates the final answer without trusting a caller-supplied source identity", async () => {
    await append(
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Checking the timetable." },
          {
            type: "text",
            text: "I will check the departure.",
            textSignature: '{"v":1,"id":"commentary","phase":"commentary"}',
          },
          {
            type: "text",
            text: "The train leaves at noon.",
            textSignature: '{"v":1,"id":"answer","phase":"final_answer"}',
          },
        ],
      },
      "real-answer",
    );
    const request = {
      ...delivery("forged-delivery"),
      deliveryMirror: {
        kind: "channel-final",
        sourceMessageId: "forged-delivery",
        sourceAssistantMessageId: "caller-forged-answer",
      },
    } satisfies SessionTranscriptAssistantMirrorAppendParams & {
      deliveryMirror: {
        kind: "channel-final";
        sourceMessageId: string;
        sourceAssistantMessageId: string;
      };
    };

    await appendAssistantMirrorMessageByIdentity(request);

    const message = (await entries()).at(-1)?.message;
    expect(message).toMatchObject({
      model: "delivery-mirror",
      idempotencyKey: "forged-delivery",
      content: [{ type: "text", text: "The train leaves at noon." }],
    });
    expect(message).not.toHaveProperty(
      "openclawDeliveryMirror.sourceAssistantMessageId",
      "caller-forged-answer",
    );
    expect(message).toHaveProperty(
      "openclawDeliveryMirror.sourceAssistantMessageId",
      "real-answer",
    );
    expect(await entries()).toHaveLength(2);
  });

  it("strips source correlation from a caller-supplied suppressed-final marker", async () => {
    const request = {
      ...delivery("suppressed-delivery"),
      deliveryMirror: {
        kind: "channel-final-suppressed",
        reason: "stale-foreground",
        sourceMessageId: "suppressed-delivery",
        sourceAssistantMessageId: "caller-forged-answer",
      },
    } satisfies SessionTranscriptAssistantMirrorAppendParams & {
      deliveryMirror: { kind: "channel-final-suppressed"; sourceAssistantMessageId: string };
    };

    await appendAssistantMirrorMessageByIdentity(request);

    const message = (await entries()).at(-1)?.message;
    expect(message).toMatchObject({
      idempotencyKey: "suppressed-delivery",
      openclawDeliveryMirror: { kind: "channel-final-suppressed", reason: "stale-foreground" },
    });
    expect(message).not.toHaveProperty("openclawDeliveryMirror.sourceAssistantMessageId");
  });

  it.each(["entry cleanup", "latest-message refusal"] as const)(
    "correlates only the selected active branch without a writer wait during %s",
    async (phase) => {
      await append({ role: "assistant", content: "The train leaves at noon." }, "active-answer");
      await append({ role: "assistant", content: "The train leaves at two." }, "inactive-answer");
      await appendTranscriptEvent(scope, {
        type: "leaf",
        id: "select-active-answer",
        parentId: "inactive-answer",
        targetId: "active-answer",
      });

      const database = openOpenClawAgentDatabase(
        toDatabaseOptions(resolveSqliteTranscriptReadScope(scope)),
      );
      const options = { agentId: database.agentId, path: database.path };
      const retirementEntered = createDeferredCore();
      const releaseRetirement = createDeferredCore();
      let following: Promise<void> | undefined;
      const waitForWriter = () => {
        following ??= runOpenClawAgentWriteAdmission(options, () => {});
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
      const appending = appendAssistantMirrorMessageByIdentity(delivery("branch-delivery"));
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
        cleanup.mockRestore();
        for (const read of reads) {
          read.mockRestore();
        }
      }

      expect((await entries()).at(-1)?.message).toHaveProperty(
        "openclawDeliveryMirror.sourceAssistantMessageId",
        "active-answer",
      );
    },
  );
});
