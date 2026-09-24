import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "./user-turn-transcript.js";
import {
  createSqliteTranscriptTarget,
  persistUserTurnTranscript,
  readTranscriptMessages,
} from "./user-turn-transcript.test-support.js";
import type { UserTurnOriginalInputCommit } from "./user-turn-transcript.types.js";

describe("original-input commit notifications", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("reports one original committed input, never staged custody or idempotent replay", async () => {
    const target = createSqliteTranscriptTarget({ dir: tempDirs.make("original-input-commit-") });
    const commits: UserTurnOriginalInputCommit[] = [];
    const input = {
      text: "Hello @Ada",
      timestamp: 123,
      idempotencyKey: "source-mention:user",
      mentions: [{ profileId: "ada", start: 6, end: 10 }],
    };
    const createRecorder = () =>
      createUserTurnTranscriptRecorder({
        input,
        target,
        onOriginalInputCommitted: (commit) => {
          commits.push(commit);
        },
      });
    const first = createRecorder();
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    await expect(
      first.stageApproved?.({ runId: "source-mention", assertCurrent: () => {} }),
    ).resolves.toBe(true);
    expect(commits).toEqual([]);
    const result = await first.persistApproved();
    await first.persistFallback();
    const replay = await createRecorder().persistApproved();
    expect(replay?.appended).toBe(false);
    expect(commits).toEqual([
      {
        anchor: expect.objectContaining({
          entryId: result?.messageId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
        }),
        message: expect.objectContaining({
          content: input.text,
          __openclaw: { humanMentions: input.mentions },
        }),
      },
    ]);
    expect(await readTranscriptMessages(target)).toHaveLength(1);
  });

  it.each([undefined, false, true])(
    "requires explicit runtime append freshness (%s), not an admission anchor",
    async (appended) => {
      const target = createSqliteTranscriptTarget({ dir: tempDirs.make("runtime-input-commit-") });
      const commits: UserTurnOriginalInputCommit[] = [];
      const input = { text: "Hello @Ada", idempotencyKey: "runtime-mention:user" };
      const result = await persistUserTurnTranscript({ ...target, input });
      const recorder = createUserTurnTranscriptRecorder({
        input,
        target,
        onOriginalInputCommitted: (commit) => {
          commits.push(commit);
        },
      });
      const persistence = appended === undefined ? undefined : { appended };
      recorder.markRuntimePersisted(result?.message, result?.admission, persistence);
      recorder.markRuntimePersisted(result?.message, result?.admission, persistence);
      expect(recorder.getAdmissionReceipt()?.entryId).toBe(result?.messageId);
      expect(commits).toHaveLength(appended === true ? 1 : 0);
    },
  );

  it.each([
    "hidden",
    "internal",
    "handoff",
    "excluded",
    "blocked",
    "placeholder",
    "late-media",
  ] as const)("does not report %s rows as original human input", async (kind) => {
    const target = createSqliteTranscriptTarget({ dir: tempDirs.make("non-original-input-") });
    const commits: UserTurnOriginalInputCommit[] = [];
    const message = {
      role: "user" as const,
      content: "@Ada",
      timestamp: 1,
      ...(kind === "hidden" ? { display: false as const } : {}),
      ...(kind === "excluded" ? { excludeFromContext: true as const } : {}),
      ...(kind === "internal" ? { provenance: { kind: "internal_system" as const } } : {}),
      ...(kind === "handoff" ? { provenance: { kind: "inter_session" as const } } : {}),
      ...(kind === "placeholder" ? { __openclaw: { beforeAgentRunBlocked: true } } : {}),
      ...(kind === "late-media" ? { __openclaw: { lateMedia: true } } : {}),
    };
    const recorder = createUserTurnTranscriptRecorder({
      message,
      target,
      onOriginalInputCommitted: (commit) => {
        commits.push(commit);
      },
    });
    await (kind === "blocked" ? recorder.persistBlocked(message) : recorder.persistApproved());
    expect(await readTranscriptMessages(target)).toHaveLength(1);
    expect(commits).toEqual([]);
  });

  it.each([true, false])(
    "fans committed source mentions back to their own recorders only for an annotated collection (%s)",
    async (annotated) => {
      const target = createSqliteTranscriptTarget({
        dir: tempDirs.make("collected-input-commit-"),
      });
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const commits: UserTurnOriginalInputCommit[] = [];
      const sources = ["ada", "grace"].map((profileId) =>
        createUserTurnTranscriptRecorder({
          input: {
            text: `@${profileId}`,
            idempotencyKey: `${profileId}:user`,
            mentions: [{ profileId, start: 0, end: profileId.length + 1 }],
            sender: {
              id: `sender-${profileId}`,
              identity: { type: "profile", id: `sender-${profileId}` },
            },
          },
          target,
          onOriginalInputCommitted: (commit) => {
            commits.push(commit);
          },
        }),
      );
      for (const [index, source] of sources.entries()) {
        await source.stageApproved?.({ runId: `source-${index}`, assertCurrent: () => {} });
      }
      const aggregate = createUserTurnTranscriptRecorder({
        input: {
          text: annotated ? "@ada\n@grace" : "Two queued messages were summarized.",
          idempotencyKey: "aggregate:user",
          ...(annotated
            ? {
                mentions: [
                  { profileId: "ada", start: 0, end: 4 },
                  { profileId: "grace", start: 5, end: 11 },
                ],
              }
            : {}),
        },
        pendingInputSources: sources,
        target,
      });
      const result = await aggregate.persistApproved();
      await aggregate.persistFallback();
      expect(result?.appended).toBe(true);
      expect(
        commits.map((commit) => ({
          text: commit.message.content,
          sender: commit.message["__openclaw"]?.senderId,
          entryId: commit.anchor.entryId,
        })),
      ).toEqual(
        annotated
          ? [
              { text: "@ada", sender: "sender-ada", entryId: result?.messageId },
              { text: "@grace", sender: "sender-grace", entryId: result?.messageId },
            ]
          : [],
      );
      expect(await readTranscriptMessages(target)).toHaveLength(1);
    },
  );

  it("joins accepted callbacks for concurrent persistence without retrying a rejected effect", async () => {
    const target = createSqliteTranscriptTarget({ dir: tempDirs.make("original-input-async-") });
    const started = createDeferred();
    const callback = createDeferred();
    const errors: unknown[] = [];
    let attempts = 0;
    const input = { text: "@Ada", idempotencyKey: "async-commit:user" };
    const createRecorder = () =>
      createUserTurnTranscriptRecorder({
        input,
        target,
        onOriginalInputCommitted: () => {
          attempts += 1;
          started.resolve();
          return callback.promise;
        },
        onPersistenceError: (error) => {
          errors.push(error);
          throw new Error("diagnostic failed");
        },
      });
    const recorder = createRecorder();
    let settled = 0;
    const approved = recorder.persistApproved().then((result) => {
      settled += 1;
      return result;
    });
    await started.promise;
    const concurrent = recorder.persistApproved().then(() => {
      settled += 1;
    });
    const fallback = recorder.persistFallback().then(() => {
      settled += 1;
    });
    const lifecycle = recorder.waitForRuntimePersistence().then(() => {
      settled += 1;
    });
    const replay = await createRecorder().persistApproved();
    expect(replay?.appended).toBe(false);
    expect(await readTranscriptMessages(target)).toHaveLength(1);
    expect(settled).toBe(0);
    expect(attempts).toBe(1);
    callback.reject(new Error("notification failed"));
    await expect(approved).resolves.toMatchObject({ appended: true });
    await Promise.all([concurrent, fallback, lifecycle]);
    expect(settled).toBe(4);
    expect(errors).toEqual([expect.objectContaining({ message: "notification failed" })]);
    await recorder.persistFallback();
    expect(attempts).toBe(1);
    expect(await readTranscriptMessages(target)).toHaveLength(1);
  });

  it.each([false, true])(
    "joins runtime committed-input work with a pending writer (%s)",
    async (pendingWriter) => {
      const target = createSqliteTranscriptTarget({ dir: tempDirs.make("runtime-input-async-") });
      const input = { text: "@Ada", idempotencyKey: "runtime-async:user" };
      const result = await persistUserTurnTranscript({ ...target, input });
      const callback = createDeferred();
      const writer = createDeferred();
      const started = createDeferred();
      let attempts = 0;
      const recorder = createUserTurnTranscriptRecorder({
        input,
        target,
        onOriginalInputCommitted: () => {
          attempts += 1;
          started.resolve();
          return callback.promise;
        },
      });
      const commit = () => {
        recorder.markRuntimePersisted(result?.message, result?.admission, { appended: true });
        recorder.markRuntimePersisted(result?.message, result?.admission, { appended: true });
      };
      if (pendingWriter) {
        recorder.markRuntimePersistencePending(writer.promise.then(commit));
      } else {
        commit();
      }
      let settled = false;
      const lifecycle = recorder.waitForRuntimePersistence().then(() => {
        settled = true;
      });
      writer.resolve();
      await started.promise;
      expect(recorder.hasRuntimePersistencePending()).toBe(true);
      const fallback = recorder.persistFallback();
      // The writer has completed, but accepted callback work still owns settlement.
      await recorder.resolveMessage();
      expect(settled).toBe(false);
      expect(attempts).toBe(1);
      callback.resolve();
      await lifecycle;
      await expect(fallback).resolves.toBeUndefined();
      expect(settled).toBe(true);
      expect(await readTranscriptMessages(target)).toHaveLength(1);
    },
  );

  it("joins every framed source callback even when a sibling callback rejects", async () => {
    const target = createSqliteTranscriptTarget({ dir: tempDirs.make("collected-input-async-") });
    await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
    const callbacks = [createDeferred(), createDeferred()];
    const started = createDeferred();
    const errors: unknown[] = [];
    const commits: UserTurnOriginalInputCommit[] = [];
    const sources = ["ada", "grace"].map((profileId, index) =>
      createUserTurnTranscriptRecorder({
        input: {
          text: `@${profileId}`,
          idempotencyKey: `async-${profileId}:user`,
          mentions: [{ profileId, start: 0, end: profileId.length + 1 }],
        },
        target,
        onOriginalInputCommitted: (commit) => {
          commits.push(commit);
          if (commits.length === 2) {
            started.resolve();
          }
          return callbacks[index]!.promise;
        },
        onPersistenceError: (error) => {
          errors.push(error);
        },
      }),
    );
    for (const [index, source] of sources.entries()) {
      await source.stageApproved?.({ runId: "async-source-" + index, assertCurrent: () => {} });
    }
    const aggregate = createUserTurnTranscriptRecorder({
      input: {
        text: "@ada\n@grace",
        idempotencyKey: "async-aggregate:user",
        mentions: [
          { profileId: "ada", start: 0, end: 4 },
          { profileId: "grace", start: 5, end: 11 },
        ],
      },
      pendingInputSources: sources,
      target,
    });
    let settled = false;
    const persistence = aggregate.persistApproved().then((result) => {
      settled = true;
      return result;
    });
    await started.promise;
    expect(commits.map((commit) => commit.message.content)).toEqual(["@ada", "@grace"]);
    expect(await readTranscriptMessages(target)).toHaveLength(1);
    expect(settled).toBe(false);
    callbacks[0]!.reject(new Error("first source failed"));
    await sources[0]!.waitForRuntimePersistence();
    expect(errors).toEqual([expect.objectContaining({ message: "first source failed" })]);
    expect(settled).toBe(false);
    callbacks[1]!.resolve();
    const result = await persistence;
    await Promise.all([
      aggregate.waitForRuntimePersistence(),
      sources[1]!.waitForRuntimePersistence(),
    ]);
    expect(commits.every((commit) => commit.anchor.entryId === result?.messageId)).toBe(true);
    await aggregate.persistFallback();
    expect(commits).toHaveLength(2);
  });

  it("does not fail or retry a committed input when notification and diagnostic callbacks throw", async () => {
    const target = createSqliteTranscriptTarget({ dir: tempDirs.make("original-input-errors-") });
    const errors: unknown[] = [];
    let attempts = 0;
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "@Ada", idempotencyKey: "notification-error:user" },
      target,
      onOriginalInputCommitted: () => {
        attempts += 1;
        throw new Error("notification failed");
      },
      onPersistenceError: (error) => {
        errors.push(error);
        throw new Error("diagnostic failed");
      },
    });
    await expect(recorder.persistApproved()).resolves.toMatchObject({ appended: true });
    await recorder.persistFallback();
    expect(attempts).toBe(1);
    expect(errors).toEqual([expect.objectContaining({ message: "notification failed" })]);
    expect(await readTranscriptMessages(target)).toHaveLength(1);
  });
});
