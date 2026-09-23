import type { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "../../agents/embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import { observeReplyDelivery } from "../../agents/reply-completion.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  replaceSessionEntry,
  resolveSessionTranscriptDatabasePath,
} from "../../config/sessions/session-accessor.js";
import * as transcriptReconcile from "../../config/sessions/session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "../../config/sessions/session-transcript-reconcile.test-support.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import {
  attachSessionTranscriptRunId,
  emitSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntry } from "../session-utils.js";
import { createChatSendReplyDispatch } from "./chat-send-reply-dispatch.js";

vi.mock("node:worker_threads", async () =>
  (
    await import("../../config/sessions/session-transcript-reconcile.test-support.js")
  ).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();

it.each(["reply-observation", "commentary-media"] as const)(
  "cancels %s projection waiting without cancelling the shared rebuild or losing the answer",
  async (scenario) => {
    await withOpenClawTestState({ label: "chat-projection-cancel" }, async () => {
      const runId = "projection-run";
      const scope = {
        agentId: "main",
        sessionId: "projection-session",
        sessionKey: "agent:main:projection",
        storePath: loadSessionEntry("agent:main:projection", { agentId: "main" }).storePath,
      };
      const entry = { sessionId: scope.sessionId, lifecycleRevision: "initial", updatedAt: 1 };
      await replaceSessionEntry(scope, entry);
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "Inspect the fixture", idempotencyKey: `${runId}:user` },
        target: { ...scope, sessionEntry: entry },
      });
      await recorder.persistApproved();
      const controller = new AbortController();
      const warn = vi.fn();
      const dispatch = createChatSendReplyDispatch({
        accountId: undefined,
        isAgentRunStarted: () => true,
        isRunCurrent: () => true,
        abortSignal: controller.signal,
        logGateway: { warn } as never,
        session: {
          ...scope,
          backingSessionId: scope.sessionId,
          cfg: {},
          clientRunId: runId,
          sessionLoadOptions: { agentId: "main" },
        },
        userTurnRecorder: recorder,
      });
      const transcriptLifecycle = createEmbeddedAttemptTranscriptLifecycle({
        runId,
        sessionId: scope.sessionId,
      });
      const databaseOptions = {
        agentId: scope.agentId,
        path: resolveSessionTranscriptDatabasePath(scope),
      };
      const enteredWait = createDeferred();
      const waitForProjection = transcriptReconcile.waitForSessionTranscriptProjection;
      const waiting = vi
        .spyOn(transcriptReconcile, "waitForSessionTranscriptProjection")
        .mockImplementation((...args) => {
          const result = waitForProjection(...args);
          enteredWait.resolve();
          return result;
        });
      let stalledWorker: Worker | undefined;
      observer.beforeCreate = (filename, options) =>
        stalledWorker
          ? { filename, options }
          : { filename: "setInterval(() => {}, 1_000)", options: { eval: true } };
      observer.onTask = ({ worker }) => {
        stalledWorker ??= worker;
      };
      const mediaUrl = "https://example.test/retained-attachment.png";
      const message = attachSessionTranscriptRunId(
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `Fixture inspected.\nMEDIA:${mediaUrl}`,
              ...(scenario === "commentary-media"
                ? { textSignature: JSON.stringify({ v: 1, id: "progress", phase: "commentary" }) }
                : {}),
            },
          ],
          openclawDelivery: { mediaUrls: [mediaUrl] },
        },
        runId,
      );
      let settled = false;
      const operation = dispatch
        .runAgentMediaTranscript({ run: async (run) => run() }, async () =>
          withOwnedSessionTranscriptWrites(
            {
              sessionTarget: scope,
              assertCommitAllowed: () => controller.signal.throwIfAborted(),
              withTranscriptWrite: (run) => transcriptLifecycle.withTranscriptWrite(run),
            },
            async () => {
              dispatch.captureAgentTranscriptStart();
              expect(
                appendTranscriptMessageSync(scope, { eventId: "answer", message }),
              ).toMatchObject({ ok: true });
              openOpenClawAgentDatabase(databaseOptions)
                .db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1")
                .run();
              transcriptReconcile.startSessionTranscriptIndexReconcile(databaseOptions);
              if (scenario === "reply-observation") {
                return await observeReplyDelivery(dispatch.resolveReplyDelivery, 0, warn);
              }
              emitSessionTranscriptUpdate({ target: scope, messageId: "answer", message, runId });
              await enteredWait.promise;
              await transcriptLifecycle.beginCleanup();
              return "finished";
            },
          ),
        )
        .then((result) => {
          settled = true;
          return result;
        });
      try {
        await enteredWait.promise;
        await vi.waitFor(() => expect(stalledWorker).toBeDefined());
        expect(settled).toBe(false);
        controller.abort(new Error("Operator stopped this run"));
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
        expect(await operation).toBe(scenario === "reply-observation" ? "pending" : "finished");
        expect(warn).toHaveBeenCalledOnce();
        expect(transcriptReconcile.isSessionTranscriptIndexReconcileRunning(databaseOptions)).toBe(
          true,
        );
        expect(dispatch.hasAppendedWebchatAgentMedia()).toBe(false);
      } finally {
        waiting.mockRestore();
        await stalledWorker?.terminate();
        await transcriptReconcile.waitForSessionTranscriptIndexReconcile(databaseOptions);
        await operation;
        await transcriptLifecycle.dispose();
      }
      expect(loadTranscriptEventsSync(scope)).toContainEqual(
        expect.objectContaining({ id: "answer", message }),
      );
      const nextInput = createUserTurnTranscriptRecorder({
        input: { text: "Continue with the next fixture", idempotencyKey: "successor:user" },
        target: { ...scope, sessionEntry: entry },
      });
      expect(await nextInput.persistApproved()).toMatchObject({ appended: true });
    });
  },
);
