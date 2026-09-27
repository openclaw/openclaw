import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayClient } from "../../gateway/server-methods/types.js";
import type { PreparedSessionMutationFacts } from "../../gateway/session-sharing-policy.js";
import { rolePolicyConfig, sharingPolicyClient } from "../../gateway/session-sharing.test-utils.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readFollowupRequest } from "../subagents/completion/session-followup-completion.js";
import type {
  FollowupRequest,
  FollowupCompletionOwner,
} from "../subagents/completion/session-followup-completion.types.js";
import {
  prepareSessionsSendFollowup,
  startSessionsSendFollowup,
} from "./sessions-send-followup.js";
import { startSessionsSendReplyFlow } from "./sessions-send-reply-flow.js";
vi.mock("./sessions-send-reply-flow.js", () => ({ startSessionsSendReplyFlow: vi.fn() }));
const mocks = vi.hoisted(() => ({
  config: vi.fn<() => OpenClawConfig>(),
  client: vi.fn<() => GatewayClient | null>(),
  capture: vi.fn(),
  prepare: vi.fn(),
  profile: vi.fn(),
  release: vi.fn(),
}));
vi.mock("../../config/config.js", () => ({ getRuntimeConfig: mocks.config }));
vi.mock("../../gateway/server-plugin-in-process-dispatch.js", () => ({
  captureOperatorToolGatewayContinuationContext: mocks.capture,
}));
vi.mock("../../gateway/session-sharing-preparation.js", () => ({
  prepareSessionMutationFacts: mocks.prepare,
}));
vi.mock("../../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({ client: mocks.client() }),
}));
vi.mock("../../state/user-channel-identity-operations.js", () => ({
  prepareUserProfileRoleAuthority: mocks.profile,
}));
vi.mock("./gateway-caller-context.js", () => ({
  getGatewayToolCallerIdentity: () => ({ agentId: "main", sessionKey: "agent:main:requester" }),
  captureGatewayToolCallerAssertion: () => () => {},
}));
const input = {
  runId: "followup",
  requesterAgentId: "main",
  requesterSessionKey: "agent:main:requester",
  targetAgentId: "main",
  targetSessionKey: "agent:main:worker",
};
const facts = new Map<string, PreparedSessionMutationFacts>();
const active: FollowupRequest[] = [];
beforeEach(() => {
  mocks.config.mockReturnValue({ ...rolePolicyConfig(), agents: { entries: { main: {} } } });
  mocks.client.mockReturnValue(sharingPolicyClient({ user: "requester" }));
  mocks.profile.mockResolvedValue({
    profileId: "requester",
    role: "view",
    aliases: ["requester"],
    isCurrent: () => true,
  });
  mocks.capture.mockResolvedValue({
    assertCurrent: () => {},
    signal: new AbortController().signal,
    release: mocks.release,
    run: (work: () => unknown) => work(),
  });
  facts.clear();
  for (const sessionKey of [input.requesterSessionKey, input.targetSessionKey]) {
    facts.set(sessionKey, {
      membership: new Set(["requester"]),
      target: {
        agentId: "main",
        canonicalKey: sessionKey,
        storeKey: sessionKey,
        storeKeys: [sessionKey],
        storePath: "/synthetic/agent.sqlite",
        entry: {
          sessionId: sessionKey + "-id",
          lifecycleRevision: "one",
          updatedAt: 1,
          visibility: "read-only",
          createdActor: {
            type: "human",
            source: "profile",
            id: sessionKey === input.requesterSessionKey ? "requester" : "other",
          },
        },
      },
    });
  }
  mocks.prepare.mockImplementation(async ({ sessionKey }: { sessionKey: string }) => ({
    storageTarget: {
      agentId: "main",
      canonicalKey: sessionKey,
      storePath: "/synthetic/agent.sqlite",
    },
    readCurrent: () => facts.get(sessionKey),
    release: () => {},
  }));
});
afterEach(() => {
  for (const request of active.splice(0)) {
    request.custody.release();
  }
  vi.clearAllMocks();
});
async function prepare() {
  const request = await prepareSessionsSendFollowup(input);
  if (!request) {
    throw new Error("Expected admitted followup custody");
  }
  active.push(request);
  return request;
}
function target() {
  const value = facts.get(input.targetSessionKey);
  if (!value?.target) {
    throw new Error("Missing fixture target");
  }
  return value;
}
describe("followup retained session authorization", () => {
  it("retains exact requester incarnation and route when an accepted start loses its ACK", async () => {
    const request = await prepare();
    const unexpected = () => {
      throw new Error("Unexpected completion operation during ACK reconciliation");
    };
    const close = vi.fn();
    const completion: FollowupCompletionOwner = {
      request,
      signal: new AbortController().signal,
      accepted: true,
      assertCurrent: unexpected,
      markAccepted: unexpected,
      finishExecution: unexpected,
      ownsExecution: unexpected,
      assertExecutionCurrent: unexpected,
      promoteYield: unexpected,
      successor: unexpected,
      prepareSuccessor: unexpected,
      adopt: unexpected,
      settle: unexpected,
      take: unexpected,
      replaceCohortEntry: unexpected,
      close,
    };
    const callGateway = vi.fn(async () => {
      expect(readFollowupRequest(input.runId, input.targetSessionKey)).toBe(request);
      request.completion = completion;
      throw new Error("accepted but transport ACK lost");
    });
    const replyContext = {
      callGateway,
      targetSessionKey: input.targetSessionKey,
      targetAgentId: "main",
      displayKey: input.targetSessionKey,
      message: "followup",
      announceTimeoutMs: 30000,
      maxPingPongTurns: 0,
      replyMode: "one-way" as const,
      requesterSessionKey: input.requesterSessionKey,
      requesterAgentId: input.requesterAgentId,
      requesterSession: { sessionId: "requester-id", lifecycleRevision: "requester-revision" },
      requesterDeliveryGeneration: {
        agentId: "main",
        storePath: "/synthetic/agent.sqlite",
        sessionKey: input.requesterSessionKey,
        sessionId: "requester-id",
        lifecycleRevision: "requester-revision",
      },
      requesterOrigin: {
        channel: "telegram",
        to: "chat-123",
        accountId: "account-1",
        threadId: "thread-7",
      },
      requesterChannel: "telegram",
    };
    const result = await startSessionsSendFollowup(
      request,
      {
        cfg: mocks.config(),
        callGateway,
        runId: input.runId,
        sessionKey: input.targetSessionKey,
        sessionStoreTarget: {
          agentId: "main",
          canonicalKey: input.targetSessionKey,
          storePath: "/synthetic/agent.sqlite",
        },
        sendParams: {
          agentId: "main",
          message: "followup",
          sourceReplyDeliveryMode: "message_tool_only",
          inputProvenance: { kind: "inter_session", sourceSessionKey: input.requesterSessionKey },
        },
      },
      replyContext,
    );
    expect(result.start.ok).toBe(false);
    if (result.start.ok) {
      throw new Error("Expected failed ACK");
    }
    expect(result.start.result.details).toMatchObject({ sentBeforeError: true });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(startSessionsSendReplyFlow).toHaveBeenCalledTimes(1);
    expect(startSessionsSendReplyFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        ...replyContext,
        completion,
        runId: input.runId,
        skip: false,
        requesterSessionKey: input.requesterSessionKey,
        notifyRequesterOnWaitFailure: true,
      }),
    );
    expect(close).not.toHaveBeenCalled();
  });

  it.each(["canonical", "stored alias"])(
    "latches original-operator access revocation on the %s key",
    async (kind) => {
      const changedKey = kind === "canonical" ? input.targetSessionKey : "legacy-worker-alias";
      const preparedTarget = target().target;
      if (!preparedTarget) {
        throw new Error("Expected target facts");
      }
      preparedTarget.storeKeys.push(changedKey);
      const request = await prepare();
      expect(() => request.custody.assertCurrent()).not.toThrow();
      target().membership = new Set();
      sessionChanges.emit({ sessionKey: changedKey });
      expect(request.custody.signal.aborted).toBe(true);
      target().membership = new Set(["requester"]);
      sessionChanges.emit({ sessionKey: changedKey });
      expect(() => request.custody.assertCurrent()).toThrow("revoked");
    },
  );
  it("rejects an archived or replaced target without using the same key as authority", async () => {
    const request = await prepare();
    const row = target().target;
    if (!row) {
      throw new Error("Missing target");
    }
    row.entry.archivedAt = 2;
    sessionChanges.emit({ sessionKey: input.targetSessionKey });
    expect(() => request.custody.assertCurrent()).toThrow("archived");
    delete row.entry.archivedAt;
    expect(() => request.custody.assertCurrent()).toThrow();
  });
  it("refuses missing captured authority rather than selecting a System caller", async () => {
    mocks.capture.mockReturnValue(undefined);
    await expect(prepareSessionsSendFollowup(input)).rejects.toThrow("in-process caller custody");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
