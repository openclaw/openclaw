import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { getRuntimeConfig } from "../config/config.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.runtime.js";
import {
  loadTranscriptEvents,
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "../config/sessions/session-accessor.sqlite-scope.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { captureSessionTranscriptTargetBinding } from "../config/sessions/transcript-target-binding.js";
import { withOwnedSessionTranscriptWrites } from "../config/sessions/transcript-write-context.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { REQUEST } from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createHarness } from "./worker-environments/placement-dispatch-test-harness.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import {
  WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
  WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
} from "./worker-environments/workspace-conflicts.js";
import { createWorkerWorkspaceConflictTranscriptHandlers } from "./worker-workspace-conflict-transcript.js";

const IDENTITY = {
  agentId: "main",
  sessionId: "workspace-recovery-session",
  sessionKey: "agent:main:main",
};

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function loadSessionRuntime() {
  return import("./session-utils.js");
}

function withRecoveryState(run: Parameters<typeof withOpenClawTestState>[1]) {
  return withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    await captureRuntimeConfigAsyncReader()();
    await run(state);
  });
}

function seedSession(fields: Parameters<typeof upsertSessionEntryCore>[1] = {}) {
  return upsertSessionEntryCore(IDENTITY, {
    sessionId: IDENTITY.sessionId,
    updatedAt: 1,
    ...fields,
  });
}

const sessionHeader = { type: "session", id: IDENTITY.sessionId, version: CURRENT_SESSION_VERSION };
const conflict = {
  paths: ["edited.ts"],
  stagedResultRef: "refs/openclaw/worker-results/result-1",
  totalCount: 1,
};
function conflictEvent(id: string, parentId: string | null, details = conflict) {
  return {
    type: "custom_message",
    id,
    parentId,
    customType: WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
    content: "Conflict",
    display: true,
    details,
  };
}

async function createHandlers(identity = IDENTITY) {
  const runtime = await loadSessionRuntime();
  const target = await runtime.resolveGatewaySessionStoreTargetInWorker({
    cfg: getRuntimeConfig(),
    key: identity.sessionKey,
    agentId: identity.agentId,
  });
  const entry = loadSessionEntryReadOnly({
    ...identity,
    storePath: target.readSource?.path ?? target.storePath,
    defaultAgentId: target.readSource?.agentId,
  });
  return createWorkerWorkspaceConflictTranscriptHandlers(
    {
      ...captureSessionTranscriptTargetBinding({
        ...identity,
        storePath: target.readSource?.path ?? target.storePath,
      }),
      defaultAgentId: target.readSource?.agentId,
      expectedLifecycleRevision: entry?.lifecycleRevision,
      expectedWriterRunId: entry?.activeWriterRunId,
    },
    () => {},
  );
}

async function readRecoveryEvents(identity = IDENTITY) {
  const events = await loadTranscriptEvents(identity);
  return events.filter(
    (event): event is Record<string, unknown> =>
      isRecord(event) &&
      event.type === "custom_message" &&
      event.customType === WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
  );
}

