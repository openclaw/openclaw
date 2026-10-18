import path from "node:path";
import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { trackSqliteStatementExecutions } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { makeUserMessage } from "../../test/helpers/user-message.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { rewritePreparedTranscriptMessageAtAnchor } from "../config/sessions/session-message-rewrite.js";
import { transcriptMessage } from "../config/sessions/transcript-message.test-support.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { readPendingUserTurnTranscriptAdmission } from "./user-turn-transcript-admission.js";
import {
  buildLateMediaAttachedProjection,
  createUserTurnTranscriptRecorder,
  mergePreparedUserTurnMessageForRuntime,
  resolvePersistedUserTurnText,
  type UserTurnInput,
} from "./user-turn-transcript.js";
import {
  isUserMessage,
  projectRecordedModelPrompt,
  readModelPromptProjection,
} from "./user-turn-transcript.message.js";
import {
  createSqliteTranscriptTarget,
  persistUserTurnTranscript,
  readTranscriptMessages,
} from "./user-turn-transcript.test-support.js";

describe("user turn transcript persistence", () => {
  const sessionDirs = useSessionStoreTempDirs(
    (cleanup) =>
      afterAll(async () => {
        await cleanup();
        clearRuntimeConfigSnapshot();
      }),
    "openclaw-user-turn-persist-",
  );
  beforeEach(() => setRuntimeConfigSnapshot({}));
  const unusedRecorderTarget = {
    agentId: "main",
    sessionEntry: undefined,
    sessionId: "unused-session",
    sessionKey: "agent:main:unused",
    storePath: "/tmp/openclaw-unused-sessions.json",
  };

  function userInput(text: string, idempotencyKey?: string) {
    return { text, timestamp: 123, ...(idempotencyKey ? { idempotencyKey } : {}) };
  }

  function record(
    input: UserTurnInput,
    target: Parameters<typeof createUserTurnTranscriptRecorder>[0]["target"] = unusedRecorderTarget,
    options: Omit<Parameters<typeof createUserTurnTranscriptRecorder>[0], "input" | "target"> = {},
  ) {
    return createUserTurnTranscriptRecorder({ input, target, ...options });
  }

  function expectStored(
    target: Parameters<typeof readTranscriptMessages>[0],
    message: Record<string, unknown>,
  ) {
    return expect(readTranscriptMessages(target)).resolves.toEqual([
      expect.objectContaining(message),
    ]);
  }

  describe("trusted human transcript ownership", () => {
    it("normalizes synthetic owner facts after asynchronous input resolution", async () => {
      const provenance = { kind: "inter_session" as const, sourceTool: "sessions_send" };
      const sender = { id: "author", identity: { type: "profile" as const, id: "author" } };
      const recorder = record({ text: "owner prompt", senderIsOwner: true, sender }, undefined, {
        resolveInput: async () => ({
          text: "synthetic handoff",
          senderIsOwner: true,
          sender,
          provenance,
        }),
      });
      expect(recorder.message).toMatchObject({
        __openclaw: { senderIsOwner: true, senderIdentity: sender.identity },
      });
      const resolved = await recorder.resolveMessage();
      expect(resolved).toMatchObject({
        provenance,
        __openclaw: { senderIsOwner: false },
      });
      expect(resolved).not.toHaveProperty("__openclaw.senderIdentity");
    });
  });

  describe("mergePreparedUserTurnMessageForRuntime", () => {
    it("adds prepared transcript metadata to runtime user messages", () => {
      const recorder = record({
        text: "display prompt",
        media: [{ path: "/tmp/image.png", contentType: "image/png" }],
        sender: { id: "user-42", name: "Ada" },
        timestamp: 123,
      });

      expect(
        mergePreparedUserTurnMessageForRuntime({
          runtimeMessage: castAgentMessage({
            role: "user",
            content: "runtime prompt",
            provenance: { sourceChannel: "telegram" },
            __openclaw: { mirrorIdentity: "run-1:prompt" },
          }),
          preparedMessage: recorder.message,
        }),
      ).toMatchObject({
        role: "user",
        content: "display prompt",
        provenance: { sourceChannel: "telegram" },
        timestamp: 123,
        __openclaw: {
          mirrorIdentity: "run-1:prompt",
          senderId: "user-42",
          senderName: "Ada",
          media: [expect.objectContaining({ path: "/tmp/image.png", contentType: "image/png" })],
        },
      });
    });

    it("does not replace blocked before_agent_run user markers", () => {
      const recorder = record({ text: "raw prompt" });
      const blocked = castAgentMessage({
        role: "user",
        content: "[blocked]",
        __openclaw: { beforeAgentRunBlocked: true },
      });

      expect(
        mergePreparedUserTurnMessageForRuntime({
          runtimeMessage: blocked,
          preparedMessage: recorder.message,
        }),
      ).toBe(blocked);
    });

    it("preserves runtime multimodal content while merging prepared metadata", () => {
      const recorder = record(userInput("canonical image caption"));
      const runtimeContent = [
        { type: "text", text: "canonical image caption" },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      ];

      expect(
        mergePreparedUserTurnMessageForRuntime({
          runtimeMessage: castAgentMessage({
            role: "user",
            content: runtimeContent,
          }),
          preparedMessage: recorder.message,
        }),
      ).toMatchObject({
        role: "user",
        content: runtimeContent,
        timestamp: 123,
      });
    });
  });

  describe("resolvePersistedUserTurnText", () => {
    it("preserves historical placeholder-like text as ordinary transcript content", () => {
      expect(resolvePersistedUserTurnText("<media:image> (2 images)")).toBe(
        "<media:image> (2 images)",
      );
    });
  });

  it.each([null, { version: 2, text: "stored" }, { version: 1, text: 42 }])(
    "refuses unsupported or malformed model prompt projections: %j",
    (modelPromptProjection) => {
      expect(() =>
        readModelPromptProjection({
          role: "user",
          content: "original",
          __openclaw: { modelPromptProjection },
        }),
      ).toThrow("update OpenClaw to a compatible version or start a new session");
    },
  );

  describe("persistUserTurnTranscript", () => {
    it("resolves the session file and persists the user turn", async () => {
      const dir = sessionDirs.make();
      const target = createSqliteTranscriptTarget({ dir });
      const sessionStore = {
        [target.sessionKey]: {
          sessionId: target.sessionId,
          sessionFile: target.sqliteMarker,
          updatedAt: 1,
        },
      };

      const persisted = await persistUserTurnTranscript({
        sessionId: target.sessionId,
        sessionKey: target.sessionKey,
        sessionEntry: sessionStore[target.sessionKey],
        sessionStore,
        storePath: target.storePath,
        agentId: target.agentId,
        cwd: dir,
        input: {
          text: "hello",
          timestamp: 123,
        },
        updateMode: "none",
      });

      expect(persisted?.sessionFile).toBe(target.sessionKey);
      await expect(readTranscriptMessages(target)).resolves.toEqual([
        expect.objectContaining({
          role: "user",
          content: "hello",
        }),
      ]);
    });
  });

  describe("createUserTurnTranscriptRecorder", () => {
    it("captures the current stored message and reuses a projection written by another recorder", async () => {
      const target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
      const input = userInput("original", "shared-projection");
      const first = record(input, target);
      const second = record(input, target);
      await first.persistApproved();
      await second.persistApproved();
      await rewritePreparedTranscriptMessageAtAnchor(first.getAdmissionReceipt()!, (message) => {
        if (!isUserMessage(message)) {
          throw new Error("Expected the persisted user message");
        }
        return { ...message, independentMetadata: "preserved" };
      });

      const captured = await first.captureModelPromptProjection!("enriched", () => {});
      expect(captured).toMatchObject({ content: "original", independentMetadata: "preserved" });
      expect(await second.captureModelPromptProjection!("enriched", () => {})).toEqual(captured);
      await expect(second.captureModelPromptProjection!("changed", () => {})).rejects.toThrow(
        "cannot be changed",
      );
      await expect(readTranscriptMessages(target)).resolves.toEqual([captured]);
    });

    it("freezes the original prompt after initial steering and across reopened recorders", async () => {
      const target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
      const input = userInput("original prompt", "projection:user");
      const recorder = record(input, target);
      await recorder.persistApproved();
      const steering = record(
        { text: "initial steering", timestamp: 124, idempotencyKey: "steering:user" },
        target,
      );
      const steered = await steering.persistApproved();
      const text = "prepend\n\nreplacement model prompt\n\nappend";
      const captured = await recorder.captureModelPromptProjection!(text, () => {});
      recorder.markSentToProvider?.();
      const generation = recorder.getAdmissionReceipt()?.generation;

      expect(captured).toMatchObject({ content: input.text, timestamp: input.timestamp });
      expect(await recorder.captureModelPromptProjection!(text, () => {})).toEqual(captured);
      expect(recorder.getAdmissionReceipt()?.generation).toBe(generation);
      await expect(
        recorder.captureModelPromptProjection!("different hook output", () => {}),
      ).rejects.toThrow("cannot be changed");

      const reopened = record(input, target);
      await reopened.persistApproved();
      expect(readModelPromptProjection(reopened.getPersistedMessage?.())).toBe(text);
      expect(await reopened.captureModelPromptProjection!(text, () => {})).toEqual(captured);
      await expect(
        reopened.captureModelPromptProjection!("different hook output", () => {}),
      ).rejects.toThrow("cannot be changed");
      await expect(readTranscriptMessages(target)).resolves.toEqual([captured, steered?.message]);
    });

    it("preserves capture, dispatch, and replay bytes despite logging patterns", async () => {
      const target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
      const input = userInput("private", "fidelity:user");
      const loggingTarget = { ...target, config: { logging: { redactPatterns: ["private"] } } };
      const recorder = record(input, { ...target, config: { logging: { redactPatterns: [] } } });
      await recorder.persistApproved({ target: loggingTarget });
      const rawProjection = "prepend\n\nprivate\n\nappend";
      const captured = await recorder.captureModelPromptProjection!(rawProjection, () => {});
      const expected = rawProjection;
      expect(captured.content).toBe(input.text);
      expect(readModelPromptProjection(captured)).toBe(expected);
      expect(projectRecordedModelPrompt(makeUserMessage(input.text, 123), captured)).toMatchObject({
        content: expected,
      });
      recorder.markSentToProvider?.();
      expect(await recorder.captureModelPromptProjection!(rawProjection, () => {})).toEqual(
        captured,
      );
      const stored = await readTranscriptMessages(target);
      expect(stored).toEqual([captured]);
      expect(stored[0]?.content).toBe(input.text);

      const reopened = record(input, loggingTarget);
      await reopened.persistApproved();
      const replay = await reopened.captureModelPromptProjection!(rawProjection, () => {});
      expect(readModelPromptProjection(replay)).toBe(expected);
      expect(projectRecordedModelPrompt(replay)).toMatchObject({ content: expected });
    });

    it("rechecks authority after pending persistence before capturing a projection", async () => {
      const target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
      const recorder = record({ text: "original" }, target);
      await recorder.persistApproved();
      const pending = createDeferred();
      recorder.markRuntimePersistencePending(pending.promise);
      let current = true;
      const capture = recorder.captureModelPromptProjection!("enriched", () => {
        if (!current) {
          throw new Error("retired turn");
        }
      });
      const rejection = expect(capture).rejects.toThrow("retired turn");
      current = false;
      pending.resolve();
      await rejection;

      const [stored] = await readTranscriptMessages(target);
      expect(stored).toMatchObject({ content: "original" });
      expect(readModelPromptProjection(stored)).toBeUndefined();
    });

    it("never attaches an uncaptured projection to a sent or replaced user turn", async () => {
      const target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
      const recorder = record({ text: "original" }, target);
      await recorder.persistApproved();
      await replaceTranscriptEvents(target, [
        {
          type: "message",
          id: "replacement",
          parentId: null,
          message: makeUserMessage("new turn", 123),
        },
      ]);
      await expect(recorder.captureModelPromptProjection!("enriched", () => {})).rejects.toThrow(
        "session writer claim changed",
      );
      const [replacement] = await readTranscriptMessages(target);
      expect(replacement).toMatchObject({ content: "new turn" });
      expect(readModelPromptProjection(replacement)).toBeUndefined();

      const sent = record({ text: "already sent" }, target);
      await sent.persistApproved();
      sent.markSentToProvider?.();
      await expect(sent.captureModelPromptProjection!("too late", () => {})).rejects.toThrow(
        "before provider dispatch",
      );
      expect(readModelPromptProjection(sent.getPersistedMessage?.())).toBeUndefined();
    });

    it("persists fallback user turns only once", async () => {
      const target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
      const persistedMessages: unknown[] = [];
      const recorder = record(userInput("hello from fallback", "chat-run-1:user"), target, {
        updateMode: "none",
        onMessagePersisted: (message) => {
          persistedMessages.push(message);
        },
      });
      expect(recorder.getPersistedMessage?.()).toBeUndefined();

      const [first, second] = await Promise.all([
        recorder.persistFallback(),
        recorder.persistFallback(),
      ]);

      expect(first?.messageId).toBeTruthy();
      expect(second?.messageId).toBe(first?.messageId);
      expect(recorder.getPersistedMessage?.()).toEqual(first?.message);
      expect(persistedMessages).toEqual([first?.message]);
      await expectStored(target, {
        role: "user",
        content: "hello from fallback",
        idempotencyKey: "chat-run-1:user",
      });
    });

    it.each(["capture", "dispatch"] as const)(
      "appends #99495 media during %s without changing the admitted turn",
      async (timing) => {
        const dir = sessionDirs.make();
        const target = createSqliteTranscriptTarget({ dir });
        const admittedInput = {
          text: "describe @Ada",
          timestamp: 123,
          idempotencyKey: "chat-run-late:user",
          mentions: [{ profileId: "ada", start: 9, end: 13 }],
        };
        const committedEntries: string[] = [];
        const resolverStarted = createDeferred();
        const mediaInput = createDeferred<UserTurnInput>();
        const recorder = createUserTurnTranscriptRecorder({
          input: admittedInput,
          onOriginalInputCommitted: ({ anchor }) => committedEntries.push(anchor.entryId),
          resolveInput: async () => {
            resolverStarted.resolve();
            return await mediaInput.promise;
          },
          beforeMessageWrite: ({ message }) =>
            castAgentMessage({
              ...(message as unknown as Record<string, unknown>),
              __openclaw: { hookOwned: true },
            }),
          target,
        });
        const persistence = recorder.persistFallback();
        await resolverStarted.promise;
        const admitted = await persistUserTurnTranscript({
          ...target,
          input: admittedInput,
        });
        expect(admitted).toBeDefined();
        recorder.markRuntimePersisted(recorder.message, admitted?.admission, {
          appended: admitted?.appended === true,
        });
        const captureWait = createDeferred();
        if (timing === "capture") {
          recorder.markRuntimePersistencePending(captureWait.promise);
        }
        const projection = recorder.captureModelPromptProjection!(
          "enriched describe @Ada",
          () => {},
        );
        if (timing === "dispatch") {
          await projection;
          recorder.markSentToProvider?.();
        }
        mediaInput.resolve({
          ...admittedInput,
          media: [{ path: path.join(dir, "image.png"), contentType: "image/png" }],
        });

        await persistence;
        captureWait.resolve();
        await projection;

        expect(recorder.getAdmissionReceipt()).toMatchObject({ entryId: admitted?.messageId });
        expect(recorder.getPersistedMessage?.()).toMatchObject({
          content: "describe @Ada",
          idempotencyKey: "chat-run-late:user",
        });
        expect(committedEntries).toEqual([admitted?.messageId]);
        const messages = await readTranscriptMessages(target);
        expect(messages).toEqual([
          expect.objectContaining({
            content: "describe @Ada",
            idempotencyKey: "chat-run-late:user",
            __openclaw: {
              humanMentions: admittedInput.mentions,
              modelPromptProjection: { version: 1, text: "enriched describe @Ada" },
            },
          }),
          expect.objectContaining({
            content: "",
            idempotencyKey: "chat-run-late:user:late-media",
            __openclaw: {
              hookOwned: true,
              lateMedia: true,
              media: [expect.objectContaining({ path: path.join(dir, "image.png") })],
            },
          }),
        ]);
        expect(readModelPromptProjection(messages[1])).toBeUndefined();
        const lateProjection = buildLateMediaAttachedProjection(castAgentMessage(messages[1]));
        expect(lateProjection.text).toBe(`[media attached: ${path.join(dir, "image.png")}]`);
        expect(lateProjection.media).toEqual([
          expect.objectContaining({
            path: path.join(dir, "image.png"),
            contentType: "image/png",
            kind: "image",
          }),
        ]);
      },
    );

    it.each(["sent", "blocked"] as const)(
      "retires the pending admission view when %s",
      async (state) => {
        const dir = sessionDirs.make();
        const target = createSqliteTranscriptTarget({ dir });
        const recorder = record(
          {
            text: "admit exactly once",
            idempotencyKey: "receipt:user",
          },
          target,
        );

        const persisted = await recorder.persistApproved();

        expect(persisted).toBeDefined();
        expect(recorder.getAdmissionReceipt()).toBe(persisted?.admission);
        expect(recorder.getAdmissionReceipt()).toMatchObject({
          entryId: persisted?.messageId,
          agentId: target.agentId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          idempotencyKey: "receipt:user",
          logicalTurnId: expect.any(String),
          role: "user",
        });

        const pending = readPendingUserTurnTranscriptAdmission(recorder);
        expect(pending).toEqual(persisted?.admission);
        expect(pending).not.toBe(recorder.getAdmissionReceipt());
        expect(readPendingUserTurnTranscriptAdmission({ ...recorder })).toBeUndefined();
        if (state === "sent") {
          recorder.markSentToProvider?.();
        } else {
          recorder.markBlocked();
        }
        expect(readPendingUserTurnTranscriptAdmission(recorder)).toBeUndefined();
      },
    );

    it("adds confirmed steering provenance after runtime persistence", async () => {
      const target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
      const input = {
        text: "tighten the answer",
        idempotencyKey: "confirm-steer:user",
        sender: { id: "operator-1", name: "Operator" },
      };
      const recorder = record(input, target);
      const persisted = await persistUserTurnTranscript({ ...target, input });
      expect(persisted).toBeDefined();
      recorder.markRuntimePersisted(persisted?.message, persisted?.admission);
      const initialGeneration = recorder.getAdmissionReceipt()?.generation;

      const admission = recorder.getAdmissionReceipt();
      if (!admission) {
        throw new Error("missing persisted admission");
      }
      const { db } = openOpenClawAgentDatabase({
        agentId: target.agentId,
        path: admission.storePath,
      });
      const work = trackSqliteStatementExecutions(
        requireNativeSqliteDatabase(db),
        ["fts", "size"],
        (sql) =>
          /\bsession_transcript_fts\b/i.test(sql)
            ? "fts"
            : sql.includes("octet_length")
              ? "size"
              : null,
      );
      try {
        await recorder.confirmSteerTargetRunIdForPersistence?.("active-run");
      } finally {
        work.restore();
      }
      expect(work.counts).toEqual({ fts: 0, size: 0 });

      expect(recorder.getAdmissionReceipt()?.generation).toBe(initialGeneration);
      expect(recorder.getPersistedMessage?.()).toMatchObject({
        __openclaw: {
          senderId: "operator-1",
          senderName: "Operator",
          steerTargetRunId: "active-run",
        },
      });
      await expectStored(target, {
        __openclaw: {
          senderId: "operator-1",
          senderName: "Operator",
          steerTargetRunId: "active-run",
        },
      });
    });

    it("waits for a deferred projection rebuild before returning admission identity", async () => {
      const target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
      const committedEntries: string[] = [];
      await replaceSessionEntry(
        { storePath: target.storePath, sessionKey: target.sessionKey },
        {
          sessionId: target.sessionId,
          sessionFile: target.sqliteMarker,
          updatedAt: 1,
        },
      );
      await persistSessionTranscriptTurn(target, {
        messages: [
          transcriptMessage("root", null, { role: "user", content: "root" }),
          transcriptMessage("inactive", "root", { role: "assistant", content: "inactive" }),
          transcriptMessage("active", "root", { role: "assistant", content: "active" }),
        ],
        touchSessionEntry: false,
      });
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "admit after rebuild", idempotencyKey: "projection:user" },
        target,
        onOriginalInputCommitted: ({ anchor }) => committedEntries.push(anchor.entryId),
      });

      const persisted = await recorder.persistApproved({ expectedSessionId: target.sessionId });

      expect(persisted).toBeDefined();
      expect(committedEntries).toEqual([persisted?.messageId]);
      expect(persisted?.admission).toMatchObject({
        entryId: persisted?.messageId,
        sessionId: target.sessionId,
        idempotencyKey: "projection:user",
      });
    });

    it("preserves distinct text supplied with late-resolved media", async () => {
      const dir = sessionDirs.make();
      const target = createSqliteTranscriptTarget({ dir });
      const admittedInput = userInput("describe this", "chat-run-late-caption:user");
      const resolverStarted = createDeferred();
      const mediaInput = createDeferred<UserTurnInput>();
      const recorder = createUserTurnTranscriptRecorder({
        input: admittedInput,
        resolveInput: async () => {
          resolverStarted.resolve();
          return await mediaInput.promise;
        },
        target,
      });
      const persistence = recorder.persistFallback();
      await resolverStarted.promise;
      await persistUserTurnTranscript({ ...target, input: admittedInput });
      recorder.markRuntimePersisted(recorder.message);
      recorder.markSentToProvider?.();
      mediaInput.resolve({
        ...admittedInput,
        text: "resolved subtitle",
        media: [{ path: path.join(dir, "image.png"), contentType: "image/png" }],
      });

      await persistence;

      await expect(readTranscriptMessages(target)).resolves.toEqual([
        expect.objectContaining({ content: "describe this" }),
        expect.objectContaining({
          content: "resolved subtitle",
          __openclaw: {
            lateMedia: true,
            media: [{ path: path.join(dir, "image.png"), contentType: "image/png" }],
          },
        }),
      ]);
    });

    it("falls back to the admitted text message when lazy media resolution fails", async () => {
      const target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
      const errors: unknown[] = [];
      const recorder = record(userInput("keep the prompt", "chat-run-lazy-failed:user"), target, {
        resolveInput: async () => {
          throw new Error("media staging failed");
        },
        updateMode: "none",
        onPersistenceError: (error) => errors.push(error),
      });

      const persisted = await recorder.persistFallback();

      expect(errors).toHaveLength(1);
      expect(persisted?.message).toMatchObject({
        role: "user",
        content: "keep the prompt",
        idempotencyKey: "chat-run-lazy-failed:user",
      });
      expect(persisted?.message).not.toHaveProperty("MediaPath");
      await expectStored(target, {
        role: "user",
        content: "keep the prompt",
        idempotencyKey: "chat-run-lazy-failed:user",
      });
    });

    it("does not fallback-persist after before_agent_run blocks the turn", async () => {
      const target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
      const recorder = record(userInput("raw blocked prompt"), target, {
        updateMode: "none",
      });

      recorder.markBlocked();

      await expect(recorder.persistFallback()).resolves.toBeUndefined();
      await expect(readTranscriptMessages(target)).resolves.toEqual([]);
    });

    it("uses the runtime target supplied at approved persistence time", async () => {
      const dir = sessionDirs.make();
      const staleTarget = createSqliteTranscriptTarget({ dir, sessionId: "stale-session" });
      const admittedTarget = createSqliteTranscriptTarget({ dir, sessionId: "admitted-session" });
      const recorder = record(userInput("persist me in the admitted session"), staleTarget, {
        updateMode: "none",
      });

      const persisted = await recorder.persistApproved({
        target: admittedTarget,
      });

      expect(persisted?.sessionFile).toBe(admittedTarget.sessionKey);
      await expect(readTranscriptMessages(staleTarget)).resolves.toEqual([]);
      await expectStored(admittedTarget, {
        role: "user",
        content: "persist me in the admitted session",
      });
    });

    it("keeps concurrent persistence retries single-flight", async () => {
      const dir = sessionDirs.make();
      const admittedTarget = createSqliteTranscriptTarget({ dir, sessionId: "admitted-session" });
      let targetResolutionCount = 0;
      const recorder = createUserTurnTranscriptRecorder({
        input: userInput("persist me once after concurrent retries"),
        target: () => {
          targetResolutionCount += 1;
          return targetResolutionCount === 1 ? undefined : admittedTarget;
        },
        updateMode: "none",
      });

      await expect(recorder.persistApproved({ retryIfUnpersisted: true })).resolves.toBeUndefined();
      const [first, second] = await Promise.all([
        recorder.persistApproved({ retryIfUnpersisted: true }),
        recorder.persistApproved({ retryIfUnpersisted: true }),
      ]);

      expect(targetResolutionCount).toBe(2);
      expect(first?.sessionFile).toBe(admittedTarget.sessionKey);
      expect(second?.sessionFile).toBe(admittedTarget.sessionKey);
      await expectStored(admittedTarget, {
        role: "user",
        content: "persist me once after concurrent retries",
      });
    });

    it("waits for runtime persistence before deciding fallback ownership", async () => {
      const target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
      const runtimePersistenceStarted = createDeferred();
      const recorder = record(userInput("pending runtime turn"), target, {
        updateMode: "none",
      });
      recorder.markRuntimePersistencePending(
        runtimePersistenceStarted.promise.then(() => {
          recorder.markRuntimePersisted(makeUserMessage("pending runtime turn", 123));
        }),
      );

      let fallbackSettled = false;
      const fallback = recorder.persistFallback().then((result) => {
        fallbackSettled = true;
        return result;
      });

      await Promise.resolve();
      expect(fallbackSettled).toBe(false);

      runtimePersistenceStarted.resolve();

      await expect(fallback).resolves.toBeUndefined();
      await expect(readTranscriptMessages(target)).resolves.toEqual([]);
    });

    it("fallback-persists when pending runtime persistence fails", async () => {
      const target = createSqliteTranscriptTarget({ dir: sessionDirs.make() });
      const errors: unknown[] = [];
      const runtimePersistence = createDeferred();
      const recorder = record(userInput("pending failed turn"), target, {
        updateMode: "none",
        onPersistenceError: (error) => errors.push(error),
      });
      recorder.markRuntimePersistencePending(runtimePersistence.promise);

      const fallback = recorder.persistFallback();
      runtimePersistence.reject(new Error("runtime append failed"));
      const persisted = await fallback;

      expect(errors).toHaveLength(1);
      expect(persisted?.message).toMatchObject({
        role: "user",
        content: "pending failed turn",
      });
      await expectStored(target, { role: "user", content: "pending failed turn" });
    });
  });
});
