import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withSessionManagerWrite } from "../../agents/sessions/session-manager-write-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import * as sessionAccess from "../../config/sessions/session-accessor.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  createWorkerTurnTunnel,
  credential,
  placements,
  reconcileUnchangedLocalWorkspace,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";
import { withWorkerTurnTranscriptDatabase } from "./worker-turn-transcript-target.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { reconcileWorkspaceAfterTurn as reconcileWorkspaceAfterTurnCore } from "./workspace-result-finalize.js";
import * as resultStaging from "./workspace-result-staging.js";

afterAll(closeStateDatabaseForTest);

// Pause only the physical admission boundary, without holding a native database lock.
vi.mock("../../agents/sessions/session-manager-write-admission.js", () => ({
  withSessionManagerWrite: vi.fn(),
}));

type Effect = { mock: { calls: unknown[][] } };

function deferTranscriptWrite() {
  const entered = createDeferred();
  const release = createDeferred();
  vi.mocked(withSessionManagerWrite).mockImplementation(async (_manager, write) => {
    entered.resolve();
    await release.promise;
    return write();
  });
  return {
    release,
    async wait(operation: Promise<unknown>, ...effects: Effect[]) {
      expect(await Promise.race([entered.promise.then(() => "queued"), operation])).toBe("queued");
      expectUnwritten(...effects);
    },
  };
}

function expectUnwritten(...effects: Effect[]) {
  expect(SessionManager.open(sessionTarget).getBranch()).toEqual([]);
  expect(effects.map((effect) => effect.mock.calls)).toEqual(effects.map(() => []));
}

function patchEntry(patch: { activeWriterRunId?: string; lifecycleRevision?: string }) {
  return sessionAccess.patchSessionEntryCore(sessionTarget, () => patch);
}

function deleteEntry(expectedSessionId: string) {
  return sessionAccess.deleteSessionEntryLifecycle({
    ...sessionTarget,
    archiveTranscript: false,
    target: { canonicalKey: sessionTarget.sessionKey, storeKeys: [sessionTarget.sessionKey] },
    expectedSessionId,
  });
}

