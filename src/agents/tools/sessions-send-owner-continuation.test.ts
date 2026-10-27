import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForGatewayDispatch } from "../../gateway/server-in-process-dispatch.js";
import type { DispatchGatewayMethodInProcessOptions } from "../../gateway/server-plugin-in-process-dispatch.types.js";
import * as agentRuns from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  bindRequesterOwnerIdentity,
  bindRequesterYieldCronAuthority,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
import { SessionFollowupCompletion } from "../subagents/completion/session-followup-completion.js";
import {
  consumeRequesterCronAuthorityAdmission,
  revokeRequesterCronAuthority,
} from "../subagents/requester-cron-authority.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "./in-process-gateway.js";
import { prepareSessionsSendFollowup } from "./sessions-send-followup-custody.js";
import { startSessionsSendReplyFlow } from "./sessions-send-reply-flow.js";

const fixture = vi.hoisted(() => ({
  assertCustody: vi.fn(),
  release: vi.fn(),
  log: vi.fn(),
  callGateway: vi.fn(),
  wait: vi.fn(),
  gatewayContext: {},
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
// mock-isolation: The fixture owns dispatch and continuation custody without booting a Gateway.
vi.mock("../../gateway/server-plugin-in-process-dispatch.js", () => ({
  getInProcessGatewayRequestContext: () => fixture.gatewayContext,
  dispatchGatewayMethodInProcess: (
    method: string,
    params: unknown,
    options?: DispatchGatewayMethodInProcessOptions,
  ) =>
    fixture.callGateway({
      method,
      params,
      timeoutMs: options?.timeoutMs,
      signal: options?.signal,
      onAccepted: options?.onAccepted,
      assertDispatchCurrent: options?.sessionMutationCommitGuard,
    }),
  captureOperatorToolGatewayContinuationContext: async () => ({
    signal: new AbortController().signal,
    assertCurrent: fixture.assertCustody,
    release: fixture.release,
    run: (work: () => unknown) => work(),
  }),
}));
vi.mock("../../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({
    client: {
      connect: { scopes: ["operator.admin"] },
      internal: { operatorRoleActor: { kind: "system" } },
    },
  }),
}));
vi.mock("../../gateway/session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: async ({ sessionKey }: { sessionKey: string }) => ({
    storageTarget: { agentId: "main", canonicalKey: sessionKey },
    readCurrent: () => ({
      target: {
        canonicalKey: sessionKey,
        storeKey: sessionKey,
        storeKeys: [sessionKey],
        entry: { sessionId: `${sessionKey}-id`, lifecycleRevision: "one" },
      },
    }),
    release: () => {},
  }),
}));
vi.mock("../../gateway/session-sharing-policy.js", () => ({
  authorizePreparedSessionMutation: () => undefined,
}));
vi.mock("../../process/gateway-work-admission.js", () => ({
  runWithGatewayDetachedWorkContinuation: (work: () => unknown) => work(),
}));
vi.mock("../prepared-model-runtime-generation-scope.js", () => ({
  runOutsidePreparedModelRuntimePluginGenerationScope: (work: () => unknown) => work(),
}));
vi.mock("../run-wait.js", () => ({
  waitForAgentRunReply: fixture.wait,
  isTerminalAgentWaitTimeout: () => false,
}));
vi.mock("../../logging/subsystem.js", () => {
  const logger = {
    warn: fixture.log,
    error: fixture.log,
    info: () => {},
    debug: () => {},
    trace: () => {},
    isEnabled: () => false,
    child: () => logger,
  };
  return { createSubsystemLogger: () => logger };
});
vi.mock("./sessions-send-tool.delivery.js", () => ({
  startSessionsSendAgentRun: () => {
    throw new Error("Unexpected child dispatch in result test");
  },
}));
vi.mock("../../sessions/session-participant-recording.js", () => ({
  recordSessionParticipantBestEffort: () => {},
}));

