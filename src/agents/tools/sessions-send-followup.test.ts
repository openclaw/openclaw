import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayClient } from "../../gateway/server-methods/types.js";
import type { PreparedSessionMutationFacts } from "../../gateway/session-sharing-policy.js";
import { rolePolicyConfig, sharingPolicyClient } from "../../gateway/session-sharing.test-utils.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import {
  readFollowupRequest,
  SessionFollowupCompletion,
} from "../subagents/completion/session-followup-completion.js";
import type { FollowupRequest } from "../subagents/completion/session-followup-completion.types.js";
import { prepareSessionsSendFollowup } from "./sessions-send-followup-custody.js";
import { startSessionsSendFollowup } from "./sessions-send-followup.js";
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
  resolveGatewayToolOperatorSelection: () => ({
    operatorAuthority: undefined,
    assertCurrent: () => {},
  }),
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
const storageOwner = { agentId: "main", storePath: "/synthetic/agent.sqlite" };
const storageTarget = (canonicalKey: string) => ({
  ...storageOwner,
  canonicalKey,
});
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
        ...storageTarget(sessionKey),
        storeKey: sessionKey,
        storeKeys: [sessionKey],
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
    storageTarget: storageTarget(sessionKey),
    readCurrent: () => facts.get(sessionKey),
    release: () => {},
  }));
});
afterEach(() => {
  for (const request of active.splice(0)) {
    request.completion?.close();
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
  return facts.get(input.targetSessionKey)!;
}
describe("followup retained session authorization", () => {
  it("retains exact requester incarnation and route when an accepted start loses its ACK", async () => {
    const request = await prepare();
    const completion = SessionFollowupCompletion.bind(request);
    const close = vi.spyOn(completion, "close");
    const callGateway = vi.fn(async () => {
      expect(readFollowupRequest(input.runId, input.targetSessionKey)).toBe(request);
      completion.markAccepted(input.runId);
      request.completion = completion;
      throw new Error("accepted but transport ACK lost");
    });
    const { runId, ...keys } = input;
    const requesterSession = { sessionId: "requester-id", lifecycleRevision: "requester-revision" };
    const replyContext = {
      ...keys,
      callGateway,
      displayKey: input.targetSessionKey,
      replyTimeoutMs: 30000,
      replyMode: "one-way" as const,
      requesterSession,
      requesterDeliveryGeneration: {
        ...storageOwner,
        sessionKey: input.requesterSessionKey,
        ...requesterSession,
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
        admissionConfig: mocks.config(),
        callGateway,
        runId,
        sessionKey: input.targetSessionKey,
        sessionStoreTarget: storageTarget(input.targetSessionKey),
        sendParams: {
          agentId: "main",
          message: "followup",
          sourceReplyDeliveryMode: "message_tool_only",
          inputProvenance: { kind: "inter_session", sourceSessionKey: input.requesterSessionKey },
        },
      },
      replyContext,
    );
    expect(result.start).toMatchObject({
      ok: false,
      result: { details: { sentBeforeError: true } },
    });
    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(startSessionsSendReplyFlow).toHaveBeenCalledTimes(1);
    expect(startSessionsSendReplyFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        ...replyContext,
        completion,
        runId,
        skip: false,
        notifyRequesterOnWaitFailure: true,
      }),
    );
    expect(close).not.toHaveBeenCalled();
    expect(completion.accepted).toBe(true);
    completion.assertExecutionCurrent(input.runId);
  });

  it.each(["access", "archive"] as const)(
    "latches %s revocation after the row recovers",
    async (change) => {
      const changedKey = change === "access" ? "legacy-worker-alias" : input.targetSessionKey;
      const preparedTarget = target().target!;
      preparedTarget.storeKeys.push(changedKey);
      const request = await prepare();
      const assertRevoked = () =>
        expect(() => request.custody.assertCurrent()).toThrow(
          change === "access" ? "revoked" : "archived",
        );
      expect(() => request.custody.assertCurrent()).not.toThrow();
      if (change === "access") {
        target().membership = new Set();
      } else {
        preparedTarget.entry.archivedAt = 2;
      }
      sessionChanges.emit({ sessionKey: changedKey });
      expect(request.custody.signal.aborted).toBe(true);
      assertRevoked();
      if (change === "access") {
        target().membership = new Set(["requester"]);
      } else {
        delete preparedTarget.entry.archivedAt;
      }
      sessionChanges.emit({ sessionKey: changedKey });
      assertRevoked();
    },
  );
  describe("operator admitted without a role actor or profile", () => {
    // Device-token and control-plane connections carry neither, like the backend client
    // that drives a parent turn from the Gateway host.
    const deviceOperator = (): GatewayClient => ({
      connId: "device-operator",
      isDeviceTokenAuth: true,
      connect: {
        minProtocol: 1,
        maxProtocol: 1,
        client: { id: "gateway-client", version: "test", platform: "linux", mode: "backend" },
        role: "operator",
        scopes: ["operator.admin", "operator.read", "operator.write"],
      },
      internal: { authenticatedOperator: true },
    });

    it("retains the Gateway's unidentified-operator policy when roles are off", async () => {
      mocks.config.mockReturnValue({ agents: { entries: { main: {} } } });
      mocks.client.mockReturnValue(deviceOperator());
      const request = await prepare();
      expect(() => request.custody.assertCurrent()).not.toThrow();
      expect(mocks.profile).not.toHaveBeenCalled();
    });

    it("denies the same caller once roles are configured", async () => {
      mocks.client.mockReturnValue(deviceOperator());
      await expect(prepareSessionsSendFollowup(input)).rejects.toThrow("revoked");
      expect(mocks.profile).not.toHaveBeenCalled();
    });
  });

  it("refuses a capture without a retained caller", async () => {
    mocks.client.mockReturnValue(null);
    await expect(prepareSessionsSendFollowup(input)).rejects.toThrow(
      "no retained original caller policy",
    );
  });

  it("refuses missing captured authority rather than selecting a System caller", async () => {
    mocks.capture.mockReturnValue(undefined);
    await expect(prepareSessionsSendFollowup(input)).rejects.toThrow("in-process caller custody");
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
});
