import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "../../agents/embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import { observeReplyDelivery } from "../../agents/reply-completion.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  appendTranscriptMessageSync,
  loadTranscriptEventsSync,
  replaceSessionEntry,
  resolveSessionTranscriptDatabasePath,
} from "../../config/sessions/session-accessor.js";
import * as reconcile from "../../config/sessions/session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "../../config/sessions/session-transcript-reconcile.test-support.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import {
  attachSessionTranscriptRunId,
  emitSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { loadSessionEntryAsync } from "../session-entry-load.test-support.js";
import { createReplyDispatch } from "./chat-send-reply-dispatch.test-support.js";

vi.mock("node:worker_threads", async () =>
  (
    await import("../../config/sessions/session-transcript-reconcile.test-support.js")
  ).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();

it.each(["reply-observation", "commentary-media"] as const)(
  "cancels %s projection waiting without cancelling the shared rebuild or losing the answer",
  (scenario) =>
    withOpenClawTestState({ label: "chat-projection-cancel" }, async () => {
      setRuntimeConfigSnapshot({});
      const runId = "projection-run";
      const scope = {
        agentId: "main",
        sessionId: "projection-session",
        sessionKey: "agent:main:projection",
        storePath: (await loadSessionEntryAsync("agent:main:projection", { agentId: "main" }))
          .storePath,
      };
      const entry = { sessionId: scope.sessionId, lifecycleRevision: "initial", updatedAt: 1 };
      await replaceSessionEntry(scope, entry);
      const inputRecorder = (text: string, idempotencyKey: string) =>
        createUserTurnTranscriptRecorder({
          input: { text, idempotencyKey },
          target: { ...scope, sessionEntry: entry },
        });
      const recorder = inputRecorder("Inspect the fixture", `${runId}:user`);
      await recorder.persistApproved();
      const controller = new AbortController();
      const warn = vi.fn();
      const dispatch = createReplyDispatch(runId, {
        abortSignal: controller.signal,
        logGateway: { warn } as never,
        session: {
          ...scope,
          entry,
          backingSessionId: scope.sessionId,
          cfg: {},
          clientRunId: runId,
          sessionLoadOptions: { agentId: "main" },
        },
        userTurnRecorder: recorder,
      });
      const lifecycle = createEmbeddedAttemptTranscriptLifecycle({
        runId,
        sessionId: scope.sessionId,
      });
      const databaseOptions = {
        agentId: scope.agentId,
        path: resolveSessionTranscriptDatabasePath(scope),
      };
      const markRebuilding = () =>
        openOpenClawAgentDatabase(databaseOptions)
          .db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1")
          .run();
      if (scenario === "commentary-media") {
        markRebuilding();
        await reconcile.reconcileSessionTranscriptIndexes(databaseOptions);
      }
      const enteredWait = createDeferred();
      const waitForProjection = reconcile.waitForSessionTranscriptProjection;
      const waiting = vi
        .spyOn(reconcile, "waitForSessionTranscriptProjection")
        .mockImplementation((...args) => {
          const result = waitForProjection(...args);
          enteredWait.resolve();
          return result;
        });
      const projectionPaused = createDeferred();
      let holdProjection = true;
      let resumeProjection = () => {};
      observer.onTask = ({ input, port, observeMessage }) => {
        if (input.mode !== "disk" || input.path !== databaseOptions.path) {
          return;
        }
        let claiming = false;
        observeMessage((message) => {
          claiming = message.type === "plan-start" && message.plan.sessionId === scope.sessionId;
        });
        const post = port.postMessage.bind(port);
        port.postMessage = (message, transferList) => {
          const postOptions = Array.isArray(transferList)
            ? { transfer: transferList }
            : transferList;
          if (claiming && holdProjection) {
            claiming = false;
            resumeProjection = () => post(message, postOptions);
            projectionPaused.resolve();
            return;
          }
          post(message, postOptions);
        };
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
              withTranscriptWrite: (...args) => lifecycle.withTranscriptWrite(...args),
            },
            async () => {
              dispatch.captureAgentTranscriptStart();
              expect(
                appendTranscriptMessageSync(scope, { eventId: "answer", message }),
              ).toMatchObject({ ok: true });
              markRebuilding();
              reconcile.startSessionTranscriptIndexReconcile(databaseOptions);
              if (scenario === "reply-observation") {
                return await observeReplyDelivery(dispatch.resolveReplyDelivery, 0, warn);
              }
              emitSessionTranscriptUpdate({ target: scope, messageId: "answer", message, runId });
              await enteredWait.promise;
              await lifecycle.beginCleanup();
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
        await projectionPaused.promise;
        expect(settled).toBe(false);
        controller.abort(new Error("Operator stopped this run"));
        await vi.waitFor(() => expect(settled).toBe(true), { timeout: 500 });
        expect(await operation).toBe(scenario === "reply-observation" ? "pending" : "finished");
        expect(warn).toHaveBeenCalledOnce();
        expect(reconcile.isSessionTranscriptIndexReconcileRunning(databaseOptions)).toBe(true);
        expect(dispatch.hasAppendedWebchatAgentMedia()).toBe(false);
      } finally {
        controller.abort(new Error("Projection cancellation fixture cleanup"));
        waiting.mockRestore();
        observer.onTask = undefined;
        holdProjection = false;
        resumeProjection();
        await reconcile.waitForSessionTranscriptIndexReconcile(databaseOptions);
        await operation;
        await lifecycle.dispose();
      }
      expect(
        openOpenClawAgentDatabase(databaseOptions)
          .db.prepare(
            "SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
          )
          .get(scope.sessionId),
      ).toMatchObject({ needs_rebuild: 0 });
      expect(loadTranscriptEventsSync(scope)).toContainEqual(
        expect.objectContaining({ id: "answer", message }),
      );
      const nextInput = inputRecorder("Continue with the next fixture", "successor:user");
      expect(await nextInput.persistApproved()).toMatchObject({ appended: true });
    }),
);
