import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import type { SessionsRecoverParams } from "../../../packages/gateway-protocol/src/index.js";
import * as attempts from "../../agents/command/attempt-execution.runtime.js";
import {
  createOriginalIssuerFixture,
  readIssuerFixtureHistory,
} from "../../agents/main-session-recovery/main-session-recovery-original-issuer.test-support.js";
import * as recoveryStore from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { refreshPreparedModelRuntimeSnapshots } from "../../agents/prepared-model-runtime.js";
import {
  loadSessionEntry,
  persistSessionTranscriptTurn,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as continuation from "./session-recovery-continuation.js";
import { sessionRecoverHandlers } from "./sessions-recover.js";

afterEach(async () => {
  await closeSkillsWatchers(true);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("reviews only the original NoGoal hold, launches nothing on acknowledgment, and admits a fresh same-session turn", async () => {
  await withOpenClawTestState({ label: "no-replay-recovery" }, async (state) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    const fixture = await createOriginalIssuerFixture(state, 31, "current");
    fixture.context.isConnectionActive = (id) => id === fixture.client.connId;
    await state.writeConfig(fixture.cfg);
    const target = { agentId: "main", sessionKey: "agent:main:dashboard:no-replay" };
    const sessionId = "original-no-goal-session";
    const runId = "original-unknown-run";
    const issuer = expectDefined(
      fixture.original!.authority.captureRestartRecoveryIssuer?.(),
      "original issuer",
    );
    const repository = await getSessionRepositoryWorkspaceStore().create({
      ...target,
      url: "https://microsoft.ghe.com/acme/original.git",
      requestedRef: "clawson/original-branch",
      runSetupScript: false,
      assertCurrent: fixture.original!.authority.assertCurrent,
    });
    const held = {
      createdActor: { type: "human" as const, source: "profile" as const, id: fixture.profile.id },
      sessionId,
      updatedAt: 100,
      lifecycleRevision: "original-lifecycle",
      repositoryWorkspaceId: repository.workspaceId,
      status: "interrupted" as const,
      abortedLastRun: true,
      restartRecoveryDeliveryRunId: runId,
      restartRecoveryDeliverySourceRunId: runId,
      restartRecoveryRuns: [{ runId, lifecycleGeneration: "old-generation" }],
      mainRestartRecovery: {
        cycleId: "original-cycle",
        revision: 2,
        chargedAttempts: 0,
        pause: {
          reason: "unverifiable-external-effect" as const,
          pausedAtMs: 100,
          toolCallId: "original-call",
          toolName: "exec",
        },
        turnIntent: {
          sessionId,
          sessionKey: target.sessionKey,
          lifecycleRevision: "original-lifecycle",
          repositoryWorkspaceId: repository.workspaceId,
          runId,
          inputId: "original-input",
          idempotencyKey: `${runId}:user`,
          lifecycleGeneration: "old-generation",
          issuer,
        },
      },
    };
    await replaceSessionEntry(target, held);
    const persisted = await persistSessionTranscriptTurn(
      { ...target, sessionId },
      {
        messages: [
          {
            message: {
              role: "user",
              content: "Synthetic build",
              idempotencyKey: `${runId}:user`,
              timestamp: 1,
            },
          },
          {
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "original-call",
                  name: "exec",
                  arguments: { command: "synthetic-build" },
                },
              ],
              timestamp: 2,
            },
          },
          {
            message: {
              role: "toolResult",
              toolCallId: "original-call",
              toolName: "exec",
              isError: true,
              details: { reason: "missing_tool_result" },
              content: [{ type: "text", text: "Synthetic missing result" }],
              timestamp: 3,
            },
          },
        ],
        updateMode: "none",
      },
    );
    held.mainRestartRecovery.turnIntent.inputId = expectDefined(
      persisted.messages[0]?.messageId,
      "original input anchor",
    );
    await replaceSessionEntry(target, held);
    const history = await readIssuerFixtureHistory(target, sessionId);
    const launched = vi.spyOn(continuation, "launchSessionRecoveryContinuation");
    const dispatch = vi.spyOn(fixture.runtime.recovery, "dispatchAgent");
    const attempted = vi.spyOn(attempts, "runAgentAttempt");
    const respond = vi.fn();
    const decision = {
      sessionId,
      lifecycleRevision: "original-lifecycle",
      cycleId: "original-cycle",
      revision: 2,
      pausedAtMs: 100,
      toolCallId: "original-call",
      runId,
    };
    const request = async (params: SessionsRecoverParams) => {
      respond.mockClear();
      await sessionRecoverHandlers["sessions.recover"]!({
        params,
        req: { type: "req", id: "review", method: "sessions.recover" },
        client: fixture.client,
        context: fixture.context,
        respond,
        hasCurrentClientAuthority: fixture.deviceSource.isCurrent,
        isWebchatConnect: () => true,
      });
    };
    const base = { key: target.sessionKey, agentId: target.agentId };
    try {
      await request(base);
      expect(respond).toHaveBeenLastCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
      expect(loadSessionEntry(target)?.mainRestartRecovery?.pause).toEqual(
        held.mainRestartRecovery.pause,
      );
      for (const change of [
        "revision",
        "call",
        "lifecycle",
        "foreign issuer",
        "settling owner",
      ] as const) {
        const altered = structuredClone(held);
        if (change === "foreign issuer") {
          altered.mainRestartRecovery.turnIntent.issuer.profileId = "foreign-profile";
        }
        await replaceSessionEntry(target, altered);
        let admission:
          | Awaited<
              ReturnType<
                typeof import("../../sessions/session-lifecycle-admission.js").beginSessionWorkAdmission
              >
            >
          | undefined;
        if (change === "settling owner") {
          const { beginSessionWorkAdmission } =
            await import("../../sessions/session-lifecycle-admission.js");
          const { resolveGatewaySessionStoreTargetInWorker } =
            await import("../session-utils-store-worker.js");
          const store = await resolveGatewaySessionStoreTargetInWorker({
            cfg: fixture.cfg,
            key: target.sessionKey,
          });
          admission = await beginSessionWorkAdmission({
            scope: store.storePath,
            identities: [target.sessionKey, sessionId],
            assertAllowed: () => {},
          });
        }
        try {
          await request({
            ...base,
            acknowledgeUnknownOutcome: {
              ...decision,
              ...(change === "revision" ? { revision: 1 } : {}),
              ...(change === "call" ? { toolCallId: "stale-call" } : {}),
              ...(change === "lifecycle" ? { lifecycleRevision: "stale-lifecycle" } : {}),
            },
          });
          expect(respond.mock.calls.at(-1)?.[0], change).toBe(false);
          expect(loadSessionEntry(target)?.mainRestartRecovery?.pause).toEqual(
            held.mainRestartRecovery.pause,
          );
        } finally {
          admission?.release();
        }
      }
      await replaceSessionEntry(target, held);
      await request({ ...base, acknowledgeUnknownOutcome: decision });
      expect(respond).toHaveBeenLastCalledWith(
        true,
        {
          ok: true,
          key: target.sessionKey,
          sessionId,
          continuation: { status: "idle" },
        },
        undefined,
      );
      const acknowledged = loadSessionEntry(target);
      await request({ ...base, acknowledgeUnknownOutcome: decision });
      expect(respond.mock.calls.at(-1)?.[0]).toBe(true);
      expect(loadSessionEntry(target)).toEqual(acknowledged);
      expect(await readIssuerFixtureHistory(target, sessionId)).toEqual(history);
      expect(launched).not.toHaveBeenCalled();
      expect(dispatch).not.toHaveBeenCalled();
      expect(attempted).not.toHaveBeenCalled();
      expect(
        (await getSessionRepositoryWorkspaceStore().get(repository.workspaceId))?.requestedRef,
      ).toBe("clawson/original-branch");
      attempted.mockImplementation(async (params) => {
        await params.preparedRunAdmission.admit("embedded");
        await params.userTurnTranscriptRecorder?.persistApproved();
        expect(params.runId).toBe("fresh-next-run");
        expect(params.sessionId).toBe(sessionId);
        return {
          payloads: [{ text: "Fresh turn reply" }],
          meta: {
            durationMs: 0,
            agentMeta: {
              sessionId,
              provider: "fixture",
              model: "allowed",
              usage: { input: 0, output: 0, total: 0 },
            },
            stopReason: "stop",
          },
        };
      });
      await refreshPreparedModelRuntimeSnapshots(fixture.cfg, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      fixture.client.internal!.operatorRunAuthority = fixture.original!.authority;
      const facade = await fixture.runtime.createAgentTurnFacade({ client: fixture.client });
      const fresh = await facade.dispatch({
        ...target,
        sessionId,
        message: "A new harmless turn",
        idempotencyKey: "fresh-next-run",
        deliver: false,
      });
      expect(fresh).toMatchObject({ status: "accepted", runId: "fresh-next-run" });
      await fixture.work.runWhenIdle(() => {});
      expect(attempted).toHaveBeenCalledOnce();
      expect(loadSessionEntry(target)?.sessionId).toBe(sessionId);
      expect(loadSessionEntry(target)?.repositoryWorkspaceId).toBe(repository.workspaceId);
      expect(
        (await getSessionRepositoryWorkspaceStore().get(repository.workspaceId))?.requestedRef,
      ).toBe("clawson/original-branch");
      const afterFresh = await readIssuerFixtureHistory(target, sessionId);
      expect(afterFresh.slice(0, history.length)).toEqual(history);
      expect(afterFresh).toContainEqual(
        expect.objectContaining({ role: "user", content: "A new harmless turn" }),
      );
      // Authority can be revoked while the native recovery commit waits.
      await replaceSessionEntry(target, held);
      const commit = recoveryStore.commitMainSessionRecovery;
      const committing = vi
        .spyOn(recoveryStore, "commitMainSessionRecovery")
        .mockImplementationOnce(async (params) => {
          await setCanonicalUserProfileRole(fixture.profile.id, "revoked");
          return commit(params);
        });
      await request({ ...base, acknowledgeUnknownOutcome: decision });
      expect(respond.mock.calls.at(-1)?.[0]).toBe(false);
      expect(loadSessionEntry(target)?.mainRestartRecovery?.pause).toEqual(
        held.mainRestartRecovery.pause,
      );
      committing.mockRestore();
    } finally {
      await fixture.work.runWhenIdle(() => {});
      fixture.original!.release();
      fixture.deviceSource.release();
      fixture.runtime.close();
    }
  });
});
