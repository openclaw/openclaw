import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { waitForSessionRunEnd } from "../../sessions/session-controller.native-runtime.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import * as worker from "./worker-turn-launcher.test-support.js";
import {
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
  WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
} from "./workspace-conflicts.js";

beforeEach(worker.setupWorkerTurnLauncherTest);
afterEach(worker.cleanupWorkerTurnLauncherTest);

it.for(["accepted", "conflict", "failure"] as const)(
  "delivers the durable reply before %s reconciliation",
  async (outcome, { signal }) => {
    const { placements, SESSION_ID, sessionTarget } = worker;
    const conflictPath = "conflicted.txt";
    const transferFailure = new Error("synthetic workspace transfer failure");
    await worker.seedActivePlacement();
    const input = worker.turn("early-final");
    const followupInput = worker.turn("after-early-final");
    const reconcileEntered = createDeferred();
    const reconcileRelease = createDeferred();
    const workspaceFile = path.join(worker.root, "accepted.txt");
    await writeFile(workspaceFile, "before reconciliation");
    let terminalId: string | undefined;
    const launchTurn = vi.fn<WorkerTurnTunnelHandle["launchTurn"]>(async (request) => {
      request.onDispatchReady?.();
      const launchCount = launchTurn.mock.calls.length;
      if (launchCount !== 1) {
        expect(await readFile(workspaceFile, "utf8")).toBe("accepted worker content");
      }
      const leafId = await worker.appendWorkerReply(
        launchCount === 1 ? "Worker reply" : "Follow-up reply",
        launchCount,
      );
      if (launchCount === 1) {
        terminalId = leafId;
      }
      return worker.acknowledgeCompletedWorkerTurn(request.turnClaim, leafId);
    });
    const tunnel = worker.createWorkerTurnTunnel({
      launchTurn,
      reconcileWorkspace: async (request) => {
        if (launchTurn.mock.calls.length !== 1) {
          return worker.reconcileUnchangedLocalWorkspace(request);
        }
        reconcileEntered.resolve();
        await reconcileRelease.promise;
        if (outcome === "failure") {
          throw transferFailure;
        }
        await writeFile(workspaceFile, "accepted worker content");
        const result = await worker.reconcileUnchangedLocalWorkspace(request);
        if (outcome === "accepted") {
          return result;
        }
        assert(request.source.kind === "local" && request.source.stagedResult);
        await request.source.stagedResult.record(request.source.stagedResult.ref);
        return {
          ...result,
          getAppliedWorkspaceResult: () => ({
            manifestRef: result.manifestRef,
            manifest: { version: 1 as const, baseCommit: null, entries: [] },
            conflictPaths: [conflictPath],
            verifyLocalStable: async () => {},
          }),
        };
      },
    });
    const reconcileActivePlacement = vi.fn(async () => {});
    const provider = worker.createWorkerSessionTurnPlacementProvider({
      placements,
      reconcileActivePlacement,
      environments: worker.workerTurnEnvironments(tunnel, {
        get: () => ({
          ...worker.attachedEnvironment(),
          nodeDeviceId: "paired-node",
          sshEndpoint: null,
        }),
        acknowledgeCredentialDelivery: async () => true,
      }),
    });
    const runLocal = vi.fn();
    const execute = (params: typeof input) =>
      provider.executeTurn({ ...sessionTarget, runId: params.runId }, params, runLocal);
    const first = execute(input);
    void first.catch(() => {});
    let followup: ReturnType<typeof provider.executeTurn> | undefined;
    try {
      await withinTest(reconcileEntered.promise, signal);
      expect(await withinTest(first, signal)).toMatchObject({
        payloads: [{ text: "Worker reply" }],
      });
      const firstClaim = launchTurn.mock.calls[0]?.[0].turnClaim;
      assert(firstClaim);
      expect(placements.validateWorkspaceResultClaim(firstClaim)).toBe(true);
      expect((await placements.listPendingWorkspaceResultsAsync())[0]?.claimId).toBe(
        firstClaim.claimId,
      );
      const before = await worker.openSessionManager();
      assert(terminalId);
      expect(before.getEntry(terminalId)).toMatchObject({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Worker reply" }] },
      });
      expect(before.getLeafId()).toBe(terminalId);
      if (outcome === "accepted") {
        followup = execute(followupInput);
        void followup.catch(() => {});
        expect(launchTurn).toHaveBeenCalledOnce();
        expect(await readFile(workspaceFile, "utf8")).toBe("before reconciliation");
      }
      reconcileRelease.resolve();
      if (followup) {
        expect(await withinTest(followup, signal)).toMatchObject({
          payloads: [{ text: "Follow-up reply" }],
        });
      }
      await withinTest(waitForSessionRunEnd(SESSION_ID, null), signal);
      const pending = await placements.listPendingWorkspaceResultsAsync();
      if (outcome === "failure") {
        expect(reconcileActivePlacement).toHaveBeenCalledOnce();
        expect(pending).toEqual([
          expect.objectContaining({ recoveryRequestedAtMs: expect.any(Number) }),
        ]);
      } else {
        expect(pending).toEqual([]);
        expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
      }
      if (outcome !== "accepted") {
        const conflict = outcome === "conflict";
        const entries = (await worker.openSessionManager()).getBranch();
        const notice = entries.findIndex(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType ===
              (conflict
                ? WORKSPACE_CONFLICT_TRANSCRIPT_TYPE
                : WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE),
        );
        expect(notice).toBeGreaterThan(entries.findIndex((entry) => entry.id === terminalId));
        expect(entries[notice]).toMatchObject({
          display: true,
          content: expect.stringContaining(conflict ? conflictPath : transferFailure.message),
        });
        if (conflict) {
          expect(entries[notice]).toMatchObject({
            details: {
              paths: [conflictPath],
              stagedResultRef: expect.stringMatching(/^refs\/openclaw\/worker-results\//),
            },
          });
          expect(placements.get(SESSION_ID)?.workspaceResultConflict?.paths).toEqual([
            conflictPath,
          ]);
        }
      }
      expect(runLocal).not.toHaveBeenCalled();
    } finally {
      reconcileRelease.resolve();
      await Promise.allSettled([first, followup]);
      await waitForSessionRunEnd(SESSION_ID, null);
      input.preparedRunAdmission.close();
      followupInput.preparedRunAdmission.close();
    }
  },
);
