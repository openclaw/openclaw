import { afterEach, expect, it, vi } from "vitest";
import type { SessionsRecoverResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { runEmbeddedAgentEntry } from "../../agents/embedded-agent-runner/run-entry.js";
import { createSubagentRunRecord } from "../../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../../agents/subagents/registry/subagent-registry-persistence.js";
import { resetSubagentRegistryForTests } from "../../agents/subagents/registry/subagent-registry.test-helpers.js";
import { isMainRestartRecoveryCandidate } from "../../config/sessions/restart-recovery-state.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { captureGatewayAuthPolicy } from "../auth-policy.js";
import { resolveGatewayOperatorAccessAuthority } from "../operator-access-policy.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createOperatorClient } from "../server-plugin-in-process-dispatch.test-support.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { loadRealChatDispatch } from "./chat-send-authority.test-support.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

const runtime = vi.hoisted(() => ({ run: vi.fn<typeof runEmbeddedAgentEntry>() }));
// mock-isolation: Fix backend I/O while exercising real chat admission and native custody.
vi.mock("../../agents/embedded-agent-runner/run-entry.js", () => ({
  runEmbeddedAgentEntry: runtime.run,
}));
// mock-isolation: Retained native task waits must never connect to a running Gateway.
vi.mock("../call.js", () => ({
  callGateway: vi.fn(async () => await new Promise<never>(() => {})),
}));

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();
afterEach(() => resetSubagentRegistryForTests({ persist: false }));

it("retains native child custody before a human continuation executes", async ({ signal }) => {
  const sessionKey = "agent:main:dashboard:retained-child";
  await using fixture = await createFixture({ active: false, preserveContent: true, sessionKey });
  const runId = "human-child-continuation";
  const task = "Verify the retained result.";
  const operator = createOperatorClient({
    profileName: "retained-child-followup",
    scopes: fixture.client.connect.scopes ?? [],
  });
  fixture.context.resolveGatewayContext = () => fixture.context;
  fixture.client.authenticatedUserId = operator.authenticatedUserId;
  fixture.client.authenticatedUserProfile = operator.authenticatedUserProfile;
  fixture.client.internal = {
    authenticatedOperator: true,
    operatorAccessAuthority: resolveGatewayOperatorAccessAuthority(
      operator.authenticatedUserProfile!.profileId,
      fixture.context.getRuntimeConfig(),
    ),
  };
  fixture.client.authPolicy = captureGatewayAuthPolicy(fixture.context.getRuntimeConfig(), {
    role: "operator",
    authMethod: "token",
  });
  const entry = {
    sessionId: fixture.scope.sessionId,
    lifecycleRevision: "retained-child-revision",
    updatedAt: Date.now(),
    status: "done" as const,
    spawnedBy: "agent:main:main",
    parentSessionKey: "agent:main:main",
    spawnDepth: 1,
    subagentRole: "leaf" as const,
  };
  Object.assign(fixture.params, { message: task, idempotencyKey: runId });
  await upsertSessionEntryCore(fixture.scope, entry);
  const completed = createSubagentRunRecord({
    runId: "completed-child",
    childSessionKey: sessionKey,
    childAgentId: "main",
    childSessionIdentity: {
      sessionId: entry.sessionId,
      lifecycleRevision: entry.lifecycleRevision,
    },
    requesterAgentId: "main",
    task: "Original completed task",
    expectsCompletionMessage: false,
    startedAt: 1,
    endedAt: 2,
    outcome: { status: "ok" },
  });
  await mutateSubagentRuns([completed.runId], () => ({
    value: undefined,
    postimages: new Map([[completed.runId, completed]]),
  }));
  const entered = createDeferred();
  const release = createDeferred();
  runtime.run.mockImplementation(async (params) => {
    entered.resolve();
    await withinTest(release.promise, signal);
    return {
      outcome: "completed",
      result: { payloads: [{ text: "Retained result verified." }], meta: { durationMs: 0 } },
      provider: params.selection.provider,
      model: params.selection.model,
      attempts: [],
      terminal: { outcome: { status: "ok", reason: "completed" }, metadata: {} },
      settleSessionOverride: async () => {},
    };
  });
  dispatchInboundMessageMock.mockImplementation(await loadRealChatDispatch());
  try {
    const ack = await fixture.send(undefined, {
      expectedProfileId: operator.authenticatedUserProfile!.profileId,
    });
    expect(ack).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ runId, status: "started" }),
      undefined,
      expect.anything(),
    );
    await withinTest(entered.promise, signal);
    expect(
      dispatchInboundMessageMock.mock.calls.at(-1)?.[0].replyOptions?.operatorAuthority
        ?.recoverySnapshot,
    ).toEqual(expect.objectContaining({ profileId: operator.authenticatedUserProfile!.profileId }));
    expect([subagentRuns.get(runId), subagentRuns.get(completed.runId)]).toMatchObject([
      {
        runId,
        childSessionKey: sessionKey,
        task,
        execution: { status: "running" },
        operatorRecoverySource: {
          agentId: "main",
          sessionKey,
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision,
          sourceRunId: runId,
          snapshot: { profileId: operator.authenticatedUserProfile!.profileId },
        },
      },
      {
        task: "Original completed task",
        execution: { status: "terminal", outcome: { status: "ok" } },
      },
    ]);
    expect(isMainRestartRecoveryCandidate(loadSessionEntry(fixture.scope)!, sessionKey)).toBe(
      false,
    );
  } finally {
    release.resolve();
  }
});

