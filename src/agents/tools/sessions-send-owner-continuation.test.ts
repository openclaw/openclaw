import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimAgentRunDelegatedAuthority,
  clearAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import {
  bindRequesterOwnerIdentity,
  bindRequesterYieldCronAuthority,
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../cron-creator-authority-context.js";
import { SessionFollowupCompletion } from "../subagents/completion/session-followup-completion.js";
import type { FollowupRequest } from "../subagents/completion/session-followup-completion.types.js";
import {
  consumeRequesterCronAuthorityAdmission,
  revokeRequesterCronAuthority,
} from "../subagents/requester-cron-authority.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { prepareSessionsSendFollowup } from "./sessions-send-followup.js";
import { startSessionsSendReplyFlow } from "./sessions-send-reply-flow.js";

const fixture = vi.hoisted(() => ({
  assertCustody: vi.fn(),
  release: vi.fn(),
  log: vi.fn(),
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../../gateway/server-plugin-in-process-dispatch.js", () => ({
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
vi.mock("../../config/sessions/transcript-write-context.js", () => ({
  runWithoutOwnedSessionTranscriptWrites: (work: () => unknown) => work(),
}));
vi.mock("../prepared-model-runtime-generation-scope.js", () => ({
  runOutsidePreparedModelRuntimePluginGenerationScope: (work: () => unknown) => work(),
}));
vi.mock("../run-wait.js", () => ({
  waitForAgentRunReply: async () => ({ status: "ok", replyText: "continued" }),
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
async function inRun<T>(runId: string, work: () => Promise<T>) {
  const { operationalRunInstance } = createTestAdmittedRunContext(runId);
  const approvalAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  registerAgentRunContext(runId, {
    agentId: "main",
    sessionKey: SESSION,
    sessionId: SESSION_ID,
  });
  try {
    return await withGatewayToolCallerIdentity(
      {
        agentId: "main",
        sessionKey: SESSION,
        operationalRunInstance,
        approvalAuthority,
        receiptAuthority: () => validateAgentRunDelegatedAuthority(approvalAuthority),
      },
      work,
    );
  } finally {
    releaseAgentRunDelegatedAuthority(approvalAuthority);
    clearAgentRunContext(runId);
  }
}
afterEach(() => {
  revokeRequesterCronAuthority(SESSION);
  vi.clearAllMocks();
});

describe("child followup requester continuation", () => {
  it.each([
    "success",
    "child error",
    "owner revoked",
    "custody revoked",
    "new user turn",
    "observer closed",
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
    const request: FollowupRequest | undefined = await inRun("original", () =>
      runWithCronCreatorAuthorityCapability(capability, async () => {
        const withRequesterAuthority = bindRequesterYieldCronAuthority("original");
        return await prepareSessionsSendFollowup({
          runId: "child-followup",
          requesterTurnRunId: "original",
          withRequesterAuthority,
          requesterAgentId: "main",
          requesterSessionKey: SESSION,
          targetAgentId: "main",
          targetSessionKey: CHILD,
        });
      }),
    );
    expect(request).toBeDefined();
    const completion = SessionFollowupCompletion.bind(request!);
    completion.markAccepted(request!.runId);
    const released = createDeferredCore();
    fixture.release.mockImplementation(() => released.resolve());
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
    const callGateway = vi.fn();
    callGateway.mockImplementation(async (rpc) => {
      if (rpc.method !== "agent") {
        throw new Error("unexpected RPC");
      }
      rpc.assertDispatchCurrent?.();
      const input = rpc.params;
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
      await inRun(admission!.runId, () =>
        runWithCronCreatorAuthorityCapability(scope, async () => {
          if (outcome === "observer closed") {
            completion.close();
            expect(fixture.release).not.toHaveBeenCalled();
          }
          const binding = bindRequesterOwnerIdentity({
            runId: admission!.runId,
            sessionKey: SESSION,
            sessionId: SESSION_ID,
            agentId: "main",
          });
          expect(binding?.isCurrent()).toBe(true);
          binding!.assertCurrent();
          invoked();
        }),
      );
      return { runId: admission!.runId, status: "accepted" };
    });
    startSessionsSendReplyFlow({
      completion,
      callGateway,
      runId: request!.runId,
      skip: false,
      reply:
        outcome === "child error"
          ? { status: "error", error: "plugin failed" }
          : { status: "ok", replyText: "ready" },
      notifyRequesterOnWaitFailure: true,
      targetSessionKey: CHILD,
      targetAgentId: "main",
      displayKey: CHILD,
      requesterSessionKey: SESSION,
      requesterAgentId: "main",
      replyTimeoutMs: 1000,
      replyMode: "one-way",
    });
    await released.promise;
    if (outcome === "success" || outcome === "child error" || outcome === "observer closed") {
      expect(invoked).toHaveBeenCalledTimes(1);
      expect(fixture.log).not.toHaveBeenCalled();
    } else {
      expect(invoked).not.toHaveBeenCalled();
      expect(fixture.log).toHaveBeenCalled();
    }
    fixture.assertCustody.mockReset();
  });
});
