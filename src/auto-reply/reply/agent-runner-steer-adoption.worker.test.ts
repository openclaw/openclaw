import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createNativeSessionBindingAuthority } from "../../agents/harness/native-session/binding-authority.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { beginRestartRecoveryTerminalDelivery } from "../../config/sessions/restart-recovery-receipt.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { bindSessionControllerSourceTurnId } from "../../sessions/session-controller.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import {
  attachSteerBackend,
  createSteerParams,
} from "./agent-runner-steer-adoption.test-support.js";
import { createQueueTestRun } from "./queue.test-helpers.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import type { FollowupRun } from "./queue/types.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { admitReplyTurn } from "./reply-turn-admission.js";
import * as steeringDelivery from "./steering-delivery-preparation.js";

afterEach(() => {
  testing.resetSessionControllerForTest();
  vi.restoreAllMocks();
});

async function prepareOperation(run: FollowupRun) {
  const { sessionKey, sessionId } = run.run;
  const operation = createTestReplyOperation({ sessionKey, sessionId });
  await operation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(run));
  const fingerprint = await operation.bindToolAuthorityRouteAsync(run.run);
  return { operation, fingerprint };
}

it("adopts active steering through prepared policy without caller-thread SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:active-worker-steering";
    const policyKey = "agent:main:active-worker-policy";
    const config: OpenClawConfig = {
      agents: { defaults: { sandbox: { mode: "all" } }, entries: { main: {} } },
      tools: { sandbox: { tools: { deny: ["exec"] } } },
    };
    setRuntimeConfigSnapshot(config);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: policyKey },
      { sessionId: "policy", updatedAt: 1, sandboxMode: "off" },
    );
    const run = createQueueTestRun({
      prompt: "use the new requirements",
      messageId: "incoming-steer",
      originatingChannel: "webchat",
    });
    Object.assign(run.run, {
      agentId: "main",
      sessionKey: key,
      runtimePolicySessionKey: policyKey,
      senderIsOwner: true,
      config,
    });
    const { operation, fingerprint } = await prepareOperation(run);
    const delivered: string[] = [];
    attachSteerBackend(operation, fingerprint, {
      cancel() {},
      async queueMessage() {
        throw new Error("Expected awaited steering preparation");
      },
      async queueMessageAsync(text, options, preparation) {
        await preparation.prepareCurrent();
        preparation.assertCurrent();
        delivered.push(text);
        options?.onQueueAccepted?.(true);
      },
    });
    const resultState: ReplyOperationRunState = {};
    const followup = vi.fn(async () => {});
    const calls = observeMainThreadSql();
    try {
      await expect(
        runActiveReplySteer(
          createSteerParams(key, run, operation, {
            opts: { runId: "incoming-steer" },
            replyOperationRunState: resultState,
            runFollowup: followup,
          }),
        ),
      ).resolves.toBe("handled");
      expect(delivered).toEqual([run.prompt]);
      expect(resultState.admission).toEqual({ status: "accepted", mode: "steer" });
      expect(followup).not.toHaveBeenCalled();
      calls.expectIdle();
    } finally {
      calls.restore();
      clearSessionQueues([key], getSessionControllerEntryForOperation(operation).target);
      operation.complete();
    }
  });
});

