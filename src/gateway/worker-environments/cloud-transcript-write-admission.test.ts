import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withSessionManagerWrite } from "../../agents/sessions/session-manager-write-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import * as sessionAccess from "../../config/sessions/session-accessor.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  ENVIRONMENT_ID,
  MANIFEST_REF,
  OWNER_EPOCH,
  SESSION_ID,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  credential,
  measureLaunchTurn,
  placements,
  root,
  seedActivePlacement,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { reconcileWorkspaceAfterTurn } from "./workspace-result-finalize.js";
import * as resultStaging from "./workspace-result-staging.js";

// Pause only the physical admission boundary, without holding a native database lock.
vi.mock("../../agents/sessions/session-manager-write-admission.js", () => ({
  withSessionManagerWrite: vi.fn(),
}));

function deferTranscriptWrite() {
  const entered = createDeferred();
  const release = createDeferred();
  vi.mocked(withSessionManagerWrite).mockImplementation(async (_manager, write) => {
    entered.resolve();
    await release.promise;
    return write();
  });
  return { entered, release };
}

describe("cloud transcript write admission", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(withSessionManagerWrite).mockReset();
    await cleanupWorkerTurnLauncherTest();
  });

  it.each(["current", "run", "claim", "environment", "missing", "writer", "lifecycle"] as const)(
    "checks %s authority after admitting the fallback user write",
    async (change) => {
      seedActivePlacement();
      const input = turn();
      await sessionAccess.patchSessionEntryCore(sessionTarget, () => ({
        activeWriterRunId: input.runId,
        lifecycleRevision: "initial-lifecycle",
      }));
      const entry = sessionAccess.loadSessionEntry(sessionTarget);
      if (!entry) {
        throw new Error("expected current session entry");
      }
      const fencedTarget = {
        ...sessionTarget,
        expectedWriterRunId: input.runId,
        expectedLifecycleRevision: entry.lifecycleRevision,
      };
      const gate = deferTranscriptWrite();
      const notified = vi.fn();
      const launch = vi.fn(async () => {
        throw new Error("fixture reached worker launch");
      });
      const environment = attachedEnvironment();
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        runWorkspaceCommand: vi.fn(),
        measureLaunchTurn,
        launchTurn: launch,
        quiesceWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
        syncWorkspace: vi.fn(),
        stop: vi.fn(),
      };
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
          () => {
            if (!runCurrent) {
              throw new Error("fixture run closed");
            }
          },
        )
        .catch((error: unknown) => error);
      try {
        expect(await Promise.race([gate.entered.promise.then(() => "queued"), operation])).toBe(
          "queued",
        );
        expect(SessionManager.open(sessionTarget).getBranch()).toEqual([]);
        expect(notified).not.toHaveBeenCalled();
        expect(launch).not.toHaveBeenCalled();
        if (change === "run") {
          runCurrent = false;
        } else if (change === "claim") {
          const placement = placements.get(SESSION_ID);
          const claim = placement ? projectWorkerSessionTurnClaim(placement) : undefined;
          if (!claim) {
            throw new Error("expected current worker claim");
          }
          placements.releaseTurn(claim);
        } else if (change === "environment") {
          environment.ownerEpoch += 1;
        } else if (change === "missing") {
          vi.spyOn(sessionAccess, "loadSessionEntry").mockReturnValue(undefined);
        } else if (change === "writer" || change === "lifecycle") {
          vi.spyOn(sessionAccess, "loadSessionEntry").mockReturnValue({
            ...entry,
            ...(change === "writer"
              ? { activeWriterRunId: "replacement-run" }
              : { lifecycleRevision: "replacement-lifecycle" }),
          });
        }
        gate.release.resolve();
        const outcome = await operation;
        if (change === "current") {
          expect(outcome).toMatchObject({ message: "fixture reached worker launch" });
          expect(SessionManager.open(sessionTarget).getBranch()).toMatchObject([
            { type: "message", message: { role: "user" } },
          ]);
          expect(notified).toHaveBeenCalledOnce();
          expect(launch).toHaveBeenCalledOnce();
        } else {
          expect(outcome).toBeInstanceOf(Error);
          expect(SessionManager.open(sessionTarget).getBranch()).toEqual([]);
          expect(notified).not.toHaveBeenCalled();
          expect(launch).not.toHaveBeenCalled();
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
    { change: "claim", cleared: true },
  ] as const)(
    "checks $change settlement authority after admitting a workspace report (cleared: $cleared)",
    async ({ change, cleared }) => {
      seedActivePlacement("remote-exec");
      const placement = placements.get(SESSION_ID);
      if (placement?.state !== "active") {
        throw new Error("expected active placement");
      }
      const turnClaim = placements.claimTurn({
        ...sessionTarget,
        owner: { kind: "local", environmentId: ENVIRONMENT_ID, ownerEpoch: OWNER_EPOCH },
        claimId: "report-claim",
        runId: "report-run",
      });
      placements.markWorkspaceResultPending(turnClaim);
      if (cleared) {
        placements.recordWorkspaceResultConflict(turnClaim, {
          paths: ["src/local.ts"],
          stagedResultRef: resultStaging.workerWorkspaceResultRef("prior-claim"),
          totalCount: 1,
        });
        vi.spyOn(resultStaging, "deleteStagedWorkerWorkspaceResult").mockResolvedValue();
      }
      await sessionAccess.patchSessionEntryCore(sessionTarget, () => ({
        activeWriterRunId: turnClaim.runId,
      }));
      const entry = sessionAccess.loadSessionEntry(sessionTarget);
      if (!entry) {
        throw new Error("expected current session entry");
      }
      const gate = deferTranscriptWrite();
      const publish = vi.fn();
      const tunnel: WorkerTunnelHandle = {
        environmentId: ENVIRONMENT_ID,
        ownerEpoch: OWNER_EPOCH,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
        reconcileWorkspace: async (request) => {
          if (request.source.kind !== "local" || !request.source.stagedResult) {
            throw new Error("expected local staged result");
          }
          if (!cleared) {
            request.source.stagedResult.record(request.source.stagedResult.ref);
          }
          request.source.journal.commit(MANIFEST_REF);
          return {
            manifestRef: MANIFEST_REF,
            changed: false,
            verifyStable: async () => {},
            verifyLocalStable: async () => {},
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
      const operation = reconcileWorkspaceAfterTurn({
        placement,
        placements,
        turnClaim,
        workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
        workspace: { kind: "local", path: root },
        transcriptTarget: { ...sessionTarget, expectedWriterRunId: turnClaim.runId },
        tunnel,
        publishAcceptedWorkspace: publish,
      }).catch((error: unknown) => error);
      try {
        expect(await Promise.race([gate.entered.promise.then(() => "queued"), operation])).toBe(
          "queued",
        );
        expect(SessionManager.open(sessionTarget).getBranch()).toEqual([]);
        expect(publish).not.toHaveBeenCalled();
        expect(placements.validateWorkspaceResultClaim(turnClaim)).toBe(true);
        if (change === "draining") {
          placements.startWorkspaceResultDrain(turnClaim);
        } else if (change === "claim") {
          vi.spyOn(placements, "validateWorkspaceResultClaim").mockReturnValue(false);
        } else if (change === "missing") {
          vi.spyOn(sessionAccess, "loadSessionEntry").mockReturnValue(undefined);
        } else if (change === "writer") {
          vi.spyOn(sessionAccess, "loadSessionEntry").mockReturnValue({
            ...entry,
            activeWriterRunId: "replacement-run",
          });
        }
        gate.release.resolve();
        const outcome = await operation;
        if (change === "current" || change === "draining") {
          if (cleared) {
            expect(outcome).toBeUndefined();
          } else {
            expect(outcome).toMatchObject({ paths: ["src/local.ts"] });
          }
          expect(SessionManager.open(sessionTarget).getBranch()).toMatchObject([
            {
              type: "custom_message",
              customType: cleared ? "cloud-workspace-conflict-cleared" : "cloud-workspace-conflict",
            },
          ]);
          expect(publish).toHaveBeenCalledOnce();
          expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
        } else {
          expect(outcome).toBeInstanceOf(Error);
          expect(SessionManager.open(sessionTarget).getBranch()).toEqual([]);
          expect(publish).not.toHaveBeenCalled();
          expect(placements.listPendingWorkspaceResults()).toHaveLength(1);
        }
      } finally {
        gate.release.resolve();
        await operation;
      }
    },
  );
});