const SESSION = "agent:main:requester";
const CHILD = "agent:main:subagent:worker";
const SESSION_ID = `${SESSION}-id`;
const requester = { agentId: "main", sessionKey: SESSION };
async function prepareCompletion(withRequesterAuthority?: <T>(run: () => T) => T) {
  const request = await prepareSessionsSendFollowup({
    runId: "child-followup",
    requesterTurnRunId: "original",
    requesterAgentId: "main",
    requesterSessionKey: SESSION,
    targetAgentId: "main",
    targetSessionKey: CHILD,
    withRequesterAuthority,
  });
  expect(request).toBeDefined();
  const completion = SessionFollowupCompletion.bind(request!);
  completion.markAccepted(request!.runId);
  const released = createDeferredCore();
  fixture.release.mockImplementation(() => released.resolve());
  return { completion, runId: request!.runId, released };
}
const replyDefaults = {
  skip: false,
  notifyRequesterOnWaitFailure: true,
  targetSessionKey: CHILD,
  targetAgentId: "main",
  displayKey: CHILD,
  requesterSessionKey: SESSION,
  requesterAgentId: "main",
  replyTimeoutMs: 1000,
  replyMode: "one-way",
} satisfies Partial<Parameters<typeof startSessionsSendReplyFlow>[0]>;
function visibleReply(text: string) {
  return {
    status: "ok" as const,
    replyText: text,
    terminalReply: { disposition: "visible" as const, text },
  };
}
async function inRun<T>(
  runId: string,
  work: () => Promise<T>,
  scope?: NonNullable<ReturnType<typeof createCronCreatorAuthorityCapability>>,
) {
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const approvalAuthority = agentRuns.claimAgentRunDelegatedAuthority(operationalRunInstance);
  agentRuns.registerAgentRunContext(runId, { ...requester, sessionId: SESSION_ID });
  try {
    return await withGatewayToolCallerIdentity(
      {
        ...requester,
        operationalRunInstance,
        approvalAuthority,
        receiptAuthority: () => agentRuns.validateAgentRunDelegatedAuthority(approvalAuthority),
      },
      () => (scope ? runWithCronCreatorAuthorityCapability(scope, work) : work()),
    );
  } finally {
    agentRuns.releaseAgentRunDelegatedAuthority(approvalAuthority);
    agentRuns.clearAgentRunContext(runId);
  }
}
afterEach(() => {
  revokeRequesterCronAuthority(SESSION);
  fixture.callGateway.mockReset();
  fixture.wait.mockReset();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("child followup requester continuation", () => {
  it("retains one timed-out inline result through busy parent admission and execution", async () => {
    vi.useFakeTimers();
    const { completion, runId, released } = await inRun("original", () => prepareCompletion());
    const inline = completion.take(10);
    await vi.advanceTimersByTimeAsync(10);
    await expect(inline).resolves.toBeUndefined();

    const entered = createDeferredCore();
    const admit = createDeferredCore();
    const finish = createDeferredCore();
    const callGateway = fixture.callGateway.mockImplementation(async (rpc) => {
      expect(rpc.method).toBe("agent");
      entered.resolve();
      const execution = (async () => {
        await admit.promise;
        rpc.assertDispatchCurrent?.();
        rpc.onAccepted?.({ status: "accepted", runId: rpc.params.idempotencyKey });
        await finish.promise;
        return { status: "ok", runId: rpc.params.idempotencyKey, inputProcessingCompleted: true };
      })();
      return await waitForGatewayDispatch("agent", execution, rpc.timeoutMs, rpc.signal);
    });
    try {
      await startSessionsSendReplyFlow({
        ...replyDefaults,
        completion,
        callGateway: callAgentToolGatewayRequest,
        runId,
        requesterSession: { sessionId: SESSION_ID, lifecycleRevision: "one" },
      });
      await completion.settle(runId, visibleReply("Child result"));
      completion.finishExecution(runId);
      await entered.promise;
      for (const advance of [() => {}, () => admit.resolve()]) {
        advance();
        await vi.advanceTimersByTimeAsync(180_000);
        expect(fixture.release).not.toHaveBeenCalled();
        expect(fixture.log).not.toHaveBeenCalled();
      }
      expect(callGateway).toHaveBeenCalledOnce();
      expect(callGateway.mock.calls[0]?.[0].params).toMatchObject({
        sessionKey: SESSION,
        expectedExistingSessionId: SESSION_ID,
        expectedExistingSessionLifecycleRevision: "one",
        deliver: false,
        sourceReplyDeliveryMode: "message_tool_only",
        message: expect.stringContaining("Child result"),
      });
      finish.resolve();
      await released.promise;
      expect(fixture.log).not.toHaveBeenCalled();
    } finally {
      admit.resolve();
      finish.resolve();
      completion.close();
      await released.promise;
    }
  });

  it.each([
    "success",
    "child error",
    "owner revoked",
    "custody revoked",
    "new user turn",
    "observer closed",
    "receipt replay",
    "requester failed while pending",
  ])("returns the original owner's plugin authority after %s", async (outcome) => {
    let ownerCurrent = true;
    const owner = {
      senderId: "owner",
      channel: "telegram",
      accountId: "test",
      isCurrent: () => ownerCurrent,
    };
    const capability = createCronCreatorAuthorityCapability(
      "original",
      { kind: "unknown" },
      { source: "channel-owner", isCurrent: () => ownerCurrent },
      () => true,
      undefined,
      owner,
    )!;
    const { completion, runId, released } = await inRun(
      "original",
      () => prepareCompletion(bindRequesterYieldCronAuthority("original")),
      capability,
    );
    if (outcome === "owner revoked") {
      ownerCurrent = false;
    }
    if (outcome === "custody revoked") {
      fixture.assertCustody.mockImplementation(() => {
        throw new Error("custody revoked");
      });
    }
    if (outcome === "new user turn") {
      revokeRequesterCronAuthority(SESSION);
    }
    const invoked = vi.fn();
    const callGateway = fixture.callGateway;
    fixture.wait.mockResolvedValue(
      outcome === "requester failed while pending"
        ? { status: "error", error: "requester processing failed" }
        : visibleReply("continued"),
    );
    callGateway.mockImplementation(async (rpc) => {
      expect(rpc.method).toBe("agent");
      rpc.assertDispatchCurrent?.();
      const input = rpc.params;
      if (outcome === "receipt replay" && callGateway.mock.calls.length > 1) {
        expect(input).toEqual(callGateway.mock.calls[0]?.[0].params);
        return { runId: input.idempotencyKey, status: "ok", inputProcessingCompleted: true };
      }
      const admission = consumeRequesterCronAuthorityAdmission({
        runId: input.idempotencyKey,
        sessionKey: input.sessionKey,
        sessionId: input.expectedExistingSessionId,
        inputProvenance: input.inputProvenance,
      });
      expect(admission).toBeDefined();
      const scope = createCronCreatorAuthorityCapability(
        admission!.runId,
        admission!.callerOrigin,
        admission!.managementEntitlement,
        admission!.isCurrent,
        undefined,
        admission!.requesterOwner,
      )!;
      admission!.bindRunScope(scope);
      await inRun(
        admission!.runId,
        async () => {
          if (outcome === "observer closed") {
            completion.close();
            expect(fixture.release).not.toHaveBeenCalled();
          }
          const binding = bindRequesterOwnerIdentity({
            runId: admission!.runId,
            ...requester,
            sessionId: SESSION_ID,
          });
          expect(binding?.isCurrent()).toBe(true);
          binding!.assertCurrent();
          invoked();
        },
        scope,
      );
      return outcome === "receipt replay" || outcome === "requester failed while pending"
        ? { runId: admission!.runId, status: "in_flight" }
        : { runId: admission!.runId, status: "ok", inputProcessingCompleted: true };
    });
    await startSessionsSendReplyFlow({
      ...replyDefaults,
      completion,
      callGateway,
      runId,
      reply:
        outcome === "child error"
          ? { status: "error", error: "plugin failed" }
          : visibleReply("ready"),
    });
    await released.promise;
    const rejected = ["owner revoked", "custody revoked", "new user turn"].includes(outcome);
    expect(invoked).toHaveBeenCalledTimes(rejected ? 0 : 1);
    if (outcome === "requester failed while pending") {
      expect(callGateway).toHaveBeenCalledOnce();
      expect(fixture.log).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ error: "requester processing failed" }),
      );
    } else if (rejected) {
      expect(fixture.log).toHaveBeenCalled();
    } else {
      expect(fixture.log).not.toHaveBeenCalled();
    }
    if (outcome === "receipt replay") {
      expect(callGateway).toHaveBeenCalledTimes(2);
      expect(fixture.wait).toHaveBeenCalledWith(
        expect.objectContaining({ runId: callGateway.mock.calls[0]?.[0].params.idempotencyKey }),
      );
    }
    fixture.assertCustody.mockReset();
  });
});