it.for(
  (["initial-injection", "native-backend"] as const).flatMap((phase) =>
    (["terminal-pending", "matching-tombstone", "unrelated-tombstone"] as const).map((change) => ({
      phase,
      change,
    })),
  ),
)(
  "keeps terminal-delivery steering fenced across $phase preparation: $change",
  async ({ phase, change }, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const key = `agent:main:terminal-steering-${phase}-${change}`;
      const messageId = `incoming-terminal-steer-${phase}-${change}`;
      const sessionId = "terminal-steering-session";
      const sourceTurnId = "active-source-turn";
      const storePath = resolveOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
      const scope = { agentId: "main", sessionKey: key, storePath };
      const entry = {
        sessionId,
        updatedAt: 1,
        restartRecoveryDeliveryRunId: "active-run",
        restartRecoveryDeliverySourceRunId: sourceTurnId,
      };
      await upsertSessionEntryCore(scope, entry);
      const run = createQueueTestRun({
        prompt: "keep this incoming request visible",
        messageId,
        originatingChannel: "webchat",
      });
      Object.assign(run.run, {
        agentId: "main",
        sessionId,
        sessionKey: key,
        config: { session: { store: storePath }, agents: { entries: { main: {} } } },
      });
      const { operation, fingerprint } = await prepareOperation(run);
      bindSessionControllerSourceTurnId(operation, sourceTurnId);
      const native = createNativeSessionBindingAuthority(
        [
          {
            read: { ...scope, env: state.env },
            sessionId,
            createSupersededError: () => new Error("native session replaced"),
          },
        ],
        () => operation.abortSignal.throwIfAborted(),
      );
      let preparingNativeBackend = false;
      let held = false;
      const entered = createDeferred();
      const resume = createDeferred();
      const prepareDelivery = steeringDelivery.prepareSteeringDelivery;
      vi.spyOn(steeringDelivery, "prepareSteeringDelivery").mockImplementation((...args) => {
        const prepared = prepareDelivery(...args);
        return {
          ...prepared,
          async prepareCurrent() {
            await prepared.prepareCurrent();
            if (!held && preparingNativeBackend === (phase === "native-backend")) {
              held = true;
              entered.resolve();
              await withinTest(resume.promise, signal);
            }
          },
        };
      });
      const delivered: string[] = [];
      attachSteerBackend(operation, fingerprint, {
        runId: "active-run",
        cancel() {},
        async queueMessage() {
          throw new Error("Expected prepared native steering");
        },
        async queueMessageAsync(text, options, preparation) {
          preparingNativeBackend = true;
          await native.withPreparedCurrent!(() => {
            delivered.push(text);
            options?.onQueueAccepted?.(true);
          }, [preparation]);
        },
      });
      const resultState: ReplyOperationRunState = {};
      const followupDelivered = createDeferred<FollowupRun>();
      const followup = vi.fn(followupDelivered.resolve);
      const pendingFollowups: Promise<void>[] = [];
      const runFollowup = (queued: FollowupRun) => {
        const pending = (async () => {
          const admission = await admitReplyTurn({
            agentId: queued.run.agentId,
            sessionId: queued.run.sessionId,
            sessionKey: key,
            mailboxClaim: queued.controllerInput?.claim,
            kind: "queued_followup",
            resetTriggered: false,
          });
          expect(admission.status).toBe("owned");
          if (admission.status === "owned") {
            try {
              followup(queued);
            } finally {
              admission.operation.complete();
            }
          }
        })();
        pendingFollowups.push(pending);
        return pending;
      };
      const outcome = runActiveReplySteer(
        createSteerParams(key, run, operation, {
          opts: { runId: messageId },
          replyOperationRunState: resultState,
          runFollowup,
          sessionEntry: entry,
          storePath,
        }),
      );
      const settlement = outcome.catch(() => {});
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            entered.promise,
            outcome,
            "Steering preparation did not reach its hold",
          ),
          signal,
        );
        if (change === "terminal-pending") {
          await expect(
            beginRestartRecoveryTerminalDelivery({
              sessionId,
              sessionKey: key,
              sourceTurnId,
              storePath,
              toolCallId: "terminal-delivery-tool",
            }),
          ).resolves.toBe("started");
        } else {
          await upsertSessionEntryCore(scope, {
            restartRecoveryTerminalRunIds: [
              change === "matching-tombstone" ? sourceTurnId : "prior-source-turn",
            ],
            updatedAt: 2,
          });
        }
        expect(operation).toMatchObject({ phase: "running", abortSignal: { aborted: false } });
        resume.resolve();
        await expect(outcome).resolves.toBe("handled");
        expect(operation.phase).toBe("running");
        expect(followup).not.toHaveBeenCalled();
        const queue = getExistingFollowupQueue(key);
        const retained = new Set([...(queue?.items ?? []), ...(queue?.inFlight ?? [])]);
        const steered = change === "unrelated-tombstone";
        expect(delivered).toEqual(steered ? [run.prompt] : []);
        expect(resultState.admission).toEqual({
          status: "accepted",
          mode: steered ? "steer" : "followup",
        });
        expect([...retained]).toEqual(steered ? [] : [run]);
        if (!steered) {
          expect(run.controllerInput).toMatchObject({ phase: "waiting" });
          expect(run.controllerInput?.injection).toBeUndefined();
          operation.complete();
          expect(await withinTest(followupDelivered.promise, signal)).toBe(run);
          expect(followup).toHaveBeenCalledOnce();
        }
      } finally {
        resume.resolve();
        await settlement;
        clearSessionQueues([key], getSessionControllerEntryForOperation(operation).target);
        operation.complete();
        await Promise.allSettled(pendingFollowups);
      }
    });
  },
);
