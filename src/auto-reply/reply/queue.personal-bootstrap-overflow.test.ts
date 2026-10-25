import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { AgentTurnParams } from "./agent-runner-execution.types.js";
import {
  createFollowupTurnTestTurn,
  executeFollowupTurnForTest,
  getFollowupTurnTestState,
  resetFollowupTurnTestState,
} from "./followup-turn-execution.test-support.js";
import { createQueueTestRun, createQueueSettings } from "./queue.test-helpers.js";
import { scheduleFollowupDrain } from "./queue/drain.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import { admitFollowupRunLifecycle, completeFollowupRunLifecycle } from "./queue/lifecycle.js";
import { clearFollowupQueue, getExistingFollowupQueue } from "./queue/state.js";
import type { FollowupRun } from "./queue/types.js";
import { createMockTypingController } from "./test-helpers.js";

const state = getFollowupTurnTestState();
beforeEach(resetFollowupTurnTestState);

// Real queue and followup adapter; only the final agent backend is stubbed.
it.each([
  { path: "ordinary summary", eligible: false },
  { path: "compacted sources", eligible: undefined },
  { path: "deferred retry", eligible: true },
] as const)(
  "refreshes the overflow owner for $path (eligible=$eligible)",
  async ({ path, eligible }) => {
    // Keep detached drains from capturing the next case's enqueues.
    const key = `personal-bootstrap-overflow:${path}:${eligible}`;
    const deferred = path === "deferred retry";
    const ordinary = path === "ordinary summary";
    const settings = createQueueSettings({
      mode: "followup",
      cap: ordinary ? 2 : 1,
    });
    const firstAttempt = createDeferred();
    const releaseFirstAttempt = createDeferred();
    const completed = createDeferred();
    const executions: Array<{ prompt: string; profile: string | undefined }> = [];
    const sources: FollowupRun[] = [];
    let summaryAttempts = 0;
    let currentOwner = "owner-at-enqueue";
    const tailPrompt = "pending tail";
    const enqueue = (prompt: string, sourceEligible: boolean | undefined) => {
      const source = createQueueTestRun(
        {
          prompt,
          personalBootstrapEligible: sourceEligible,
          turnAdoptionLifecycle: {
            admission: "cancel-only",
            onAdopted: vi.fn(),
            onSettled: vi.fn(),
          },
        },
        { sessionKey: key, bootstrapUserProfileId: `stale-source-owner-${sources.length}` },
      );
      sources.push(source);
      expect(enqueueFollowupRun(key, source, settings)).toBe(true);
      return source;
    };
    const execute = state.execute.getMockImplementation()!;
    state.execute.mockImplementation((params: AgentTurnParams) => {
      executions.push({
        prompt: params.commandBody,
        profile: params.followupRun.run.bootstrapUserProfileId,
      });
      return execute(params);
    });
    const runFollowup = async (queued: FollowupRun) => {
      const summary = queued.prompt.startsWith("[Queue overflow]");
      if (summary) {
        summaryAttempts += 1;
        if (deferred && summaryAttempts === 1) {
          firstAttempt.resolve();
          await releaseFirstAttempt.promise;
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
              },
            }),
            defaults: {
              typing: createMockTypingController(),
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
        // Surface detached drain failures through the awaited completion.
        clearFollowupQueue(key);
        completed.reject(error);
      }
    };

    try {
      const first = enqueue("first summarized request", eligible);
      enqueue("second summarized request", true);
      if (ordinary) {
        enqueue("pending predecessor", true);
      }
      if (!deferred) {
        enqueue(tailPrompt, true);
      }
      currentOwner = "current-session-owner";
      scheduleFollowupDrain(key, runFollowup);

      if (deferred) {
        await Promise.race([firstAttempt.promise, completed.promise]);
        expect(summaryAttempts).toBe(1);
        expect(executions).toEqual([]);
        // Compaction during deferral must preserve the original source eligibility.
        enqueue(tailPrompt, true);
        currentOwner = "owner-after-deferral";
      }
      const queue = getExistingFollowupQueue(key);
      expect(queue?.droppedCount).toBe(2);
      if (ordinary) {
        expect(queue?.summaryElisions).toHaveLength(0);
      } else {
        expect(queue?.summaryElisions).toHaveLength(1);
        expect(queue?.summaryElisions[0]?.sources).toHaveLength(1);
        expect(queue?.summaryElisions[0]?.sources[0]).not.toBe(first);
      }
      releaseFirstAttempt.resolve();
      await completed.promise;

      expect(summaryAttempts).toBe(deferred ? 2 : 1);
      expect(executions.map(({ profile }) => profile)).toEqual([
        eligible ? currentOwner : undefined,
        ...(path === "compacted sources" ? [currentOwner] : [currentOwner, currentOwner]),
      ]);
      expect(executions[0]?.prompt).toContain(
        deferred
          ? "[Queue overflow] Dropped 1 message due to cap."
          : "[Queue overflow] Dropped 2 messages due to cap.",
      );
      if (deferred) {
        // New overflow cannot join an already selected source claim.
        expect(executions[1]?.prompt).toContain("second summarized request");
        expect(executions[0]?.prompt).not.toContain("second summarized request");
      }
      for (const source of sources) {
        expect(source.turnAdoptionLifecycle?.onAdopted).toHaveBeenCalledOnce();
        expect(source.turnAdoptionLifecycle?.onSettled).toHaveBeenCalledOnce();
      }
    } finally {
      releaseFirstAttempt.resolve();
      clearFollowupQueue(key);
    }
  },
);
