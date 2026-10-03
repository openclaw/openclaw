import { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { compareSessionProviderReview } from "../../config/sessions/provider-review-store.js";
import type { SessionProviderReview } from "../../config/sessions/provider-review.types.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { addSessionSuggestion } from "../../config/sessions/session-suggestion-store.js";
import { listSessionSuggestions } from "../../config/sessions/session-suggestion-store.read.js";
import { observeSqliteWalPeriodicWork } from "../../infra/sqlite-wal-scheduler.test-support.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import * as agentWriteAdmission from "../../state/openclaw-agent-write-admission.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { initializeSessionReadContext } from "./sessions-read-cache.test-support.js";
import { getSessionSuggestionTestMocks } from "./sessions-suggestions.test-mocks.js";
import {
  call,
  client,
  context,
  registerSessionSuggestionTestLifecycle,
  sessionKey,
} from "./sessions-suggestions.test-support.js";
import type { RespondFn } from "./types.js";

const mocks = getSessionSuggestionTestMocks();
registerSessionSuggestionTestLifecycle(mocks);
beforeEach(() => mocks.afterSuggestionClaim.mockReset());

// Adapter observers notify after the real queue takes custody.
describe("suggestions queued behind provider review", () => {
  it.for(["add", "edit", "dismiss", "send", "queue"] as const)(
    "preserves the lifecycle boundary for %s without replacing the session",
    async (action, { signal }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const metadataWrites =
          await import("../../config/sessions/session-metadata-write.async.js");
        const scope = { agentId: "main", sessionKey, env: state.env };
        openOpenClawStateDatabase({ env: state.env });
        const scheduled = observeSqliteWalPeriodicWork();
        const database = (() => {
          try {
            return openOpenClawAgentDatabase(scope);
          } finally {
            scheduled.restore();
          }
        })();
        const periodic = scheduled.periodic;
        await upsertSessionEntryCore(scope, {
          sessionId: "provider-review-suggestion",
          lifecycleRevision: "provider-review-generation",
          updatedAt: 1,
          createdActor: { type: "human", source: "profile", id: "owner" },
          visibility: "suggest",
        });
        const originalEntry = loadSessionEntry(scope)!;
        const originalSessionId = originalEntry.sessionId;
        if (!originalSessionId) {
          throw new Error("expected a seeded suggestion session");
        }
        const options = { ...scope, path: database.path };
        const id = "queued-provider-review-suggestion";
        if (action !== "add") {
          addSessionSuggestion(scope, { id, authorId: "owner", text: "Synthetic suggestion" });
        }
        const broadcast = vi.fn();
        const requestContext = context(broadcast);
        await initializeSessionReadContext(requestContext);
        const release = createDeferred();
        const metadataQueued = createDeferred();
        let blocker: Promise<void> | undefined;
        let maintenance: Promise<unknown> | undefined;
        let review: ReturnType<typeof compareSessionProviderReview> | undefined;
        let request: ReturnType<typeof call> | undefined;
        const providerReview: SessionProviderReview = {
          id: "queued-provider-review",
          sessionId: originalSessionId,
          runId: "paused-provider-run",
          provider: "openai",
          model: "test-model",
          runtimeId: "openclaw",
        };
        const queueReviewBeforeNextWrite = async () => {
          const entered = createDeferred();
          blocker = agentWriteAdmission.runOpenClawAgentWorkerWrite(options, async () => {
            entered.resolve();
            await release.promise;
          });
          await withinTest(entered.promise, signal);
          const reviewQueued = createDeferred();
          // Target discovery yields before review admission; unrelated writers are not this gate.
          const reviewScope = new AsyncLocalStorage<boolean>();
          const enqueueWrite = agentWriteAdmission.runOpenClawAgentWorkerWrite;
          const observeReview = vi
            .spyOn(agentWriteAdmission, "runOpenClawAgentWorkerWrite")
            .mockImplementation((...args) => {
              const pending = enqueueWrite(...args);
              if (reviewScope.getStore()) {
                reviewQueued.resolve();
              }
              return pending;
            });
          try {
            // A real maintenance writer must not release the review-specific queue barrier.
            maintenance = Promise.resolve(periodic());
            review = reviewScope.run(true, () =>
              compareSessionProviderReview(
                {
                  ...scope,
                  storePath: database.path,
                  sessionId: originalSessionId,
                  lifecycleRevision: originalEntry.lifecycleRevision,
                },
                {
                  expectedReview: undefined,
                  nextReview: providerReview,
                  assertCurrent: () => signal.throwIfAborted(),
                },
              ),
            );
            await withinTest(
              awaitGateBeforeSettlement(
                reviewQueued.promise,
                review,
                "provider review finished before its writer entered the queue",
              ),
              signal,
            );
          } finally {
            observeReview.mockRestore();
            reviewScope.disable();
          }
        };
        if (action === "add") {
          const add = metadataWrites.addSessionSuggestionInWorker;
          vi.spyOn(metadataWrites, "addSessionSuggestionInWorker").mockImplementation(
            async (...args) => {
              // Capture lifecycle facts before introducing the preceding writer.
              await queueReviewBeforeNextWrite();
              const pending = add(...args);
              metadataQueued.resolve();
              return pending;
            },
          );
        } else {
          const finalize = metadataWrites.finalizeSessionSuggestionClaimInWorker;
          vi.spyOn(metadataWrites, "finalizeSessionSuggestionClaimInWorker").mockImplementation(
            (...args) => {
              const pending = finalize(...args);
              metadataQueued.resolve();
              return pending;
            },
          );
          if (action === "edit" || action === "dismiss") {
            mocks.afterSuggestionClaim.mockImplementationOnce(queueReviewBeforeNextWrite);
          } else {
            mocks.handleChatSend.mockImplementationOnce(
              async ({ respond }: { respond: RespondFn }) => {
                respond(true, { runId: `session-suggestion:${id}`, status: "started" });
                await queueReviewBeforeNextWrite();
              },
            );
          }
        }
        try {
          request = call(
            action === "add" ? "session.suggestions.add" : "session.suggestions.resolve",
            action === "add"
              ? { sessionKey, text: "Synthetic suggestion" }
              : { sessionKey, id, resolution: action },
            client("owner", "Owner"),
            requestContext,
          );
          await withinTest(
            awaitGateBeforeSettlement(
              metadataQueued.promise,
              request,
              "suggestion finished before its metadata writer entered the queue",
            ),
            signal,
          );
          expect(loadSessionEntry(scope)?.providerReview).toBeUndefined();
          release.resolve();
          const [result, paused] = await withinTest(Promise.all([request, review!]), signal);
          expect(paused.providerReview).toEqual(providerReview);
          expect(loadSessionEntry(scope)).toMatchObject({
            sessionId: originalEntry.sessionId,
            lifecycleRevision: originalEntry.lifecycleRevision,
            providerReview,
          });
          expect(result.responses).toHaveLength(1);
          const rejected = action === "add" || action === "edit";
          if (rejected) {
            expect(result.responses[0]).toMatchObject([
              false,
              undefined,
              { message: expect.stringContaining("paused as a precaution") },
            ]);
            expect(broadcast).not.toHaveBeenCalled();
          } else {
            expect(result.responses[0]).toMatchObject([
              true,
              { suggestion: { id, state: action === "dismiss" ? "dismissed" : "accepted" } },
            ]);
          }
          if (action === "add") {
            expect(await listSessionSuggestions(scope)).toEqual([]);
          } else {
            expect(
              database.db
                .prepare("SELECT state, dispatch_token FROM session_suggestions WHERE id = ?")
                .get(id),
            ).toEqual({
              state:
                action === "edit" ? "pending" : action === "dismiss" ? "dismissed" : "accepted",
              dispatch_token: null,
            });
          }
          expect(mocks.handleChatSend).toHaveBeenCalledTimes(
            action === "send" || action === "queue" ? 1 : 0,
          );
        } finally {
          release.resolve();
          await Promise.allSettled([blocker, review, request, maintenance]);
        }
      });
    },
  );
});