it.for([
  ["human", false],
  ["human", true],
  ["native recovery", false],
  ["native recovery", true],
] as const)(
  "starts a %s follow-up in a child interrupted by a Gateway restart (settled: %s)",
  async ([source, settled], { signal }) => {
    const caseId = `${source === "human" ? "human" : "native"}-${settled ? "settled" : "pending"}`;
    const sessionKey = `agent:main:dashboard:interrupted-child-${caseId}`;
    await using fixture = await createFixture({ active: false, preserveContent: true, sessionKey });
    const interruptedRunId = `interrupted-child-run-${caseId}`;
    let runId = `human-child-after-restart-${caseId}`;
    const task = "Continue landing the change.";
    const parent = {
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterStorePath: fixture.scope.storePath,
      completionTarget: "parent" as const,
      completionRequesterSessionId: "interrupted-child-parent",
      completionRequesterLifecycleRevision: "interrupted-child-parent-revision",
      expectsCompletionMessage: true,
    };
    await upsertSessionEntryCore(
      { ...fixture.scope, sessionKey: parent.requesterSessionKey },
      {
        sessionId: parent.completionRequesterSessionId,
        lifecycleRevision: parent.completionRequesterLifecycleRevision,
        updatedAt: Date.now(),
        status: "done",
      },
    );
    // Shutdown leaves this saved claim; main-session recovery never owns a child session.
    const entry = {
      sessionId: fixture.scope.sessionId,
      lifecycleRevision: "interrupted-child-revision",
      updatedAt: Date.now(),
      status: "interrupted" as const,
      abortedLastRun: true,
      endedAt: Date.now(),
      lastRunId: interruptedRunId,
      lastRunError: "Run interrupted by a Gateway restart.",
      spawnedBy: "agent:main:main",
      parentSessionKey: "agent:main:main",
      spawnDepth: 1,
      restartRecoveryDeliveryRunId: interruptedRunId,
      restartRecoveryDeliverySourceRunId: `${interruptedRunId}:user`,
      restartRecoveryDeliveryContext: { channel: "webchat", to: sessionKey },
      restartRecoverySourceIngress: "channel" as const,
    };
    Object.assign(fixture.params, { message: task, idempotencyKey: runId });
    await upsertSessionEntryCore(fixture.scope, entry);
    expect(isMainRestartRecoveryCandidate(entry, sessionKey)).toBe(false);
    const interrupted = createSubagentRunRecord({
      runId: interruptedRunId,
      childSessionKey: sessionKey,
      childAgentId: "main",
      childSessionIdentity: {
        sessionId: entry.sessionId,
        lifecycleRevision: entry.lifecycleRevision,
      },
      ...parent,
      task: "Land the change.",
      delivery: { status: "delivered", deliveredAt: 2 },
      startedAt: 1,
      endedAt: 2,
      outcome: {
        status: "error",
        error: "Subagent execution was interrupted by a Gateway restart.",
      },
    });
    await mutateSubagentRuns([interrupted.runId], () => ({
      value: undefined,
      postimages: new Map([
        [
          interrupted.runId,
          {
            ...interrupted,
            delivery: settled ? interrupted.delivery : { status: "pending" },
            execution: settled
              ? { ...interrupted.execution, interruptionReason: "gateway-restart" }
              : {
                  status: "interrupted",
                  startedAt: 1,
                  interruptedAt: 2,
                  interruptionReason: "gateway-restart",
                },
            ...(settled
              ? { endedReason: "subagent-error", terminalOwner: "interrupted-recovery" }
              : {}),
          },
        ],
      ]),
    }));
    const entered = createDeferred();
    const release = createDeferred();
    runtime.run.mockImplementation(async (params) => {
      entered.resolve();
      await withinTest(release.promise, signal);
      return {
        outcome: "completed",
        result: { payloads: [{ text: "Continuing." }], meta: { durationMs: 0 } },
        provider: params.selection.provider,
        model: params.selection.model,
        attempts: [],
        terminal: { outcome: { status: "ok", reason: "completed" }, metadata: {} },
        settleSessionOverride: async () => {},
      };
    });
    dispatchInboundMessageMock.mockImplementation(await loadRealChatDispatch());
    try {
      if (source === "human") {
        await fixture.send();
      } else {
        const respond = vi.fn<Parameters<typeof handleGatewayRequest>[0]["respond"]>();
        await handleGatewayRequest({
          req: {
            type: "req",
            id: "recover-interrupted-child",
            method: "sessions.recover",
            params: { key: sessionKey },
          },
          client: fixture.client,
          context: fixture.context,
          isWebchatConnect: () => true,
          respond,
        });
        expect(respond).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ continuation: expect.objectContaining({ status: "started" }) }),
          undefined,
        );
        const result = respond.mock.lastCall?.[1] as SessionsRecoverResult;
        if (result.continuation.status !== "started") {
          throw new Error("Expected native child recovery to start");
        }
        runId = result.continuation.runId;
      }
      await withinTest(entered.promise, signal);
      const admitted = loadSessionEntry(fixture.scope);
      expect(admitted).toMatchObject({ abortedLastRun: false });
      expect(admitted?.restartRecoveryDeliveryRunId).not.toBe(interruptedRunId);
      expect(admitted?.restartRecoveryTerminalRunIds).toContain(`${interruptedRunId}:user`);
      expect(subagentRuns.get(runId)).toMatchObject({
        ...parent,
        task: source === "human" ? task : "Land the change.",
        execution: { status: "running" },
      });
    } finally {
      release.resolve();
    }
  },
);
