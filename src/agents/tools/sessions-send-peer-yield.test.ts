import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getFollowupForCohort,
  readFollowupRequest,
  SessionFollowupCompletion,
} from "../subagents/completion/session-followup-completion.js";
import type { FollowupRequest } from "../subagents/completion/session-followup-completion.types.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import { dispatchSessionsSendFollowup } from "./sessions-send-followup.js";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), dispatch: vi.fn() }));
// mock-isolation: Exercise native peer admission and the real completion/cohort owner without a Gateway.
vi.mock("./sessions-send-followup-custody.js", () => ({
  prepareSessionsSendFollowup: mocks.prepare,
}));
// mock-isolation: Admit the exact request through the real completion owner, without transport.
vi.mock("./sessions-send-tool.delivery.js", () => ({
  trySessionsSendActiveRunDelivery: async () => ({}),
  startSessionsSendAgentRun: mocks.dispatch,
}));
// mock-isolation: Supply one admitted caller without starting an agent run.
vi.mock("./gateway-caller-context.js", () => ({
  captureGatewayToolCallerAssertion: () => () => {},
  getGatewayToolCallerIdentity: () => ({ agentId: "main", sessionKey: "agent:main:requester" }),
}));
// mock-isolation: Select native in-process custody without booting a Gateway.
vi.mock("./in-process-gateway.js", () => ({
  getInProcessGatewayToolContext: () => ({ lifecycleRuntime: {} }),
}));

let completion: SessionFollowupCompletion | undefined;
afterEach(() => {
  completion?.close();
  completion = undefined;
  vi.clearAllMocks();
});

it("returns a native peer's successor result once after its original execution yields", async () => {
  const controller = new AbortController();
  const request: FollowupRequest = {
    runId: "original-peer",
    requesterAgentId: "main",
    requesterSessionKey: "agent:main:requester",
    requesterSessionId: "original-requester-session",
    targetAgentId: "worker",
    targetSessionKey: "agent:worker:peer",
    custody: {
      signal: controller.signal,
      assertCurrent: () => controller.signal.throwIfAborted(),
      release: () => {},
      run: (work) => work(),
    },
  };
  mocks.prepare.mockResolvedValue(request);
  mocks.dispatch.mockImplementation(async () => {
    const admitted = readFollowupRequest(request.runId, request.targetSessionKey);
    if (admitted) {
      completion = SessionFollowupCompletion.bind(admitted);
      admitted.completion = completion;
      completion.markAccepted(request.runId);
    }
    return { ok: true, runId: request.runId, targetDisposition: "queued" };
  });
  const config: OpenClawConfig = {};
  const { completion: owner, registryCompletion } = await dispatchSessionsSendFollowup(
    {
      cfg: config,
      admissionConfig: config,
      callGateway: async () => {
        throw new Error("Unexpected transport call");
      },
      runId: request.runId,
      sessionKey: request.targetSessionKey,
      sessionStoreTarget: {
        agentId: "worker",
        canonicalKey: request.targetSessionKey,
        storePath: "/synthetic/worker.sqlite",
      },
      sendParams: {
        agentId: "worker",
        message: "Complete the peer request",
        sourceReplyDeliveryMode: "message_tool_only",
        inputProvenance: { kind: "inter_session", sourceSessionKey: request.requesterSessionKey },
      },
      mode: "followup",
    },
    {
      targetSessionKey: request.targetSessionKey,
      targetAgentId: "worker",
      displayKey: request.targetSessionKey,
      requesterSessionKey: request.requesterSessionKey,
      requesterAgentId: "main",
      requesterSession: { sessionId: request.requesterSessionId },
      replyMode: "peer",
      replyTimeoutMs: 1000,
    },
    {
      message: "Complete the peer request",
      ownChild: false,
      nativeChild: true,
      watch: false,
      requesterSessionKey: request.requesterSessionKey,
      requesterAgentId: "main",
    },
  );
  expect(owner, "ordinary peer admission must retain its completion owner").toBeDefined();
  expect(registryCompletion).toBe(false);
  if (!owner) {
    throw new Error("Peer result has no completion owner");
  }
  const child: SubagentRunRecord = {
    runId: "peer-child",
    childSessionKey: "agent:worker:subagent:child",
    requesterSessionKey: request.targetSessionKey,
    requesterDisplayKey: request.targetSessionKey,
    task: "Nested work",
    cleanup: "keep",
    createdAt: 1,
    execution: { status: "terminal" },
    requesterSettleWake: { status: "pending", attemptCount: 0, rearmGeneration: 1 },
  };
  let returned = false;
  const result = owner.take().then((value) => {
    returned = true;
    return value;
  });
  owner.promoteYield(request.runId, [child], 1);
  expect(await owner.settle(request.runId, { status: "ok", yielded: true })).toEqual({
    kind: "yielded",
  });
  owner.finishExecution(request.runId);
  expect(getFollowupForCohort([child])).toBe(owner);
  expect(returned).toBe(false);
  const successor = owner.successor([child], "peer-successor", () => {});
  await owner.prepareSuccessor(successor);
  owner.adopt(successor);
  owner.markAccepted(successor.runId);
  const final = { status: "ok", replyText: "Original peer result" } as const;
  await owner.settle(successor.runId, final);
  await owner.settle(successor.runId, { status: "ok", replyText: "Duplicate completion" });
  owner.finishExecution(successor.runId);
  await expect(result).resolves.toEqual(final);
  await expect(owner.take()).rejects.toThrow("consumer");
});
