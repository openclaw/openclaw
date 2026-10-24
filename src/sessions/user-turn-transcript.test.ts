import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { castAgentMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
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
import {
  capturePreparedTranscriptModelPromptProjection,
  rewritePreparedTranscriptMessageAtAnchor,
} from "../config/sessions/session-message-rewrite.js";
import { transcriptMessage } from "../config/sessions/transcript-message.test-support.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  readPendingUserTurnTranscriptAdmission,
  readUserTurnRequesterOrigin,
} from "./user-turn-transcript-admission.js";
import {
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
  const makeTarget = (sessionId?: string, dir = sessionDirs.make()) =>
    createSqliteTranscriptTarget({ dir, sessionId });
  let defaultTarget: ReturnType<typeof makeTarget> | undefined;
  beforeEach(() => {
    defaultTarget = undefined;
    setRuntimeConfigSnapshot({});
  });
  const getTarget = () => (defaultTarget ??= makeTarget());
  const readMessages = () => readTranscriptMessages(getTarget());

  function userInput(text: string, idempotencyKey?: string) {
    return { text, timestamp: 123, ...(idempotencyKey ? { idempotencyKey } : {}) };
  }

  function record(
    input: UserTurnInput,
    target: Parameters<typeof createUserTurnTranscriptRecorder>[0]["target"] = getTarget,
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

  async function startLateMedia(input: UserTurnInput, options: Parameters<typeof record>[2] = {}) {
    const dir = sessionDirs.make();
    const target = makeTarget(undefined, dir);
    const resolverStarted = createDeferred();
    const mediaInput = createDeferred<UserTurnInput>();
    const committedEntries: string[] = [];
    const recorder = record(input, target, {
      onOriginalInputCommitted: ({ anchor }) => committedEntries.push(anchor.entryId),
      resolveInput: async () => {
        resolverStarted.resolve();
        return await mediaInput.promise;
      },
      ...options,
    });
    const persistence = recorder.persistFallback();
    await resolverStarted.promise;
    const admitted = await persistUserTurnTranscript({ ...target, input });
    expect(admitted).toBeDefined();
    return { dir, target, recorder, persistence, admitted, mediaInput, committedEntries };
  }

  describe("trusted human transcript ownership", () => {
    it("keeps producer requester custody through staging, replay, and collection", async () => {
      const target = makeTarget();
      await replaceSessionEntry(target, { sessionId: target.sessionId, updatedAt: 1 });
      const requesterOrigin = {
        sessionKey: "agent:main:telegram:group:requesters",
        messageProvider: "telegram",
        senderId: "bob",
      };
      const original = structuredClone(requesterOrigin);
      const input = { text: "continue", idempotencyKey: "requester-custody:user", requesterOrigin };
      const resolvingTarget = createDeferred();
      const releaseTarget = createDeferred();
      const recorder = createUserTurnTranscriptRecorder({
        input,
        trackInputCompletion: true,
        pendingInputRequestFingerprint: "authenticated-requester-custody",
        target: async () => {
          resolvingTarget.resolve();
          await releaseTarget.promise;
          return target;
        },
      });
      const exposedMessage = expectDefined(recorder.message, "producer message");
      const copied = createUserTurnTranscriptRecorder({
        message: { ...structuredClone(exposedMessage), idempotencyKey: "copied-custody:user" },
        target,
      });
      const recorders = [recorder, copied];
      requesterOrigin.senderId = "alice";
      requesterOrigin.sessionKey = "agent:main:replacement";
      exposedMessage["__openclaw"] = { requesterOrigin: { ...original, senderId: "alice" } };
      expect(readUserTurnRequesterOrigin(recorder)).toMatchObject(original);
      expect(readUserTurnRequesterOrigin({ ...recorder })).toBeUndefined();
      expect(readUserTurnRequesterOrigin(copied)).toBeUndefined();
      try {
        const staging = recorder.stageApproved!({
          runId: "requester-custody",
          assertCurrent: () => {},
        });
        await awaitGateBeforeSettlement(
          resolvingTarget.promise,
          staging,
          "staging settled before resolving its target",
        );
        exposedMessage["__openclaw"] = { requesterOrigin: { ...original, senderId: "carol" } };
        releaseTarget.resolve();
        expect(await staging).toBe(true);
        expect(readUserTurnRequesterOrigin(recorder)).toMatchObject(original);
        expect(recorder.getPendingInputMessage?.()?.["__openclaw"]?.requesterOrigin).toMatchObject(
          original,
        );

        expect(
          await copied.stageApproved!({ runId: "copied-custody", assertCurrent: () => {} }),
        ).toBe(true);
        expect(readUserTurnRequesterOrigin(copied)).toBeUndefined();
        expect(copied.getPendingInputMessage?.()).not.toHaveProperty("__openclaw.requesterOrigin");
        await copied.persistApproved();

        recorder.finishPendingInput?.("interrupted");
        await recorder.waitForPendingInputSettlement?.();
        const replay = createUserTurnTranscriptRecorder({
          input: { text: input.text, idempotencyKey: input.idempotencyKey },
          assertOriginalInputCommit: Object.assign(
            () => {
              throw new Error("Accepted input no longer belongs to its original source");
            },
            {
              prepareSessionSourceScope: async () => {
                throw new Error("Accepted input must not prepare its original source again");
              },
            },
          ),
          trackInputCompletion: true,
          pendingInputRequestFingerprint: "authenticated-requester-custody",
          target,
        });
        recorders.push(replay);
        expect(
          await replay.stageApproved!({ runId: "requester-custody", assertCurrent: () => {} }),
        ).toBe(true);
        expect(readUserTurnRequesterOrigin(replay)).toMatchObject(original);
        const aggregate = createUserTurnTranscriptRecorder({
          input: {
            text: "Collected original request",
            idempotencyKey: "collected-custody:user",
            requesterOrigin: readUserTurnRequesterOrigin(replay),
          },
          pendingInputSources: [replay],
          target,
        });
        recorders.push(aggregate);
        expectDefined(aggregate.message, "collected message")["__openclaw"] = {
          requesterOrigin: { ...original, senderId: "alice" },
        };
        const result = await aggregate.persistApproved();
        expect(result?.message["__openclaw"]?.requesterOrigin).toMatchObject(original);
        const messages = await readTranscriptMessages(target);
        expect(messages).toHaveLength(2);
        expect(messages[0]).not.toHaveProperty("__openclaw.requesterOrigin");
        expect(messages[1]).toHaveProperty("__openclaw.requesterOrigin", original);
      } finally {
        releaseTarget.resolve();
        for (const current of recorders) {
          current.finishPendingInput?.("interrupted");
        }
        await Promise.all(
          recorders.map(async (current) => current.waitForPendingInputSettlement?.()),
        );
      }
    });

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
    const image = { path: "/tmp/image.png", contentType: "image/png" };
    const multimodal = [
      { type: "text", text: "canonical image caption" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ];
    it.each([
      { name: "text", runtimeContent: "runtime prompt", expectedContent: "display prompt" },
      { name: "multimodal", runtimeContent: multimodal, expectedContent: multimodal },
    ])(
      "merges prepared metadata while preserving $name content rules",
      ({ runtimeContent, expectedContent }) => {
        const prepared = record({
          ...userInput("display prompt"),
          media: [image],
          sender: { id: "user-42", name: "Ada" },
        }).message;
        const provenance = { sourceChannel: "telegram" };
        expect(
          mergePreparedUserTurnMessageForRuntime({
            runtimeMessage: castAgentMessage({
              role: "user",
              content: runtimeContent,
              provenance,
              __openclaw: { mirrorIdentity: "run-1:prompt" },
            }),
            preparedMessage: prepared,
          }),
        ).toMatchObject({
          role: "user",
          content: expectedContent,
          timestamp: 123,
          provenance,
          __openclaw: {
            mirrorIdentity: "run-1:prompt",
            senderId: "user-42",
            senderName: "Ada",
            media: [expect.objectContaining(image)],
          },
        });
      },
    );
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

  describe("createUserTurnTranscriptRecorder", () => {
    it("adopts a prepared projection only after commitment and reuses it from another recorder", async () => {
      const input = userInput("original", "shared-projection");
      const first = record(input);
      const second = record(input);
      await first.persistApproved();
      await second.persistApproved();
      await rewritePreparedTranscriptMessageAtAnchor(first.getAdmissionReceipt()!, (message) => {
        if (!isUserMessage(message)) {
          throw new Error("Expected the persisted user message");
        }
        return { ...message, independentMetadata: "preserved" };
      });

      const previous = first.getPersistedMessage?.();
      const admission = first.getAdmissionReceipt();
      const prepared = expectDefined(
        await first.prepareModelPromptProjection!("enriched", () => {}),
        "prepared projection",
      );
      expect(first.getPersistedMessage?.()).toBe(previous);
      expect(first.getAdmissionReceipt()).toBe(admission);
      expect(readModelPromptProjection((await readMessages())[0])).toBeUndefined();

      const committed = await capturePreparedTranscriptModelPromptProjection(
        prepared.intent.anchor,
        prepared.intent.text,
        () => {},
      );
      const captured = await prepared.onCommitted(committed);
      expect(captured).toMatchObject({ content: "original", independentMetadata: "preserved" });
      expect(readModelPromptProjection(previous)).toBeUndefined();
      expect(first.getPersistedMessage?.()).toBe(captured);
      expect(first.getAdmissionReceipt()?.generation).toBe(committed?.generation);
      expect(await first.prepareModelPromptProjection!("enriched", () => {})).toBeUndefined();
      expect(await second.captureModelPromptProjection!("enriched", () => {})).toEqual(captured);
      expect(second.getAdmissionReceipt()?.generation).toBe(committed?.generation);
      await expect(second.captureModelPromptProjection!("changed", () => {})).rejects.toThrow(
        "cannot be changed",
      );
      await expect(readMessages()).resolves.toEqual([captured]);
    });

    it("freezes capture, dispatch, and replay bytes after steering despite logging patterns", async () => {
      const target = makeTarget();
      const input = userInput("private", "fidelity:user");
      const loggingTarget = { ...target, config: { logging: { redactPatterns: ["private"] } } };
      const recorder = record(input, { ...target, config: { logging: { redactPatterns: [] } } });
      await recorder.persistApproved({ target: loggingTarget });
      const steered = await record(
        { text: "initial steering", timestamp: 124, idempotencyKey: "steering:user" },
        target,
      ).persistApproved();
      const rawProjection = "prepend\n\nprivate\n\nappend";
      const captured = await recorder.captureModelPromptProjection!(rawProjection, () => {});
      const generation = recorder.getAdmissionReceipt()?.generation;
      expect(captured).toMatchObject({ content: input.text, timestamp: input.timestamp });
      expect(readModelPromptProjection(captured)).toBe(rawProjection);
      expect(projectRecordedModelPrompt(makeUserMessage(input.text, 123), captured)).toMatchObject({
        content: rawProjection,
      });
      recorder.markSentToProvider?.();
      const reopened = record(input, loggingTarget);
      await reopened.persistApproved();
      for (const current of [recorder, reopened]) {
        expect(readModelPromptProjection(current.getPersistedMessage?.())).toBe(rawProjection);
        const replay = await current.captureModelPromptProjection!(rawProjection, () => {});
        expect(replay).toEqual(captured);
        expect(current.getAdmissionReceipt()?.generation).toBe(generation);
        expect(projectRecordedModelPrompt(replay)).toMatchObject({ content: rawProjection });
        await expect(
          current.captureModelPromptProjection!("different hook output", () => {}),
        ).rejects.toThrow("cannot be changed");
      }
      await expect(readTranscriptMessages(target)).resolves.toEqual([captured, steered?.message]);
    });

    it("rechecks authority after pending persistence before capturing a projection", async () => {
      const recorder = record({ text: "original" });
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

      const [stored] = await readMessages();
      expect(stored).toMatchObject({ content: "original" });
      expect(readModelPromptProjection(stored)).toBeUndefined();
    });

    it("never attaches an uncaptured projection to a sent or replaced user turn", async () => {
      const recorder = record({ text: "original" });
      await recorder.persistApproved();
      await replaceTranscriptEvents(getTarget(), [
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
      const [replacement] = await readMessages();
      expect(replacement).toMatchObject({ content: "new turn" });
      expect(readModelPromptProjection(replacement)).toBeUndefined();

      const sent = record({ text: "already sent" });
      await sent.persistApproved();
      sent.markSentToProvider?.();
      await expect(sent.captureModelPromptProjection!("too late", () => {})).rejects.toThrow(
        "before provider dispatch",
      );
      expect(readModelPromptProjection(sent.getPersistedMessage?.())).toBeUndefined();
    });

    it("persists fallback user turns only once", async () => {
      const persistedMessages: unknown[] = [];
      const recorder = record(userInput("hello from fallback", "chat-run-1:user"), undefined, {
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
      await expectStored(getTarget(), {
        role: "user",
        content: "hello from fallback",
        idempotencyKey: "chat-run-1:user",
      });
    });

    it.each(["capture", "dispatch"] as const)(
      "appends #99495 media during %s without changing the admitted turn",
      async (timing) => {
        const admittedInput = {
          text: "describe @Ada",
          timestamp: 123,
          idempotencyKey: "chat-run-late:user",
          mentions: [{ profileId: "ada", start: 9, end: 13 }],
        };
        const { dir, target, recorder, persistence, admitted, mediaInput, committedEntries } =
          await startLateMedia(admittedInput, {
            beforeMessageWrite: ({ message }) =>
              castAgentMessage({ ...message, __openclaw: { hookOwned: true } }),
          });
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
      },
    );

    it.each(["sent", "blocked"] as const)(
      "retires the pending admission view when %s",
      async (state) => {
        const target = getTarget();
        const recorder = record({ text: "admit exactly once", idempotencyKey: "receipt:user" });

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
      const target = makeTarget();
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
      const expected = {
        __openclaw: {
          senderId: "operator-1",
          senderName: "Operator",
          steerTargetRunId: "active-run",
        },
      };
      expect(recorder.getPersistedMessage?.()).toMatchObject(expected);
      await expectStored(target, expected);
    });

    it("waits for a deferred projection rebuild before returning admission identity", async () => {
      const target = makeTarget();
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
      const admittedInput = userInput("describe this", "chat-run-late-caption:user");
      const { dir, target, recorder, persistence, mediaInput } =
        await startLateMedia(admittedInput);
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

    it.each(["lazy media", "pending runtime"] as const)(
      "fallback-persists when %s fails",
      async (source) => {
        const errors: unknown[] = [];
        const failure = new Error(`${source} failed`);
        const runtimePersistence = createDeferred();
        const recorder = record(userInput("keep the prompt", "failed:user"), undefined, {
          resolveInput:
            source === "lazy media"
              ? async () => {
                  throw failure;
                }
              : undefined,
          updateMode: "none",
          onPersistenceError: (error) => errors.push(error),
        });
        if (source === "pending runtime") {
          recorder.markRuntimePersistencePending(runtimePersistence.promise);
        }
        const fallback = recorder.persistFallback();
        if (source === "pending runtime") {
          runtimePersistence.reject(failure);
        }
        const persisted = await fallback;
        const expected = {
          role: "user",
          content: "keep the prompt",
          idempotencyKey: "failed:user",
        };
        expect(errors).toHaveLength(1);
        expect(persisted?.message).toMatchObject(expected);
        expect(persisted?.message).not.toHaveProperty("MediaPath");
        await expectStored(getTarget(), expected);
      },
    );

    it("does not fallback-persist after before_agent_run blocks the turn", async () => {
      const recorder = record(userInput("raw blocked prompt"), undefined, {
        updateMode: "none",
      });

      recorder.markBlocked();

      await expect(recorder.persistFallback()).resolves.toBeUndefined();
      await expect(readMessages()).resolves.toEqual([]);
    });

    it("uses the runtime target supplied at approved persistence time", async () => {
      const dir = sessionDirs.make();
      const staleTarget = makeTarget("stale-session", dir);
      const admittedTarget = makeTarget("admitted-session", dir);
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
      const admittedTarget = makeTarget("admitted-session", dir);
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
      const runtimePersistenceStarted = createDeferred();
      const recorder = record(userInput("pending runtime turn"), undefined, {
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
      await expect(readMessages()).resolves.toEqual([]);
    });
  });
});