describe("worker workspace recovery transcript reporting", () => {
  it.each(["reset", "opaque"])(
    "selects conflict reports through %s navigation without adopting an inactive clear",
    async (navigation) => {
      await withRecoveryState(async () => {
        await seedSession();
        await replaceTranscriptEvents(IDENTITY, [
          sessionHeader,
          {
            type: "message",
            id: "root",
            parentId: null,
            message: { role: "user", content: "Start" },
          },
          conflictEvent("conflict", "root"),
          {
            type: "custom_message",
            id: "inactive-clear",
            parentId: "conflict",
            customType: WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
            content: "Cleared",
            display: false,
          },
          { type: "provider_event", id: "opaque", parentId: "conflict", evidence: "unchanged" },
          navigation === "reset"
            ? { type: "reset", id: "reset", parentId: null, reason: "reset" }
            : {
                type: "leaf",
                id: "selection",
                parentId: "opaque",
                targetId: navigation === "opaque" ? "opaque" : "conflict",
              },
        ]);
        const handlers = await createHandlers();
        expect(await handlers.resolveConflict()).toEqual(
          navigation === "reset" ? { kind: "absent" } : { kind: "conflict", conflict },
        );
        await handlers.reportConflict(conflict);
        expect(await handlers.resolveConflict()).toEqual({ kind: "conflict", conflict });
        await handlers.reportConflict({ cleared: true });
        await handlers.reportConflict({ cleared: true });
        expect(await handlers.resolveConflict()).toEqual({ kind: "absent" });
        const reports = (await loadTranscriptEvents(IDENTITY)).filter(
          (event) => isRecord(event) && event.type === "custom_message",
        );
        expect(reports).toHaveLength(navigation === "reset" ? 4 : 3);
        expect(reports.at(-1)).toMatchObject({
          customType: WORKSPACE_CONFLICT_CLEARED_TRANSCRIPT_TYPE,
          display: false,
        });
      });
    },
  );
  it("reports an invalid staged ref as unknown instead of treating a retained conflict as absent", async () => {
    await withRecoveryState(async () => {
      await seedSession();
      await replaceTranscriptEvents(IDENTITY, [
        sessionHeader,
        conflictEvent("malformed-conflict", null, {
          ...conflict,
          stagedResultRef: "refs/heads/main",
        }),
      ]);
      const handlers = await createHandlers();
      expect(await handlers.resolveConflict()).toEqual({
        kind: "unknown",
        reason: "malformed-report",
      });
    });
  });

  it.each(["missing", "rebound"])(
    "reports a %s session as unavailable instead of treating its conflict as absent",
    async (sessionState) => {
      await withRecoveryState(async () => {
        if (sessionState === "rebound") {
          await seedSession({ sessionId: "replacement-workspace-session" });
        }
        const handlers = await createHandlers();
        expect(await handlers.resolveConflict()).toEqual({
          kind: "unknown",
          reason: "session-unavailable",
        });
      });
    },
  );

  it("records historical recovery failures while preserving the live pending-result owner", async () => {
    await withRecoveryState(async (state) => {
      await upsertSessionEntryCore(REQUEST, { sessionId: REQUEST.sessionId, updatedAt: 1 });
      const workspacePath = state.statePath("recovery-workspace");
      await fs.mkdir(workspacePath, { recursive: true });
      expect(
        (
          await runCommandWithTimeout(["git", "-C", workspacePath, "init", "--quiet"], {
            timeoutMs: 10_000,
          })
        ).code,
      ).toBe(0);
      const placements = createWorkerSessionPlacementStore();
      const harnessOptions: { reconcileFails: boolean; workspacePath: string } = {
        reconcileFails: true,
        workspacePath,
      };
      const harness = await createHarness(openOpenClawStateDatabase(), placements, harnessOptions);
      const active = await harness.placements.seedActive(2);
      if (active.state !== "active") {
        throw new Error("expected active worker placement");
      }
      harness.markEnvironmentOwnerEpoch(active.activeOwnerEpoch);
      harness.markEnvironmentNodeDeviceId("workspace-recovery-worker-node");
      const claim = await placements.claimTurn({
        ...REQUEST,
        claimId: "workspace-recovery-claim",
        runId: "workspace-recovery-run",
        owner: {
          kind: "worker",
          environmentId: active.environmentId,
          ownerEpoch: active.activeOwnerEpoch,
        },
      });
      await placements.markWorkspaceResultPending(claim);
      await placements.handoffWorkspaceResultRecovery(claim);
      const { reportFailure } = await createHandlers(REQUEST);
      harness.reportWorkspaceResultRecoveryFailure.mockImplementation(({ error }) =>
        reportFailure(error),
      );

      await harness.service.reconcile();
      await harness.service.reconcile();

      expect(placements.get(active.sessionId)).toMatchObject({
        state: "active",
        generation: active.generation,
        environmentId: active.environmentId,
        turnClaim: { claimId: claim.claimId, runId: claim.runId },
      });
      expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
      expect(harness.environments.destroy).not.toHaveBeenCalled();
      expect(await readRecoveryEvents(REQUEST)).toMatchObject([
        {
          customType: WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
          content: expect.stringContaining("workspace conflict"),
          display: true,
        },
      ]);

      harnessOptions.reconcileFails = false;
      await harness.service.reconcile();
      await harness.service.reconcile();

      expect(placements.get(active.sessionId)).toMatchObject({ state: "active", turnClaim: null });
      expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
      expect(await readRecoveryEvents(REQUEST)).toMatchObject([
        { customType: WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE, display: true },
      ]);
    });
  });

  it("persists bounded recovery failures and deduplicates identical consecutive attempts", async () => {
    await withRecoveryState(async () => {
      await seedSession();
      const { reportFailure } = await createHandlers();
      const secret = [
        String.fromCharCode(115, 107),
        "proj",
        "recovery",
        "abcdefghijklmnopqrstuvwxyz",
      ].join("-");
      const firstError = `snapshot rejected token=${secret} ${"detail ".repeat(200)}`;

      await reportFailure(firstError);
      await reportFailure(firstError);

      const firstEvents = await readRecoveryEvents();
      expect(firstEvents).toHaveLength(1);
      expect(firstEvents[0]).toMatchObject({
        customType: WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
        display: true,
        content: expect.stringMatching(
          /^Cloud workspace recovery attempt failed: snapshot rejected token=.*OpenClaw preserved the result and will retry\.$/u,
        ),
      });
      expect(JSON.stringify(firstEvents[0])).not.toContain(secret);
      expect(String(firstEvents[0]?.content).length).toBeLessThanOrEqual(1_024);

      await reportFailure("snapshot verification failed");

      expect(await readRecoveryEvents()).toMatchObject([
        { customType: WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE },
        {
          customType: WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
          content: expect.stringContaining("snapshot verification failed"),
        },
      ]);
    });
  });

  it("rejects a rebound session identity without touching its replacement transcript", async () => {
    await withRecoveryState(async () => {
      await seedSession();
      const { reportFailure } = await createHandlers();
      await upsertSessionEntryCore(IDENTITY, {
        sessionId: "replacement-workspace-session",
        updatedAt: 2,
      });

      await expect(reportFailure("stale worker recovery")).rejects.toThrow(
        "workspace recovery lost session",
      );

      expect(
        await readRecoveryEvents({ ...IDENTITY, sessionId: "replacement-workspace-session" }),
      ).toEqual([]);
    });
  });

  it.each(["session", "writer"])(
    "revalidates a rebound %s after waiting for the transcript writer",
    async (reboundKind) => {
      await withRecoveryState(async () => {
        await seedSession({ activeWriterRunId: "report-writer" });
        const { reportFailure } = await createHandlers();
        const reportTarget = await (
          await loadSessionRuntime()
        ).resolveGatewaySessionStoreTargetInWorker({
          cfg: getRuntimeConfig(),
          key: IDENTITY.sessionKey,
          agentId: IDENTITY.agentId,
        });
        const { promise: writerHeld, resolve: signalWriterHeld } = createDeferred();
        const release = createDeferred();
        const blocker = runExclusiveSqliteSessionWrite(
          { agentId: IDENTITY.agentId },
          async () => {
            signalWriterHeld();
            await release.promise;
          },
          "session.transcript.batch",
        );
        await writerHeld;

        const rebound = upsertSessionEntryCore(IDENTITY, {
          sessionId:
            reboundKind === "session" ? "replacement-workspace-session" : IDENTITY.sessionId,
          activeWriterRunId: "replacement-writer",
          updatedAt: 2,
        });
        const report = () => reportFailure("queued stale recovery");
        const reporting = (
          reboundKind === "session"
            ? report()
            : withOwnedSessionTranscriptWrites(
                {
                  sessionTarget: {
                    ...IDENTITY,
                    storePath: reportTarget.storePath,
                    expectedWriterRunId: "report-writer",
                  },
                  withTranscriptWrite: async (run) => await run(),
                },
                report,
              )
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        await Promise.resolve();
        await Promise.resolve();
        release.resolve();
        await blocker;
        await rebound;

        await expect(reporting).resolves.toEqual(
          expect.objectContaining({
            message: expect.stringContaining("session writer claim changed"),
          }),
        );
        expect(await readRecoveryEvents()).toEqual([]);
      });
    },
  );
});
