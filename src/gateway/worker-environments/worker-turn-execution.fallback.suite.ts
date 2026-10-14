import { expect, it, vi } from "vitest";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { isRecordedModelFallbackStop } from "../../agents/model-fallback-stop.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { resolveSessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.transcript-target.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { projectWorkerSessionTurnClaim } from "./placement-record.js";
import { createWorkerTranscriptCommitStore } from "./transcript-commit-ledger.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";
import type { WorkerTunnelHandle } from "./tunnel-contract.js";
import {
  acknowledgeCompletedWorkerTurn,
  createWorkerTurnTunnel,
  reconcileUnchangedLocalWorkspace,
  credential,
  database,
  ENVIRONMENT_ID,
  OWNER_EPOCH,
  SESSION_ID,
  attachedEnvironment,
  createWorkerSessionTurnPlacementProvider,
  placements,
  seedActivePlacement,
  sessionTarget,
  turn,
  unusedEnvironments,
} from "./worker-turn-launcher.test-support.js";

// Registered into the "worker turn execution" describe so the tests share its
// per-test placement/session fixture lifecycle.
export function registerWorkerTurnFallbackTests(): void {
  // A second launch in one test must redispatch through the placement store,
  // which only admits dispatches from local, reclaimed, or failed placements.
  async function reclaimActiveExecutionPlacement() {
    const active = placements.get(SESSION_ID);
    if (active?.state === "failed") {
      // The dispatched turn already moved the placement to its terminal
      // failed state; the redispatch path admits it directly.
      return;
    }
    if (active?.state !== "active") {
      throw new Error(`expected an active placement to reclaim, received ${active?.state}`);
    }
    const draining = await placements.startDrain({
      sessionId: SESSION_ID,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: active.generation,
    });
    const reconciling = await placements.startReconcile({
      sessionId: SESSION_ID,
      environmentId: active.environmentId,
      ownerEpoch: active.activeOwnerEpoch,
      expectedGeneration: draining.generation,
    });
    const reclaimed = await placements.transition({
      sessionId: SESSION_ID,
      from: "reconciling",
      to: "reclaimed",
      expectedGeneration: reconciling.generation,
    });
    if (reclaimed.state !== "reclaimed") {
      throw new Error("expected a reclaimed placement");
    }
  }

  function workerTranscriptCommitIdentity(runId: string): WorkerConnectionIdentity {
    const placement = placements.get(SESSION_ID);
    return {
      environmentId: ENVIRONMENT_ID,
      credentialHash: ["worker", "fixture", "credential"].join("-"),
      bundleHash: "a".repeat(64),
      sessionId: SESSION_ID,
      runId,
      turnClaim: placement ? (projectWorkerSessionTurnClaim(placement) ?? null) : null,
      ownerEpoch: OWNER_EPOCH,
      rpcSetVersion: 1,
      protocolFeatures: ["worker-transcript-commit-v1"],
      credentialExpiresAtMs: Date.now() + 60_000,
    };
  }

  it.each([
    {
      name: "accepts the fallback candidate's first commit on the durable leaf",
      toolActivity: false,
    },
    {
      name: "stops the fallback before launch on committed tool activity",
      toolActivity: true,
    },
  ] as const)("$name through the real commit kernel", async ({ toolActivity }) => {
    await seedActivePlacement();
    const runId = "worker-fallback-transport";
    const input = turn(runId);
    const recorder = createUserTurnTranscriptRecorder({
      target: { ...sessionTarget, sessionEntry: undefined },
      input: { text: input.prompt },
    });
    const ledger = createWorkerTranscriptCommitStore({ database });
    const committer = createWorkerTranscriptCommitter({
      getConfig: () => input.config,
      store: ledger,
    });
    const commit = async (params: {
      seq: number;
      baseLeafId: string;
      messages: Parameters<typeof committer.commit>[0]["request"]["messages"];
    }) =>
      await committer.commit({
        identity: workerTranscriptCommitIdentity(runId),
        sessionTarget: await resolveSessionTranscriptRuntimeTarget({
          agentId: sessionTarget.agentId,
          sessionId: sessionTarget.sessionId,
          sessionKey: sessionTarget.sessionKey,
          storePath: sessionTarget.storePath,
        }),
        assertCurrent: () => undefined,
        request: {
          runEpoch: OWNER_EPOCH,
          seq: params.seq,
          baseLeafId: params.baseLeafId,
          messages: params.messages,
        },
      });

    const primaryFailure = new Error("synthetic primary model failure");
    let leg = 0;
    let admissionEntryId: string | undefined;
    let committedTailLeafId: string | undefined;
    let relaunchedBaseLeafId: string | undefined;
    const launchTurn = vi.fn<NonNullable<WorkerTunnelHandle["launchTurn"]>>(async (request) => {
      leg += 1;
      admissionEntryId = recorder.getAdmissionReceipt()?.entryId;
      request.onDispatchReady?.();
      if (leg === 1) {
        // The primary candidate fails after committing its terminal error
        // assistant on the admission base it was launched with.
        const messages = toolActivity
          ? [
              makeTextToolResult("call-1", "read", "side effect", false, 3),
              makeAgentAssistantMessage({ content: [], stopReason: "error", timestamp: 4 }),
            ]
          : [makeAgentAssistantMessage({ content: [], stopReason: "error", timestamp: 4 })];
        const committed = await commit({
          seq: 1,
          baseLeafId: admissionEntryId!,
          messages,
        });
        expect(committed).toMatchObject({ ok: true });
        if (!committed.ok) {
          throw new Error(committed.reason);
        }
        committedTailLeafId = committed.result.newLeafId;
        throw primaryFailure;
      }
      relaunchedBaseLeafId = request.plan.assignment.transcript.baseLeafId ?? undefined;
      if (toolActivity) {
        // The relaunch must be refused before any new transport work; the
        // recorded stop terminates the candidate chain.
        expect(relaunchedBaseLeafId).toBeUndefined();
        throw primaryFailure;
      }
      // The old-world admission-pinned base is refused by the real kernel once
      // the failed candidate committed past it...
      await expect(
        commit({
          seq: 2,
          baseLeafId: admissionEntryId!,
          messages: [makeAgentAssistantMessage({ content: [], stopReason: "error", timestamp: 5 })],
        }),
      ).resolves.toMatchObject({ ok: false, reason: "stale-base-leaf" });
      // ...while the durable leaf the failed candidate committed is accepted.
      // The refused attempt consumed its sequence, like a real transport.
      const accepted = await commit({
        seq: 3,
        baseLeafId: relaunchedBaseLeafId!,
        messages: [
          makeAgentAssistantMessage({
            content: [{ type: "text", text: "fallback reply" }],
            stopReason: "stop",
            timestamp: 6,
          }),
        ],
      });
      expect(accepted).toMatchObject({ ok: true });
      if (!accepted.ok) {
        throw new Error(accepted.reason);
      }
      return await acknowledgeCompletedWorkerTurn(request.turnClaim, accepted.result.newLeafId);
    });
    const tunnel = createWorkerTurnTunnel({
      launchTurn,
      runWorkspaceCommand: vi.fn(),
      quiesceWorkspace: async () => ({ assertActive: async () => {}, resume: async () => {} }),
      syncWorkspace: vi.fn(),
      reconcileWorkspace: reconcileUnchangedLocalWorkspace,
      stop: vi.fn(async () => {}),
    });
    const provider = createWorkerSessionTurnPlacementProvider({
      placements,
      // The redispatched leg reuses the reseeded active placement verbatim.
      reconcileActivePlacement: async () => {},
      environments: {
        ...unusedEnvironments(),
        get: attachedEnvironment,
        acquireTurnCredential: async () => credential(),
        acknowledgeCredentialDelivery: async () => true,
        startTunnel: async () => tunnel,
      },
    });
    const runLocal = vi.fn();
    const execute = (turnInput: ReturnType<typeof turn>) =>
      provider
        .executeTurn(
          { ...sessionTarget, runId: turnInput.runId },
          { ...turnInput, userTurnTranscriptRecorder: recorder },
          runLocal,
        )
        .then(
          (value) => ({ kind: "resolved" as const, value }),
          (error: unknown) => ({ kind: "rejected" as const, error }),
        );
    const first = execute(input);
    let relaunchInput: ReturnType<typeof turn> | undefined;
    try {
      await expect(first).resolves.toMatchObject({ kind: "rejected", error: primaryFailure });
      expect(leg).toBe(1);
      expect(admissionEntryId).toBeDefined();
      expect(committedTailLeafId).toBeDefined();
      expect(recorder.hasPersisted()).toBe(true);
      await reclaimActiveExecutionPlacement();
      await seedActivePlacement();
      relaunchInput = turn(runId);
      const secondOutcome = await execute(relaunchInput);
      expect(secondOutcome).toMatchObject(
        toolActivity
          ? { kind: "rejected" }
          : { kind: "resolved", value: { payloads: [{ text: "fallback reply" }] } },
      );
      expect(leg).toBe(toolActivity ? 1 : 2);
      if (toolActivity) {
        if (secondOutcome.kind !== "rejected") {
          throw new Error("expected the fallback relaunch to be refused");
        }
        expect(isRecordedModelFallbackStop(secondOutcome.error)).toBe(true);
      } else {
        expect(relaunchedBaseLeafId).toBe(committedTailLeafId);
      }
      expect(runLocal).not.toHaveBeenCalled();
    } finally {
      input.preparedRunAdmission.close();
      relaunchInput?.preparedRunAdmission.close();
    }
  });
}