describe("cloud transcript write admission", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(withSessionManagerWrite).mockReset();
    await cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true });
  });

  it.each(["current", "run", "claim", "environment", "missing", "writer", "lifecycle"] as const)(
    "checks %s authority after admitting the fallback user write",
    async (change) => {
      await seedActivePlacement();
      const input = turn();
      await patchEntry({
        activeWriterRunId: input.runId,
        lifecycleRevision: "initial-lifecycle",
      });
      const entry = sessionAccess.loadSessionEntry(sessionTarget);
      assert(entry, "expected current session entry");
      const fencedTarget = {
        ...sessionTarget,
        expectedWriterRunId: input.runId,
        expectedLifecycleRevision: entry.lifecycleRevision,
      };
      const gate = deferTranscriptWrite();
      const notified = vi.fn();
      const launch = vi
        .fn<() => Promise<never>>()
        .mockRejectedValue(new Error("fixture reached worker launch"));
      const environment = attachedEnvironment();
      const tunnel = createWorkerTurnTunnel({
        launchTurn: launch,
        quiesceWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
      });
      const provider = createWorkerSessionTurnPlacementProvider({
        placements,
        environments: {
          ...unusedEnvironments(),
          get: () => environment,
          acquireTurnCredential: async () => credential(),
          acknowledgeCredentialDelivery: async () => true,
          startTunnel: async () => tunnel,
        },
      });
      let runCurrent = true;
      const operation = provider
        .executeTurn(
          { ...sessionTarget, runId: input.runId },
          { ...input, sessionTarget: fencedTarget, onUserMessagePersisted: notified },
          vi.fn(),
          undefined,
          () => assert(runCurrent, "fixture run closed"),
        )
        .catch((error: unknown) => error);
      try {
        await gate.wait(operation, notified, launch);
        if (change === "run") {
          runCurrent = false;
        } else if (change === "claim") {
          const placement = placements.get(SESSION_ID);
          const claim = placement ? projectWorkerSessionTurnClaim(placement) : undefined;
          assert(claim, "expected current worker claim");
          await placements.releaseTurn(claim);
        } else if (change === "environment") {
          environment.ownerEpoch += 1;
        } else if (change === "missing") {
          await deleteEntry(entry.sessionId);
        } else if (change === "writer" || change === "lifecycle") {
          await patchEntry(
            change === "writer"
              ? { activeWriterRunId: "replacement-run" }
              : { lifecycleRevision: "replacement-lifecycle" },
          );
        }
        gate.release.resolve();
        const outcome = await operation;
        if (change === "current") {
          expect(outcome).toMatchObject({ message: "fixture reached worker launch" });
          expect(SessionManager.open(sessionTarget).getBranch()).toMatchObject([
            { type: "message", message: { role: "user" } },
          ]);
          expect([notified.mock.calls.length, launch.mock.calls.length]).toEqual([1, 1]);
        } else {
          expect(outcome).toBeInstanceOf(Error);
          expectUnwritten(notified, launch);
        }
      } finally {
        gate.release.resolve();
        await operation;
        input.preparedRunAdmission.close();
      }
    },
  );

  it.each([
    { change: "current", cleared: false },
    { change: "draining", cleared: false },
    { change: "claim", cleared: false },
    { change: "missing", cleared: false },
    { change: "writer", cleared: false },
    { change: "current", cleared: true },
  ] as const)(
    "checks $change settlement authority after admitting a workspace report (cleared: $cleared)",
    async ({ change, cleared }) => {
      await seedActivePlacement("remote-exec");
      const placement = placements.get(SESSION_ID);
      assert(placement?.state === "active", "expected active placement");
      const turnClaim = await placements.claimTurn({
        ...sessionTarget,
        owner: { kind: "local", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
        claimId: "report-claim",
        runId: "report-run",
      });
      await placements.markWorkspaceResultPending(turnClaim);
      if (cleared) {
        placements.recordWorkspaceResultConflict(turnClaim, {
          paths: ["src/local.ts"],
          stagedResultRef: resultStaging.workerWorkspaceResultRef("prior-claim"),
          totalCount: 1,
        });
        vi.spyOn(resultStaging, "deleteStagedWorkerWorkspaceResult").mockResolvedValue();
      }
      await patchEntry({ activeWriterRunId: turnClaim.runId });
      const entry = sessionAccess.loadSessionEntry(sessionTarget);
      assert(entry, "expected current session entry");
      const gate = deferTranscriptWrite();
      const publish = vi.fn();
      const tunnel: WorkerWorkspaceTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
        reconcileWorkspace: async (request) => {
          assert(
            request.source.kind === "local" && request.source.stagedResult,
            "expected local staged result",
          );
          if (!cleared) {
            await request.source.stagedResult.record(request.source.stagedResult.ref);
          }
          return {
            ...(await reconcileUnchangedLocalWorkspace(request)),
            getAppliedWorkspaceResult: () => ({
              manifestRef: MANIFEST_REF,
              manifest: { version: 1, baseCommit: null, entries: [] },
              conflictPaths: cleared ? [] : ["src/local.ts"],
              verifyLocalStable: async () => {},
            }),
          };
        },
        syncWorkspace: vi.fn(),
        stop: vi.fn(),
      };
      const target = { ...sessionTarget, expectedWriterRunId: turnClaim.runId };
      const operation = withWorkerTurnTranscriptDatabase(
        { ...target, sessionTarget: target },
        {
          assertCurrent() {},
          prepareAuthority: () => placements.prepareTurnClaimAuthority(turnClaim),
        },
        (transcriptTarget) =>
          reconcileWorkspaceAfterTurnCore({
            placement,
            placements,
            turnClaim,
            transcriptTarget,
            tunnel,
            workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
            workspace: { kind: "local", path: root },
            publishAcceptedWorkspace: publish,
          }),
      ).catch((error: unknown) => error);
      try {
        await gate.wait(operation, publish);
        expect(placements.validateWorkspaceResultClaim(turnClaim)).toBe(true);
        if (change === "draining") {
          await placements.startWorkspaceResultDrain(turnClaim);
        } else if (change === "claim") {
          vi.spyOn(placements, "validateWorkspaceResultClaim").mockReturnValue(false);
        } else if (change === "missing") {
          await deleteEntry(entry.sessionId);
        } else if (change === "writer") {
          await patchEntry({ activeWriterRunId: "replacement-run" });
        }
        gate.release.resolve();
        const outcome = await operation;
        if (change === "current" || change === "draining") {
          expect(outcome).toEqual(
            cleared ? undefined : expect.objectContaining({ paths: ["src/local.ts"] }),
          );
          const customType = `cloud-workspace-conflict${cleared ? "-cleared" : ""}`;
          expect(SessionManager.open(sessionTarget).getBranch()).toMatchObject([
            { type: "custom_message", customType },
          ]);
          expect(publish).toHaveBeenCalledOnce();
          expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
        } else {
          expect(outcome).toBeInstanceOf(Error);
          expectUnwritten(publish);
          expect(await placements.listPendingWorkspaceResultsAsync()).toHaveLength(1);
        }
      } finally {
        gate.release.resolve();
        await operation;
      }
    },
  );
});
