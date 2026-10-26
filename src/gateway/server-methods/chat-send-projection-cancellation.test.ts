import { expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "../../agents/embedded-agent-runner/run/attempt-transcript-lifecycle.js";
import { observeReplyDelivery } from "../../agents/reply-completion.js";
import {
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
} from "../../config/sessions/session-accessor.js";
import {
  holdReconcileAck,
  markRebuild,
  rebuildState,
} from "../../config/sessions/session-transcript-reconcile.fixtures.test-support.js";
import * as reconcile from "../../config/sessions/session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "../../config/sessions/session-transcript-reconcile.test-support.js";
import { withOwnedSessionTranscriptWrites } from "../../config/sessions/transcript-write-context.js";
import {
  attachSessionTranscriptRunId,
  emitSessionTranscriptUpdate,
} from "../../sessions/transcript-events.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { loadSessionEntryAsync } from "../session-entry-load.test-support.js";
import { withReplyTranscript } from "./chat-send-reply-dispatch.test-support.js";

vi.mock("node:worker_threads", async () =>
  (
    await import("../../config/sessions/session-transcript-reconcile.test-support.js")
  ).createObservedWorkerThreads(),
);

const observer = useReconcileWorkerObserver();

it.for(["reply-observation", "commentary-media"] as const)(
  "cancels %s projection waiting without cancelling the shared rebuild or losing the answer",
  (scenario, test) =>
    withReplyTranscript(
      async ({ scope, runId, dispatch, appendSync, abortController: controller }) => {
        const warn = vi.fn();
        const lifecycle = createEmbeddedAttemptTranscriptLifecycle({
          runId,
          sessionId: scope.sessionId,
        });
        const databaseOptions = {
          agentId: scope.agentId,
          path: resolveSessionTranscriptDatabasePath(scope),
        };
        const database = () => openOpenClawAgentDatabase(databaseOptions).db;
        if (scenario === "commentary-media") {
          markRebuild(database());
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
        const projection = holdReconcileAck(observer, "plan-start", scope.sessionId);
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
                appendSync("answer", message);
                markRebuild(database());
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
          await withinTest(Promise.all([enteredWait.promise, projection.paused]), test.signal);
          expect(settled).toBe(false);
          controller.abort(new Error("Operator stopped this run"));
          expect(await withinTest(operation, test.signal)).toBe(
            scenario === "reply-observation" ? "pending" : "finished",
          );
          expect(reconcile.isSessionTranscriptIndexReconcileRunning(databaseOptions)).toBe(true);
          expect(dispatch.hasAppendedWebchatAgentMedia()).toBe(false);
        } finally {
          controller.abort(new Error("Projection cancellation fixture cleanup"));
          waiting.mockRestore();
          observer.onTask = undefined;
          projection.release();
          await reconcile.waitForSessionTranscriptIndexReconcile(databaseOptions);
          await operation;
          await lifecycle.dispose();
        }
        expect(rebuildState(database(), scope.sessionId)).toMatchObject({ needs_rebuild: 0 });
        expect(loadTranscriptEventsSync(scope)).toContainEqual(
          expect.objectContaining({ id: "answer", message }),
        );
        const nextInput = createUserTurnTranscriptRecorder({
          input: { text: "Continue with the next fixture", idempotencyKey: "successor:user" },
          target: {
            ...scope,
            sessionEntry: (
              await loadSessionEntryAsync(scope.sessionKey, { agentId: scope.agentId })
            ).entry,
          },
        });
        expect(await nextInput.persistApproved()).toMatchObject({ appended: true });
      },
    ),
);
