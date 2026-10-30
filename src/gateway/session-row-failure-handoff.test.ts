import { expect, it } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { loadRequesterSessionEntry } from "../agents/subagents/announce/subagent-announce-delivery.runtime.js";
import { recordSubagentFailureHandoff } from "../agents/subagents/registry/subagent-failure-handoff.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import { buildSubagentSessionListReadIndex } from "../agents/subagents/registry/subagent-registry-read.js";
import { persistRegistryFixture } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { clearSubagentRunsReadCacheForTest } from "../agents/subagents/registry/subagent-registry-state.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createSessionRowDeltaDiffer,
  prepareSessionRowDeltaFields,
} from "./session-row-delta-fields.js";
import { prepareSessionRowPublication } from "./session-row-presentation.js";
import {
  createTestProjection,
  seedRow,
} from "./session-row-projection.read-fixture.test-support.js";

it.each(["spawner", "ancestor"])(
  "cold-projects committed exact-run failure custody for the %s without exposing receipt bindings",
  async (recipient) => {
    await withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_TEST_READ_SUBAGENT_RUNS_FROM_SQLITE: "1" } },
      async () => {
        const parent = "agent:main:handoff-parent";
        const child = "agent:main:subagent:handoff-child";
        const consumer = recipient === "ancestor" ? "agent:main:ancestor" : parent;
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        const cfg = { session: { store: storePath } };
        setRuntimeConfigSnapshot(cfg);
        seedRow(parent, { sessionId: "spawner", lifecycleRevision: "spawner-1", updatedAt: 1 });
        seedRow(consumer, { sessionId: "parent", lifecycleRevision: "parent-1", updatedAt: 1 });
        const childEntry = {
          sessionId: "child",
          updatedAt: 2,
          spawnedBy: parent,
          lastRunId: "failure-run",
          status: "failed" as const,
          lastRunError: "Synthetic cause",
        };
        seedRow(child, childEntry);
        const requester = await loadRequesterSessionEntry(parent, "main");
        const run = createSubagentRunRecord({
          runId: "failure-run",
          childSessionKey: child,
          requesterSessionKey: parent,
          requesterStorePath: requester.physicalStorePath,
          completionTarget: recipient === "spawner" ? "parent" : undefined,
          completionRequesterSessionId: recipient === "spawner" ? "parent" : "spawner",
          completionRequesterLifecycleRevision: recipient === "spawner" ? "parent-1" : "spawner-1",
          collect: recipient === "ancestor",
          expectsCompletionMessage: recipient === "spawner",
          endedAt: 2,
          outcome: { status: "error", error: "Synthetic cause" },
        });
        subagentRuns.set(run.runId, run);
        try {
          using projection = await createTestProjection({ cfg, modelCatalog: [] });
          const read = async (rowMode: "sidebar" | "dashboard" = "sidebar") => {
            await projection.ensureMaterialized();
            return prepareSessionRowPublication(projection, Date.now())()
              .getPresentation()
              .snapshot({ agentId: "main", key: child }, { rowMode }).row!;
          };
          const forgetResidentRun = () => {
            subagentRuns.delete(run.runId);
            clearSubagentRunsReadCacheForTest();
            publishSubagentRunChanges([child, parent], [run.runId]);
          };
          for (const status of ["pending", "in_progress", "delivered"] as const) {
            persistRegistryFixture(new Map([[run.runId, { ...run, delivery: { status } }]]));
            forgetResidentRun();
            // Pre-receipt persisted rows still load, but transport state is not custody.
            expect(await read()).toMatchObject({
              status: "failed",
              lastRunError: "Synthetic cause",
            });
            expect(await read()).not.toHaveProperty("failureHandedOff");
          }
          subagentRuns.set(run.runId, run);
          persistRegistryFixture(new Map([[run.runId, run]]));
          const recorder = createUserTurnTranscriptRecorder({
            input: {
              text: "Synthetic cause and saved failure findings",
              idempotencyKey: "cold-handoff",
            },
            target: {
              agentId: "main",
              sessionKey: consumer,
              sessionId: "parent",
              storePath,
              sessionEntry: { sessionId: "parent", lifecycleRevision: "parent-1", updatedAt: 1 },
            },
          });
          recorder.setAdmissionHandler!(async (receipt) => {
            await recordSubagentFailureHandoff({
              entries: [subagentRuns.get(run.runId)!],
              requester: receipt,
              assertCurrent: () => {},
              ...(recipient === "ancestor"
                ? {
                    collector: {
                      lifecycleRevision: "parent-1",
                      ownsRun: (entry) => entry.runId === run.runId,
                    },
                  }
                : {}),
            });
          });
          expect(await recorder.persistApproved()).toMatchObject({ appended: true });
          forgetResidentRun();
          expect(await read()).toMatchObject({
            failureHandedOff: true,
            status: "failed",
            lastRunError: "Synthetic cause",
          });
          const handedOff = await read();
          expect(handedOff.failureHandedOff).toBe(true);
          expect((await read("dashboard")).failureHandedOff).toBe(true);
          const cold = buildSubagentSessionListReadIndex().getDisplaySubagentRun(child);
          expect(cold?.delivery?.failureHandoff).toEqual({
            requesterSessionKey: consumer,
            requesterSessionId: "parent",
            requesterLifecycleRevision: "parent-1",
            requesterStorePath: recorder.getAdmissionReceipt()!.storePath,
          });
          expect(subagentRuns.has(run.runId)).toBe(false);
          const wire = JSON.stringify(handedOff);
          for (const privateField of [
            "failureHandoff",
            "requesterSessionKey",
            "requesterSessionId",
            "requesterLifecycleRevision",
            "requesterStorePath",
          ]) {
            expect(wire).not.toContain(privateField);
          }
          expect(wire).not.toContain("parent-1");
          expect(wire).not.toContain(recorder.getAdmissionReceipt()!.storePath);
          seedRow(consumer, {
            sessionId: "parent",
            lifecycleRevision: "parent-reset",
            updatedAt: 3,
          });
          const reset = await read();
          expect(reset).not.toHaveProperty("failureHandedOff");
          const differ = createSessionRowDeltaDiffer();
          expect(
            differ(
              prepareSessionRowDeltaFields(handedOff),
              prepareSessionRowDeltaFields(reset),
              reset,
            ),
          ).toMatchObject({ remove: ["failureHandedOff"] });
          seedRow(consumer, {
            sessionId: "replaced-parent",
            lifecycleRevision: "parent-1",
            updatedAt: 4,
          });
          seedRow("agent:main:foreign", {
            sessionId: "parent",
            lifecycleRevision: "parent-1",
            updatedAt: 4,
          });
          expect(await read()).not.toHaveProperty("failureHandedOff");
          seedRow(consumer, { sessionId: "parent", lifecycleRevision: "parent-1", updatedAt: 4 });
          const restored = await read();
          expect(restored.failureHandedOff).toBe(true);
          await patchSessionEntryCore({ agentId: "main", sessionKey: child, storePath }, () => ({
            lastRunId: "new-own-error",
            updatedAt: 4,
          }));
          const nextRun = await read();
          expect(nextRun).not.toHaveProperty("failureHandedOff");
          expect(
            differ(
              prepareSessionRowDeltaFields(restored),
              prepareSessionRowDeltaFields(nextRun),
              nextRun,
            ),
          ).toMatchObject({ remove: ["failureHandedOff"] });
          expect(nextRun).toMatchObject({
            status: "failed",
            lastRunError: "Synthetic cause",
          });
        } finally {
          subagentRuns.delete(run.runId);
          clearSubagentRunsReadCacheForTest();
        }
      },
    );
  },
);
