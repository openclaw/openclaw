import assert from "node:assert/strict";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { withSessionManagerWrite } from "../../agents/sessions/session-manager-write-admission.js";
import { SessionManager } from "../../agents/sessions/session-manager.js";
import * as sessionAccess from "../../config/sessions/session-accessor.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerWorkspaceTunnelHandle } from "./tunnel-contract.js";
import * as launcher from "./worker-turn-launcher.test-support.js";
import { placements, sessionTarget } from "./worker-turn-launcher.test-support.js";
import { withWorkerTurnTranscriptDatabase } from "./worker-turn-transcript-target.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";
import { reconcileWorkspaceAfterTurn } from "./workspace-result-finalize.js";
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
  beforeEach(launcher.setupWorkerTurnLauncherTest);
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(withSessionManagerWrite).mockReset();
    await launcher.cleanupWorkerTurnLauncherTest({ reuseReadWorkers: true });
  });

  it.each(["current", "run", "claim", "environment", "missing", "writer", "lifecycle"] as const)(
    "checks %s authority after admitting the fallback user write",
    async (change) => {
      await launcher.seedActivePlacement();
      const input = launcher.turn();
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
      const environment = launcher.attachedEnvironment();
      const tunnel = launcher.createWorkerTurnTunnel({
        launchTurn: launch,
        quiesceWorkspace: vi.fn(),
        reconcileWorkspace: vi.fn(),
      });
      const provider = launcher.createWorkerSessionTurnPlacementProvider({
        placements,
        environments: {
          ...launcher.unusedEnvironments(),
          get: () => environment,
          acquireTurnCredential: async () => launcher.credential(),
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
        await {
          current: () => {},
          run: () => (runCurrent = false),
          claim: async () => {
            const placement = placements.get(launcher.SESSION_ID);
            const claim = placement ? projectWorkerSessionTurnClaim(placement) : undefined;
            assert(claim, "expected current worker claim");
            await placements.releaseTurn(claim);
          },
          environment: () => environment.ownerEpoch++,
          missing: () => deleteEntry(entry.sessionId),
          writer: () => patchEntry({ activeWriterRunId: "replacement-run" }),
          lifecycle: () => patchEntry({ lifecycleRevision: "replacement-lifecycle" }),
        }[change]();
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
    ["current", false],
    ["draining", false],
    ["claim", false],
    ["missing", false],
    ["writer", false],
    ["current", true],
  ] as const)(
    "checks %s workspace-report authority after admission (cleared: %s)",
    async (change, cleared) => {
      await launcher.seedActivePlacement("remote-exec");
      const placement = placements.get(launcher.SESSION_ID);
      assert(placement?.state === "active", "expected active placement");
      const { ENVIRONMENT_ID: environmentId, OWNER_EPOCH: ownerEpoch } = launcher;
      const turnClaim = await placements.claimTurn({
        ...sessionTarget,
        owner: { kind: "local", environmentId, ownerEpoch },
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
        environmentId,
        ownerEpoch,
        runWorkspaceCommand: vi.fn(),
        quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
        reconcileWorkspace: async (request) => {
          assert(request.source.kind === "local", "expected local staged result");
          if (!cleared) {
            await request.source.stagedResult.record(request.source.stagedResult.ref);
          }
          return {
            ...(await launcher.reconcileUnchangedLocalWorkspace(request)),
            getAppliedWorkspaceResult: () => ({
              manifestRef: launcher.MANIFEST_REF,
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
          reconcileWorkspaceAfterTurn({
            placement,
            placements,
            turnClaim,
            transcriptTarget,
            tunnel,
            workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
            workspace: { kind: "local", path: launcher.root },
            publishAcceptedWorkspace: publish,
          }),
      ).catch((error: unknown) => error);
      try {
        await gate.wait(operation, publish);
        expect(placements.validateWorkspaceResultClaim(turnClaim)).toBe(true);
        await {
          current: () => {},
          draining: () => placements.startWorkspaceResultDrain(turnClaim),
          claim: () => vi.spyOn(placements, "validateWorkspaceResultClaim").mockReturnValue(false),
          missing: () => deleteEntry(entry.sessionId),
          writer: () => patchEntry({ activeWriterRunId: "replacement-run" }),
        }[change]();
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
          expect(placements.get(launcher.SESSION_ID)?.turnClaim).toBeNull();
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
