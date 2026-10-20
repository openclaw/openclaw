import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
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
import { refreshCostUsageCacheForAgent as refreshUsage } from "./session-cost-usage-aggregation.js";
import { loadSessionCostSummariesFromCache as loadCached } from "./session-cost-usage.js";
import * as operationAdmission from "./sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "./sqlite-worker-owner-probe.test-support.js";

const changedTarget = "Agent database target changed before creating open";
function preparing(request: operationAdmission.SqliteWorkerAdmissionRequest, kind: string) {
  return request.stage === "prepare" && isRecord(request.facts) && request.facts.kind === kind;
}

function writeUsage(sessionFile: string, input: number, output: number, id?: string) {
  return fs.writeFile(
    sessionFile,
    `${JSON.stringify({
      type: "message",
      ...(id ? { id, parentId: null } : {}),
      message: { role: "assistant", usage: { input, output, totalTokens: input + output } },
    })}\n`,
  );
}

it("refreshes usage while the lifecycle owner is creating the agent database", async () => {
  onTestFinished(() => clearRuntimeConfigSnapshot());
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    setRuntimeConfigSnapshot({});
    openOpenClawStateDatabase({ env: state.env });
    const agentId = "main";
    const sessionFile = state.path("pending-creation.jsonl");
    await writeUsage(sessionFile, 3, 2);
    const creator = captureOpenClawAgentDatabaseExecution({ agentId, env: state.env });
    let refresh: Promise<"refreshed" | "busy"> | undefined;
    try {
      await creator.prepare(
        createAgentCreationWitnessSource((request) => {
          if (!refresh && preparing(request, "shared-owner")) {
            expect(creator.fileIdentity).toBeUndefined();
            refresh = refreshUsage({ agentId, env: state.env, sessionFiles: [sessionFile] });
            void refresh.catch(() => {});
          }
        }),
      );
      expect(refresh).toBeDefined();
      await expect(refresh).resolves.toBe("refreshed");
      expect(
        await loadCached({ agentId, sessions: [{ sessionFile }], requestRefresh: false }),
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
    const captureStage = failDuringOpen
      ? "agent-registration-start"
      : failAfterOpen
        ? "agent-registration-committed"
        : "shared-owner";
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      setRuntimeConfigSnapshot({});
      // Prepare shared schema while leaving the competing agent creation cold.
      openOpenClawStateDatabase({ env: state.env });
      const sessionFile = state.path("cache-creation.jsonl");
      await writeUsage(sessionFile, 1, 1, "usage");
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
            if (!reading && preparing(request, captureStage)) {
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
          const refresh = refreshUsage({ agentId, env: state.env, sessionFiles: [sessionFile] });
          if (failCleanup) {
            await expect(refresh).rejects.toMatchObject({
              cause: expect.objectContaining({ message: changedTarget }),
              errors: [expect.any(Error), expect.objectContaining({ errors: [cleanupFailure] })],
            });
          } else {
            await expect(refresh).rejects.toThrow(
              failAfterOpen ? refreshRefusal.message : changedTarget,
            );
          }
          expect(refusedOpenRequests).toBe(failAfterOpen ? 1 : 0);
          assert(reading, "Cache creator did not reach the reader capture boundary");
          await awaitGateBeforeSettlement(
            readerHeld.promise,
            reading,
            "Reader completed without reaching its worker barrier",
          );
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
