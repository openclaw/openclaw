import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionExactEntriesWorkerResult } from "../config/sessions/session-entry-read.types.js";
import { historyLane } from "../config/sessions/session-transcript-worker-resources.js";
import { withSessionHistoryWorkerDatabase } from "../config/sessions/session-transcript-worker-runtime.js";
import { runWithAgentCreationClaim } from "../state/agent-creation-claim.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { createAgentCreationWitnessSource } from "../state/openclaw-agent-execution.creation-fixture.test-support.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { refreshCostUsageCacheForAgent } from "./session-cost-usage-aggregation.js";
import { loadSessionCostSummariesFromCache } from "./session-cost-usage.js";
import * as operationAdmission from "./sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

it("refreshes usage while the lifecycle owner is creating the agent database", async () => {
  onTestFinished(() => clearRuntimeConfigSnapshot());
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    openOpenClawStateDatabase({ env: state.env });
    const agentId = "main";
    const sessionFile = state.path("pending-creation.jsonl");
    await fs.writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "message",
        message: { role: "assistant", usage: { input: 3, output: 2, totalTokens: 5 } },
      })}\n`,
    );
    const creator = captureOpenClawAgentDatabaseExecution({ agentId, env: state.env });
    let refresh: Promise<"refreshed" | "busy"> | undefined;
    try {
      await creator.prepare(
        createAgentCreationWitnessSource((request) => {
          if (
            !refresh &&
            request.stage === "prepare" &&
            isRecord(request.facts) &&
            request.facts.kind === "shared-owner"
          ) {
            expect(creator.fileIdentity).toBeUndefined();
            refresh = refreshCostUsageCacheForAgent({
              agentId,
              env: state.env,
              sessionFiles: [sessionFile],
            });
            void refresh.catch(() => {});
          }
        }),
      );
      expect(refresh).toBeDefined();
      await expect(refresh).resolves.toBe("refreshed");
      expect(
        await loadSessionCostSummariesFromCache({
          agentId,
          sessions: [{ sessionFile }],
          requestRefresh: false,
        }),
      ).toMatchObject({ summaries: [{ totalTokens: 5 }], cacheStatus: { status: "fresh" } });
    } finally {
      await refresh?.catch(() => {});
      await creator.release();
    }
  });
});

it.each(["none", "cleanup", "after-open", "during-open"] as const)(
  "fences a cache creator's reader proof (failure=%s)",
  async (failure) => {
    onTestFinished(() => clearRuntimeConfigSnapshot());
    const failCleanup = failure === "cleanup";
    const failDuringOpen = failure === "during-open";
    const failAfterOpen = failure === "after-open" || failDuringOpen;
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      // Prepare shared schema while leaving the competing agent creation cold.
      openOpenClawStateDatabase({ env: state.env });
      const sessionFile = state.path("cache-creation.jsonl");
      await fs.writeFile(
        sessionFile,
        `${JSON.stringify({
          type: "message",
          id: "usage",
          parentId: null,
          message: { role: "assistant", usage: { input: 1, output: 1, totalTokens: 2 } },
        })}\n`,
      );
      const exercise = async () => {
        const agentId = "main";
        const sessionKey = "agent:main:competing-creation";
        const entry = { sessionId: "competing-creation", label: "Preserved reader", updatedAt: 1 };
        const releaseReader = createDeferred();
        const readerHeld = createDeferred();
        const cleanupFailure = new Error("Cache creator admission cleanup failed");
        const refreshRefusal = new Error("Cache creator schema refresh refused after native open");
        let refusedOpenRequests = 0;
        let reading: Promise<SessionExactEntriesWorkerResult> | undefined;
        const run = historyLane.pool.run.bind(historyLane.pool);
        const reader = vi
          .spyOn(historyLane.pool, "run")
          .mockImplementation(async (input, options) => {
            readerHeld.resolve();
            await releaseReader.promise;
            return run(input, options);
          });
        const admission = probe.admission(operationAdmission, (request, grant, authorize) => {
          authorize(request, () => {
            if (failAfterOpen && reading && request.stage === "open") {
              refusedOpenRequests += 1;
              throw refreshRefusal;
            }
            if (
              !reading &&
              request.stage === "prepare" &&
              isRecord(request.facts) &&
              request.facts.kind ===
                (failDuringOpen
                  ? "agent-registration-start"
                  : failAfterOpen
                    ? "agent-registration-committed"
                    : "shared-owner")
            ) {
              const database = openOpenClawAgentDatabase({ agentId, env: state.env });
              replaceSessionEntrySync({ agentId, env: state.env, sessionKey }, entry);
              // Hold a real peer receipt across the creator's refusal and complete cleanup.
              reading = withSessionHistoryWorkerDatabase(database, (owner) =>
                owner.readExactEntries({ env: state.env, sessionKeys: [sessionKey] }),
              );
              const granted = grant();
              if (failCleanup) {
                throw cleanupFailure;
              }
              return granted;
            }
            return grant();
          });
        });
        try {
          const refresh = refreshCostUsageCacheForAgent({
            agentId,
            env: state.env,
            sessionFiles: [sessionFile],
          });
          if (failCleanup) {
            await expect(refresh).rejects.toMatchObject({
              cause: expect.objectContaining({
                message: "Agent database target changed before creating open",
              }),
              errors: [expect.any(Error), expect.objectContaining({ errors: [cleanupFailure] })],
            });
          } else if (failAfterOpen) {
            await expect(refresh).rejects.toThrow(refreshRefusal.message);
          } else {
            await expect(refresh).rejects.toThrow(
              "Agent database target changed before creating open",
            );
          }
          expect(refusedOpenRequests).toBe(failAfterOpen ? 1 : 0);
          if (!reading) {
            throw new Error("Cache creator did not reach the reader capture boundary");
          }
          await Promise.race([
            readerHeld.promise,
            reading.then(() => {
              throw new Error("Reader completed without reaching its worker barrier");
            }),
          ]);
          releaseReader.resolve();
          if (failCleanup || failAfterOpen) {
            await expect(reading).rejects.toThrow(
              "Session reader validation does not match its current physical owner",
            );
          } else {
            await expect(reading).resolves.toMatchObject({ entries: [{ sessionKey, entry }] });
          }
        } finally {
          releaseReader.resolve();
          await reading?.catch(() => {});
          reader.mockRestore();
          admission.mockRestore();
        }
      };
      if (failDuringOpen) {
        await runWithAgentCreationClaim({ agentId: "main", env: state.env }, exercise);
      } else {
        await exercise();
      }
    });
  },
);
