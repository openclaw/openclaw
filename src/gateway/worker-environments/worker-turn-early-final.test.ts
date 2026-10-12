import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { waitForEmbeddedAgentRunEnd } from "../../agents/embedded-agent-runner/runs.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import type { WorkerSessionTurnClaim } from "./placement-record.js";
import type { WorkerTurnTunnelHandle } from "./tunnel-contract.js";
import {
  acknowledgeCompletedWorkerTurn,
  attachedEnvironment,
  cleanupWorkerTurnLauncherTest,
  createWorkerSessionTurnPlacementProvider,
  createWorkerTurnTunnel,
  credential,
  openSessionManager,
  placements,
  reconcileUnchangedLocalWorkspace,
  root,
  seedActivePlacement,
  SESSION_ID,
  sessionTarget,
  setupWorkerTurnLauncherTest,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";
import {
  WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
  WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
} from "./workspace-conflicts.js";

describe("worker final reply before workspace settlement", () => {
  beforeEach(setupWorkerTurnLauncherTest);
  afterEach(cleanupWorkerTurnLauncherTest);

  it.for(["accepted", "conflict", "failure"] as const)(
    "delivers the durable reply before %s reconciliation",
    async (outcome, { signal }) => {
      await seedActivePlacement();
      const input = turn("early-final");
      const followupInput = turn("after-early-final");
      const reconcileEntered = createDeferred();
      const reconcileRelease = createDeferred();
      const followupWaiting = createDeferred();
      const workspaceFile = path.join(root, "accepted.txt");
      await writeFile(workspaceFile, "before reconciliation");
      let firstClaim: WorkerSessionTurnClaim | undefined;
      let terminalId: string | undefined;
      let launchCount = 0;
      let followupWorkspace: string | undefined;
      const launchTurn: WorkerTurnTunnelHandle["launchTurn"] = async (request) => {
        request.onDispatchReady?.();
        launchCount += 1;
        if (launchCount === 1) {
          firstClaim = request.turnClaim;
        } else {
          followupWorkspace = await readFile(workspaceFile, "utf8");
        }
        const leafId = await (
          await openSessionManager()
        ).appendMessageAsync(
          makeAgentAssistantMessage({
            content: [
              { type: "text", text: launchCount === 1 ? "Worker reply" : "Follow-up reply" },
            ],
            timestamp: launchCount,
          }),
        );
        if (launchCount === 1) {
          terminalId = leafId;
        }
        return acknowledgeCompletedWorkerTurn(request.turnClaim, leafId);
      };
      const tunnel = createWorkerTurnTunnel({
        launchTurn,
        reconcileWorkspace: async (request) => {
          if (launchCount !== 1) {
            return reconcileUnchangedLocalWorkspace(request);
          }
          reconcileEntered.resolve();
          await reconcileRelease.promise;
          if (outcome === "failure") {
            throw new Error("synthetic workspace transfer failure");
          }
          await writeFile(workspaceFile, "accepted worker content");
          const result = await reconcileUnchangedLocalWorkspace(request);
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
              conflictPaths: ["conflicted.txt"],
              verifyLocalStable: async () => {},
            }),
          };
        },
      });
      const reconcileActivePlacement = vi.fn(async () => {});
      const provider = createWorkerSessionTurnPlacementProvider({
        placements,
        reconcileActivePlacement,
        environments: {
          ...unusedEnvironments(),
          get: () => ({ ...attachedEnvironment(), nodeDeviceId: "paired-node", sshEndpoint: null }),
          acquireTurnCredential: async () => credential(),
          acknowledgeCredentialDelivery: async () => true,
          startTunnel: async () => tunnel,
        },
      });
      const runLocal = vi.fn();
      const first = provider.executeTurn({ ...sessionTarget, runId: input.runId }, input, runLocal);
      void first.catch(() => {});
      let followup: ReturnType<typeof provider.executeTurn> | undefined;
      try {
        await withinTest(reconcileEntered.promise, signal);
        expect(await withinTest(first, signal)).toMatchObject({
          payloads: [{ text: "Worker reply" }],
        });
        assert(firstClaim);
        expect(placements.validateWorkspaceResultClaim(firstClaim)).toBe(true);
        expect((await placements.listPendingWorkspaceResultsAsync())[0]?.claimId).toBe(
          firstClaim.claimId,
        );
        const before = await openSessionManager();
        assert(terminalId);
        expect(before.getEntry(terminalId)).toMatchObject({
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: "Worker reply" }] },
        });
        expect(before.getLeafId()).toBe(terminalId);
        if (outcome === "accepted") {
          const waitForRelease = placements.waitForTurnClaimRelease.bind(placements);
          vi.spyOn(placements, "waitForTurnClaimRelease").mockImplementation((...args) => {
            followupWaiting.resolve();
            return waitForRelease(...args);
          });
          followup = provider.executeTurn(
            { ...sessionTarget, runId: followupInput.runId },
            followupInput,
            runLocal,
          );
          void followup.catch(() => {});
          await withinTest(followupWaiting.promise, signal);
          expect(launchCount).toBe(1);
          expect(await readFile(workspaceFile, "utf8")).toBe("before reconciliation");
        }
        reconcileRelease.resolve();
        if (followup) {
          expect(await withinTest(followup, signal)).toMatchObject({
            payloads: [{ text: "Follow-up reply" }],
          });
          expect(followupWorkspace).toBe("accepted worker content");
        }
        await withinTest(waitForEmbeddedAgentRunEnd(SESSION_ID, null), signal);
        if (outcome === "failure") {
          expect(reconcileActivePlacement).toHaveBeenCalledOnce();
          const pending = await placements.listPendingWorkspaceResultsAsync();
          expect(pending).toHaveLength(1);
          expect(pending[0]?.recoveryRequestedAtMs).toEqual(expect.any(Number));
          const entries = (await openSessionManager()).getBranch();
          const notice = entries.findIndex(
            (entry) =>
              entry.type === "custom_message" &&
              entry.customType === WORKSPACE_RECOVERY_FAILURE_TRANSCRIPT_TYPE,
          );
          expect(notice).toBeGreaterThan(entries.findIndex((entry) => entry.id === terminalId));
          expect(entries[notice]).toMatchObject({
            display: true,
            content: expect.stringContaining("synthetic workspace transfer failure"),
          });
        } else {
          expect(await placements.listPendingWorkspaceResultsAsync()).toEqual([]);
          expect(placements.get(SESSION_ID)?.turnClaim).toBeNull();
        }
        if (outcome === "conflict") {
          const entries = (await openSessionManager()).getBranch();
          const notice = entries.findIndex(
            (entry) =>
              entry.type === "custom_message" &&
              entry.customType === WORKSPACE_CONFLICT_TRANSCRIPT_TYPE,
          );
          expect(notice).toBeGreaterThan(entries.findIndex((entry) => entry.id === terminalId));
          expect(entries[notice]).toMatchObject({
            display: true,
            content: expect.stringContaining("conflicted.txt"),
            details: {
              paths: ["conflicted.txt"],
              stagedResultRef: expect.stringMatching(/^refs\/openclaw\/worker-results\//),
            },
          });
          expect(placements.get(SESSION_ID)?.workspaceResultConflict?.paths).toEqual([
            "conflicted.txt",
          ]);
        }
        expect(runLocal).not.toHaveBeenCalled();
      } finally {
        reconcileRelease.resolve();
        await Promise.allSettled([first, followup]);
        await waitForEmbeddedAgentRunEnd(SESSION_ID, null);
        input.preparedRunAdmission.close();
        followupInput.preparedRunAdmission.close();
      }
    },
  );
});
