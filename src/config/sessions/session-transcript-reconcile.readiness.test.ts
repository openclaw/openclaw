import * as timers from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";
import { useReconcileWorkerObserver } from "./session-transcript-reconcile.test-support.js";
import { transcriptMessage } from "./transcript-message.test-support.js";

vi.mock("node:worker_threads", async () =>
  (await import("./session-transcript-reconcile.test-support.js")).createObservedWorkerThreads(),
);
vi.mock("node:timers/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:timers/promises")>()),
}));

const observer = useReconcileWorkerObserver();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["reader-import", "between-polls", "queued-status", "during-close"] as const)(
  "preserves readiness lifetime and cancellation across %s",
  async (boundary) => {
    const stateDir = tempDirs.make("openclaw-projection-read-retirement-");
    const options = { agentId: "main", env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
    const scope = {
      ...options,
      sessionId: "retired-read",
      sessionKey: "agent:main:retired-read",
    };
    const paused = createDeferred();
    let resume: (() => void) | undefined;
    try {
      await persistSessionTranscriptTurn(scope, {
        messages: [transcriptMessage("seed", null, { role: "user", content: "Read owner" })],
        touchSessionEntry: false,
      });
      await waitForSessionTranscriptIndexReconcile(options);
      const database = openOpenClawAgentDatabase(options);
      database.db.prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1").run();
      observer.onTask = ({ port, observeMessage }) => {
        let claiming = false;
        observeMessage((message) => {
          claiming = message.type === "plan-start";
        });
        const post = port.postMessage.bind(port);
        port.postMessage = (message, transferList) => {
          const postOptions = Array.isArray(transferList)
            ? { transfer: transferList }
            : transferList;
          if (claiming) {
            claiming = false;
            resume = () => post(message, postOptions);
            paused.resolve();
            return;
          }
          post(message, postOptions);
        };
      };
      startSessionTranscriptIndexReconcile(options);
      await paused.promise;
      const retire = async () => {
        const closing = closeOpenClawAgentDatabasesAsync();
        observer.onTask = undefined;
        resume?.();
        await closing;
        await waitForSessionTranscriptIndexReconcile(options);
      };
      if (boundary === "reader-import") {
        const runtime = await import("./session-transcript-worker-runtime.js");
        const entered = createDeferred();
        const continueImport = createDeferred();
        vi.doMock("./session-transcript-worker-runtime.js", async () => {
          entered.resolve();
          await continueImport.promise;
          return runtime;
        });
        try {
          const outcome = waitForSessionTranscriptProjection(scope).then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
          await entered.promise;
          await retire();
          continueImport.resolve();
          await expect(outcome).resolves.toMatchObject({
            ok: false,
            error: expect.objectContaining({
              message: "Agent database execution admission is closed",
            }),
          });
        } finally {
          continueImport.resolve();
          vi.doUnmock("./session-transcript-worker-runtime.js");
        }
      } else if (boundary === "during-close") {
        observer.onTask = undefined;
        const closing = closeOpenClawAgentDatabasesAsync();
        let scheduled: { ok: true } | { ok: false; error: unknown };
        try {
          startSessionTranscriptIndexReconcile(options);
          scheduled = { ok: true };
        } catch (error) {
          scheduled = { ok: false, error };
        }
        const waiting = waitForSessionTranscriptProjection(scope).then(
          () => ({ ok: true }),
          (error: unknown) => ({ ok: false, error }),
        );
        resume?.();
        await closing;
        expect({ scheduled, ready: await waiting }).toEqual({
          scheduled: { ok: true },
          ready: { ok: true },
        });
        expect(
          openOpenClawAgentDatabase(options)
            .db.prepare(
              "SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
            )
            .get(scope.sessionId),
        ).toEqual({ needs_rebuild: 0 });
      } else if (boundary === "queued-status") {
        const {
          historyLane: { pool: historyPages },
        } = await import("./session-transcript-worker-resources.js");
        const { withSessionHistoryWorkerDatabase } =
          await import("./session-transcript-worker-runtime.js");
        const preparing = createDeferred();
        const releasePreparation = createDeferred();
        const queued = createDeferred();
        const run = historyPages.run.bind(historyPages);
        let first = true;
        const admission = vi.spyOn(historyPages, "run").mockImplementation((input, taskOptions) => {
          if (!first) {
            const pending = run(input, taskOptions);
            queued.resolve();
            return pending;
          }
          first = false;
          return run(async () => {
            preparing.resolve();
            await releasePreparation.promise;
            return typeof input === "function" ? await input() : input;
          }, taskOptions);
        });
        const blocker = withSessionHistoryWorkerDatabase(options, (owner) =>
          owner.readProjectionStatus({ env: options.env }),
        );
        const controller = new AbortController();
        const reason = new Error("cancel queued projection status");
        let ready: Promise<{ kind: "resolved" } | { kind: "rejected"; error: unknown }> | undefined;
        try {
          await preparing.promise;
          ready = waitForSessionTranscriptProjection(scope, controller.signal).then(
            () => ({ kind: "resolved" as const }),
            (error: unknown) => ({ kind: "rejected" as const, error }),
          );
          await queued.promise;
          controller.abort(reason);
          const outcome = await Promise.race([
            ready,
            timers.setTimeout(250).then(() => ({ kind: "still-waiting" as const })),
          ]);
          expect(outcome.kind).toBe("rejected");
          if (outcome.kind === "rejected") {
            expect(outcome.error).toMatchObject({ name: "AbortError", cause: reason });
          }
        } finally {
          releasePreparation.resolve();
          try {
            await expect(blocker).resolves.toBe(true);
            await ready;
          } finally {
            admission.mockRestore();
          }
        }
      } else {
        // The real status read completed; retire its owner while the waiter yields.
        const polling = vi.spyOn(timers, "setTimeout").mockImplementationOnce(retire);
        try {
          await expect(waitForSessionTranscriptProjection(scope)).resolves.toBeUndefined();
          expect(polling).toHaveBeenCalled();
          const reopened = openOpenClawAgentDatabase(options);
          expect(
            reopened.db
              .prepare(
                "SELECT needs_rebuild, active_message_count FROM session_transcript_index_state WHERE session_id = ?",
              )
              .get(scope.sessionId),
          ).toEqual({ needs_rebuild: 0, active_message_count: 1 });
        } finally {
          polling.mockRestore();
        }
      }
    } finally {
      resume?.();
      await waitForSessionTranscriptIndexReconcile(options);
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
    }
  },
  30_000,
);
