import { afterEach, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getSessionControllerEntryForOperation } from "../../sessions/session-controller.state.js";
import * as controllerState from "../../sessions/session-controller.state.js";
import { testing } from "../../sessions/session-controller.test-support.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import {
  attachSteerBackend,
  createSteerParams,
} from "./agent-runner-steer-adoption.test-support.js";
import { clearSessionQueues } from "./queue/cleanup.js";
import { getExistingFollowupQueue } from "./queue/state.js";
import type { FollowupRun } from "./queue/types.js";
import type { ReplyOperationRunState } from "./reply-operation-run-state.js";
import { createTestReplyOperation } from "./reply-run-registry.test-helpers.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import { createQueueTestRun } from "./reply-tool-authority.test-support.js";

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

function steeringRequester() {
  return createAdmittedRunOperatorAuthority({
    profileId: "steering-requester",
    scopes: ["operator.read", "operator.write"],
    source: {},
    assertCurrent() {},
  });
}

function preparedDelivery(
  delivered: string[],
): Pick<Parameters<typeof attachSteerBackend>[2], "queueMessage" | "queueMessageAsync"> {
  return {
    async queueMessage() {
      throw new Error("Expected awaited steering");
    },
    async queueMessageAsync(text, options, preparation) {
      await preparation.prepareCurrent();
      preparation.assertCurrent();
      delivered.push(text);
      options?.onQueueAccepted?.(true);
    },
  };
}

it("consumes human steering once after the same logical owner recovers its detached backend", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:recovered-worker-steering";
    const run = createQueueTestRun({
      prompt: "use these new human requirements",
      messageId: "recovery-human-input",
      originatingChannel: "webchat",
    });
    Object.assign(run.run, { agentId: "main", sessionKey: key, senderIsOwner: true });
    const { operation, fingerprint } = await prepareOperation(run);
    const oldQueue = vi.fn(async () => {});
    attachSteerBackend(operation, fingerprint, { runId: "old-attempt", queueMessage: oldQueue });
    const oldBackend = getSessionControllerEntryForOperation(operation).attachment?.backend?.handle;
    expect(oldBackend).toBeDefined();
    operation.detachBackend(oldBackend!);
    // Observe the real readiness call without replacing its result or authority.
    const readiness = vi.spyOn(controllerState, "waitForReplyOperationBackend");
    const followup = vi.fn(async () => {});
    const resultState: ReplyOperationRunState = {};
    const delivered: string[] = [];
    const recoveredQueue = vi.fn<
      NonNullable<Parameters<typeof attachSteerBackend>[2]["queueMessageAsync"]>
    >(async (text, options, preparation) => {
      await preparation.prepareCurrent();
      preparation.assertCurrent();
      delivered.push(text);
      options?.onQueueAccepted?.(true);
    });
    const steering = runActiveReplySteer(
      createSteerParams(key, run, operation, {
        opts: { runId: run.messageId },
        replyOperationRunState: resultState,
        runFollowup: followup,
      }),
    );
    try {
      await vi.waitFor(() => expect(readiness).toHaveBeenCalledOnce());
      expect(oldQueue).not.toHaveBeenCalled();
      attachSteerBackend(operation, fingerprint, {
        runId: "recovered-attempt",
        async queueMessage() {
          throw new Error("Expected awaited steering preparation");
        },
        queueMessageAsync: recoveredQueue,
      });
      await expect(steering).resolves.toBe("handled");
      expect(delivered).toEqual([run.prompt]);
      expect(recoveredQueue).toHaveBeenCalledOnce();
      expect(resultState.admission).toEqual({ status: "accepted", mode: "steer" });
      expect(run.controllerInput?.phase).toBe("consumed");
      expect(followup).not.toHaveBeenCalled();
    } finally {
      readiness.mockRestore();
      clearSessionQueues([key], getSessionControllerEntryForOperation(operation).target);
      operation.complete();
      await steering;
    }
  });
});

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
    run.operatorAuthority = steeringRequester();
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
      ...preparedDelivery(delivered),
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

it.for([
  { key: "agent:main:main", incoming: "requester-c", steered: true },
  { key: "agent:main:main", incoming: "requester-d", steered: false },
  { key: "agent:main:dashboard:collaboration", incoming: "requester-d", steered: true },
])(
  "keeps request credit with its tools during steering: $key / $incoming",
  async ({ key, incoming, steered }, { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const config: OpenClawConfig = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(config);
      const original = createQueueTestRun({
        prompt: "original task",
        messageId: "original-request",
        originatingChannel: "discord",
      });
      Object.assign(original.run, {
        agentId: "main",
        sessionKey: key,
        senderIsOwner: false,
        gitContributorProfileId: "requester-c",
        config,
      });
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        { sessionId: original.run.sessionId, updatedAt: 1 },
      );
      const { operation, fingerprint } = await prepareOperation(original);
      const delivered: string[] = [];
      attachSteerBackend(operation, fingerprint, preparedDelivery(delivered));
      const run = createQueueTestRun({
        prompt: "make the requested PR",
        messageId: "incoming-request",
        originatingChannel: "discord",
      });
      run.run = { ...original.run, gitContributorProfileId: incoming };
      const resultState: ReplyOperationRunState = {};
      const followupDelivered = createDeferred<FollowupRun>();
      const followup = vi.fn(async (value: FollowupRun) => {
        followupDelivered.resolve(value);
      });
      try {
        await expect(
          runActiveReplySteer(
            createSteerParams(key, run, operation, {
              opts: { runId: "incoming-request" },
              replyOperationRunState: resultState,
              runFollowup: followup,
            }),
          ),
        ).resolves.toBe("handled");
        expect(delivered).toEqual(steered ? [run.prompt] : []);
        expect(resultState.admission).toEqual({
          status: "accepted",
          mode: steered ? "steer" : "followup",
          ...(!steered ? { reason: "steering-unavailable" } : {}),
        });
        expect(original.run.gitContributorProfileId).toBe("requester-c");
        if (!steered) {
          const queue = getExistingFollowupQueue(key);
          expect(new Set([...(queue?.items ?? []), ...(queue?.inFlight ?? [])])).toContain(run);
          operation.complete();
          expect(
            (await withinTest(followupDelivered.promise, signal)).run.gitContributorProfileId,
          ).toBe("requester-d");
          expect(followup).toHaveBeenCalledOnce();
        }
      } finally {
        clearSessionQueues([key], getSessionControllerEntryForOperation(operation).target);
        operation.complete();
      }
    });
  },
);
