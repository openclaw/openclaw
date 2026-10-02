import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as operationAdmission from "../infra/sqlite-worker-operation-admission.js";
import { onSessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { preparePersonalGitHubSessionReceiptDeletion } from "../state/github-personal-publication-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { prepareGitHubPublicationReviewRead } from "./github-publication-review-publication.js";
import {
  insertGitHubPublicationReview,
  listGitHubPublicationReviews,
  markGitHubPublicationReviewStale,
  prepareGitHubPublicationReviewObservation,
  readGitHubPublicationReview,
} from "./github-publication-review-store.js";

const session = {
  agentId: "main",
  sessionKey: "agent:main:review-worker",
  sessionId: "review-session",
  lifecycleRevision: "review-generation",
};
const request = {
  session,
  profileId: "reviewer",
  idempotencyKey: "review",
  assertCurrent: () => {},
};
afterEach(() => {
  vi.restoreAllMocks();
});

describe("publication review worker ownership", () => {
  it.each(["transaction", "commit"] as const)(
    "rolls back a revoked %s grant without publishing a row",
    async (stage) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        openOpenClawStateDatabase();
        let current = true;
        let refused = false;
        const changed = vi.fn();
        const unsubscribe = onSessionLifecycleEvent(changed);
        const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
        const admission = vi
          .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) =>
            createAdmission((nativeRequest, grant) => {
              if (nativeRequest.stage === stage) {
                current = false;
                refused = true;
              }
              admit(nativeRequest, grant);
            }, attachment),
          );
        try {
          await expect(
            insertGitHubPublicationReview({
              ...request,
              assertCurrent() {
                if (!current) {
                  throw new Error("review source revoked");
                }
              },
            }),
          ).rejects.toThrow("review source revoked");
          expect(refused).toBe(true);
          expect(changed).not.toHaveBeenCalled();
          expect(await listGitHubPublicationReviews(session)).toEqual([]);
        } finally {
          admission.mockRestore();
          unsubscribe();
        }
      });
    },
  );

  it("publishes committed stale facts and deletion tombstones despite lost ordinary replies", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const row = await insertGitHubPublicationReview(request);
      const observed = await prepareGitHubPublicationReviewObservation(row.review_id);
      const remove = await preparePersonalGitHubSessionReceiptDeletion({
        agentId: session.agentId,
        generations: [session],
      });
      const execute = stateWorker.runOpenClawStateWorkerOperation;
      const delivery = vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation");
      const loseReply = () =>
        delivery.mockImplementationOnce(async (...args) => {
          await execute(...args);
          throw new Error("ordinary reply lost after native settlement");
        });
      const changed = vi.fn();
      const unsubscribe = onSessionLifecycleEvent(changed);
      try {
        loseReply();
        await markGitHubPublicationReviewStale(row, "source changed");
        expect(observed.current()?.stale_reason).toBe("source changed");
        expect(changed).toHaveBeenCalledExactlyOnceWith({
          sessionKey: session.sessionKey,
          agentId: session.agentId,
          reason: "github-publication",
        });
        loseReply();
        await remove();
        expect(observed.current()).toBeUndefined();
        expect(await readGitHubPublicationReview({ reviewId: row.review_id })).toBeUndefined();
      } finally {
        delivery.mockRestore();
        unsubscribe();
      }
    });
  });

  it("makes a first observer join an already staged native commit", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      openOpenClawStateDatabase();
      const nativeSettled = createDeferredCore();
      const release = createDeferredCore();
      const execute = stateWorker.runOpenClawStateWorkerOperation;
      const delivery = vi
        .spyOn(stateWorker, "runOpenClawStateWorkerOperation")
        .mockImplementationOnce((context, operation, options) => {
          const createAdmission = options?.createAdmission;
          if (!createAdmission) {
            throw new Error("Expected publication admission");
          }
          return execute(context, operation, {
            ...options,
            createAdmission: ({ settled }) =>
              createAdmission({
                settled: settled.then(async (result) => {
                  nativeSettled.resolve();
                  await release.promise;
                  return result;
                }),
              }),
          });
        });
      let reviewId: string | undefined;
      const createAdmission = operationAdmission.createSqliteWorkerOperationAdmission;
      const admission = vi
        .spyOn(operationAdmission, "createSqliteWorkerOperationAdmission")
        .mockImplementation((admit, attachment) =>
          createAdmission((nativeRequest, grant) => {
            const facts = nativeRequest.facts;
            if (
              nativeRequest.stage === "commit" &&
              isRecord(facts) &&
              isRecord(facts.value) &&
              typeof facts.value.review_id === "string"
            ) {
              reviewId = facts.value.review_id;
            }
            admit(nativeRequest, grant);
          }, attachment),
        );
      const insertion = insertGitHubPublicationReview(request);
      let prepared: ReturnType<typeof prepareGitHubPublicationReviewRead> | undefined;
      try {
        await Promise.race([
          nativeSettled.promise,
          insertion.then(() => {
            throw new Error("Missing held settlement");
          }),
        ]);
        expect(reviewId).toBeTypeOf("string");
        const read = vi.fn(() => readGitHubPublicationReview({ reviewId: reviewId! }));
        prepared = prepareGitHubPublicationReviewRead(
          captureOpenClawStateWorkerContext().admission,
          reviewId!,
          read,
        );
        expect(read).not.toHaveBeenCalled();
        release.resolve();
        const row = await insertion;
        const observation = await prepared;
        expect(observation.row).toEqual(row);
        expect(observation.current()?.review_id).toBe(row.review_id);
        await closeOpenClawStateDatabaseAsync();
        expect(() => observation.current()).toThrow();
      } finally {
        release.resolve();
        await Promise.all([insertion, prepared]);
        admission.mockRestore();
        delivery.mockRestore();
      }
    });
  });
});
