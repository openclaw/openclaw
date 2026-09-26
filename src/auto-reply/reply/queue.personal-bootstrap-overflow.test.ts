import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createFollowupTurnTestTurn,
  createFollowupTurnTestTypingController,
  executeFollowupTurnForTest,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearFollowupDrainCallback, scheduleFollowupDrain } from "./queue/drain.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { admitFollowupRunLifecycle, completeFollowupRunLifecycle } from "./queue/lifecycle.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import { FollowupRunDeferredError, type FollowupRun, type QueueSettings } from "./queue/types.js";

const state = getFollowupTurnTestState();
beforeEach(resetFollowupTurnTestState);

const eligibilityCases = [
  { name: "eligible sources", eligibility: [true, true], personalized: true },
  {
    name: "mixed eligible and ineligible sources",
    eligibility: [false, true],
    personalized: false,
  },
  {
    name: "mixed eligible and unspecified sources",
    eligibility: [undefined, true],
    personalized: false,
  },
  { name: "ineligible sources", eligibility: [false, false], personalized: false },
];

// Boundary proof: the real queue and follow-up adapter select the execution
// profile; the shared fixture stubs only the final agent backend on this path.
describe.each(["ordinary summary", "compacted sources", "deferred retry"] as const)(
  "overflow personal bootstrap: %s",
  (path) => {
    it.each(eligibilityCases)("refreshes the session owner for $name", async (testCase) => {
      // A case owns its key and callback; a detached prior drain must never
      // capture the next case's enqueues before its callback is installed.
      const key = `personal-bootstrap-overflow:${path}:${testCase.name}`;
      const settings: QueueSettings = {
        mode: "followup",
        debounceMs: 0,
        cap: path === "ordinary summary" ? 2 : 1,
        dropPolicy: "summarize",
      };
      const firstAttempt = createDeferred();
      const releaseFirstAttempt = createDeferred();
      const completed = createDeferred();
      const executions: Array<{ prompt: string; profile: string | undefined }> = [];
      const sources: FollowupRun[] = [];
      let summaryAttempts = 0;
      let currentOwner = "owner-at-enqueue";
      const tailPrompt = "pending tail";
      const clear = () => {
        clearFollowupQueue(key);
        clearFollowupDrainCallback(key);
      };
      const enqueue = (prompt: string, eligible: boolean | undefined) => {
        const source = createQueueTestRun({ prompt });
        source.personalBootstrapEligible = eligible;
        source.run.sessionKey = key;
        source.run.bootstrapUserProfileId = `stale-source-owner-${sources.length}`;
        source.turnAdoptionLifecycle = {
          admission: "cancel-only",
          onAdopted: vi.fn(),
          onSettled: vi.fn(),
        };
        sources.push(source);
        expect(enqueueFollowupRun(key, source, settings)).toBe(true);
        return source;
      };
      state.execute.mockImplementation(async (params: AgentTurnParams) => {
        executions.push({
          prompt: params.commandBody,
          profile: params.followupRun.run.bootstrapUserProfileId,
        });
        return { runId: "run-1", outcome: { kind: "rejected", payload: { text: "done" } } };
      });
      const runFollowup = async (queued: FollowupRun) => {
        const summary = queued.prompt.startsWith("[Queue overflow]");
        if (summary) {
          summaryAttempts += 1;
          if (path === "deferred retry" && summaryAttempts === 1) {
            firstAttempt.resolve();
            await releaseFirstAttempt.promise;
            // Admission defers before adopting sources or invoking the backend.
            throw new FollowupRunDeferredError("reply lane busy");
          }
        }
        try {
          await admitFollowupRunLifecycle(queued);
          try {
            const result = await executeFollowupTurnForTest({
              turn: createFollowupTurnTestTurn({
                queued,
                session: {
                  kind: "session",
                  key,
                  current: () => ({
                    sessionId: queued.run.sessionId,
                    updatedAt: 2,
                    createdActor: { type: "human", source: "profile", id: "creator" },
                    owner: { actor: { type: "human", id: currentOwner } },
                  }),
                  publish: () => undefined,
                  adopt: () => undefined,
                },
              }),
              defaults: {
                typing: createFollowupTurnTestTypingController(),
                typingMode: "never",
                defaultModel: "claude",
              },
              onToolResult: async () => {},
              onCompactionNoticePayload: async () => {},
            });
            await result.progress.drain();
          } finally {
            completeFollowupRunLifecycle(queued);
          }
          if (queued.prompt === tailPrompt) {
            completed.resolve();
          }
        } catch (error) {
          // Detached drain errors must fail the test, not become a retry loop
          // or a pending phase promise that only fails at the test deadline.
          clear();
          completed.reject(error);
        }
      };

      try {
        const first = enqueue("first summarized request", testCase.eligibility[0]);
        enqueue("second summarized request", testCase.eligibility[1]);
        if (path === "ordinary summary") {
          enqueue("pending predecessor", true);
        }
        if (path !== "deferred retry") {
          enqueue(tailPrompt, true);
        }
        currentOwner = "current-session-owner";
        scheduleFollowupDrain(key, runFollowup);

        if (path === "deferred retry") {
          await Promise.race([firstAttempt.promise, completed.promise]);
          expect(summaryAttempts).toBe(1);
          expect(executions).toEqual([]);
          // Overflow while admission is suspended compacts the original source;
          // the retry must preserve its eligibility along with the newer source.
          enqueue(tailPrompt, true);
          currentOwner = "owner-after-deferral";
        }
        const queue = getExistingFollowupQueue(key);
        expect(queue?.droppedCount).toBe(2);
        if (path === "ordinary summary") {
          expect(queue?.summaryElisions).toHaveLength(0);
        } else {
          expect(queue?.summaryElisions).toHaveLength(1);
          expect(queue?.summaryElisions[0]?.sources).toHaveLength(1);
          expect(queue?.summaryElisions[0]?.sources[0]).not.toBe(first);
        }
        releaseFirstAttempt.resolve();
        await completed.promise;

        expect(summaryAttempts).toBe(path === "deferred retry" ? 2 : 1);
        expect(executions).toHaveLength(path === "ordinary summary" ? 3 : 2);
        expect(executions[0]?.prompt).toContain("[Queue overflow] Dropped 2 messages due to cap.");
        for (const source of sources) {
          expect(source.turnAdoptionLifecycle?.onAdopted).toHaveBeenCalledOnce();
          expect(source.turnAdoptionLifecycle?.onSettled).toHaveBeenCalledOnce();
        }
        expect(executions.slice(1).map((execution) => execution.profile)).toEqual(
          path === "ordinary summary" ? [currentOwner, currentOwner] : [currentOwner],
        );
        expect(executions[0]?.profile).toBe(testCase.personalized ? currentOwner : undefined);
      } finally {
        releaseFirstAttempt.resolve();
        clear();
      }
    });
  },
);
