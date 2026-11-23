import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { awaitGateBeforeSettlement } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureGatewayDeviceRevocation,
  readGatewayDeviceSourceAuthority,
} from "../../gateway/device-revocation.js";
import { readInProcessSessionDeliveryGeneration } from "../../gateway/in-process-session-delivery.js";
import * as operatorCapture from "../../gateway/operator-run-authority.js";
import * as operatorContinuation from "../../gateway/server-plugin-in-process-dispatch.js";
import { withOperatorToolGatewayAuthority } from "../../gateway/server-plugin-in-process-dispatch.js";
import {
  createContext,
  createOperatorClient,
} from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createDiagnosticToolExecutionLiveness } from "../../infra/diagnostic-tool-execution-liveness.js";
import { drainSystemEvents, peekSystemEvents } from "../../infra/system-events.js";
import { createSessionVisibilityChecker } from "../../plugin-sdk/session-visibility.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { createReplyOperation } from "../../sessions/session-controller.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { createReplyTurnParticipants } from "../../sessions/session-controller.tool-authority.js";
import * as sessionStateEvents from "../../sessions/session-state-events.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../admitted-run-context.js";
import { attachActiveEmbeddedRun, detachActiveEmbeddedRun } from "../embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../embedded-agent-runner/runs.test-support.js";
import { withPreparedEmbeddedRunToolAuthority } from "../harness/tool-authority.runtime.js";
import { createOpenClawTools } from "../openclaw-tools.js";
import "../test-helpers/fast-openclaw-tools-sessions.js";
import {
  readFollowupRequest,
  SessionFollowupCompletion,
} from "../subagents/completion/session-followup-completion.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import * as inProcessGateway from "./in-process-gateway.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import * as sessionsSendExecutor from "./sessions-send-executor.js";
import * as sessionsSendFollowup from "./sessions-send-followup-custody.js";
import { runSessionsSendA2AFlow } from "./sessions-send-tool.a2a.js";
import * as sessionsSendDelivery from "./sessions-send-tool.delivery.js";
import { createSessionsSendTool } from "./sessions-send-tool.js";

vi.mock("./sessions-send-tool.a2a.js", () => ({
  runSessionsSendA2AFlow: vi.fn(async () => {}),
}));

const requesterSessionKey = "agent:main:main";
const targetSessionKey = "agent:main:dashboard:admission-target";
const targetIdentity = {
  agentId: "main",
  sessionKey: targetSessionKey,
  sessionId: "target-session",
};
const runId = "sessions-send-admission-run";
const config = {
  agents: { ownership: "explicit", entries: { main: {} } },
  session: { mainKey: "main", scope: "per-sender" },
  tools: { sessions: { visibility: "all" }, agentToAgent: { enabled: true } },
} satisfies OpenClawConfig;

type GatewayRequest = Parameters<AgentToolGatewayRequestCaller>[0];
function unexpectedRequest(request: GatewayRequest): never {
  throw new Error(`Unexpected Gateway method: ${request.method}`);
}
function mockGateway(
  handle: (request: GatewayRequest) => Promise<unknown> = async (request) =>
    unexpectedRequest(request),
  list = false,
) {
  return vi.fn().mockImplementation((request: GatewayRequest) => {
    if (request.method === "sessions.resolve") {
      return Promise.resolve({ key: targetSessionKey, agentId: "main" });
    }
    if (list && request.method === "sessions.list") {
      return Promise.resolve({
        sessions: [{ key: targetSessionKey, agentId: "main", kind: "direct" }],
      });
    }
    return handle(request);
  });
}
function mockAgentGateway(handle: (request: GatewayRequest) => Promise<unknown>, list = false) {
  return mockGateway(
    async (request) => (request.method === "agent" ? handle(request) : unexpectedRequest(request)),
    list,
  );
}
function operatorFixture(name: string) {
  const context = createContext([], () => config);
  const owner = createOperatorClient({ profileName: `${name}-owner`, scopes: ["operator.write"] });
  const source = captureGatewayDeviceRevocation(
    context,
    { deviceId: `${name}-device`, role: "operator" },
    () => true,
  );
  return { context, owner, source };
}
function createTool(options: Parameters<typeof createSessionsSendTool>[0] = {}) {
  return createSessionsSendTool({
    agentSessionKey: requesterSessionKey,
    config,
    idempotencyKey: runId,
    ...options,
  });
}
function execute(
  tool: ReturnType<typeof createTool>,
  id: string,
  input: Record<string, unknown> = {},
) {
  return tool.execute(id, {
    sessionKey: targetSessionKey,
    message: "Continue the task",
    mode: "followup",
    timeoutSeconds: 0,
    ...input,
  });
}
function putSession(sessionKey: string, entry: Parameters<typeof replaceSessionEntry>[1]) {
  return replaceSessionEntry({ agentId: "main", sessionKey }, entry);
}
function interceptGateway(callGateway: AgentToolGatewayRequestCaller) {
  const gateway = vi
    .spyOn(inProcessGateway, "callAgentToolGatewayRequest")
    .mockImplementation(callGateway);
  const mutation = vi
    .spyOn(sessionsSendDelivery, "callSessionsSendGateway")
    .mockImplementation(callGateway);
  return () => {
    gateway.mockRestore();
    mutation.mockRestore();
  };
}
function requestParams(callGateway: ReturnType<typeof mockGateway>, method: string) {
  return callGateway.mock.calls
    .filter(([request]) => request.method === method)
    .map(([request]) => request.params);
}
function assertPendingAtGate<T>(gate: Promise<void>, pending: Promise<T>, label: string) {
  return awaitGateBeforeSettlement(
    gate,
    pending.then((result) => {
      throw new Error(`${label} settled early: ${JSON.stringify(result)}`);
    }),
    `${label} did not reach its gate`,
  );
}
function inOperatorScope<T>(
  context: ReturnType<typeof createContext>,
  owner: ReturnType<typeof createOperatorClient>,
  source: ReturnType<typeof captureGatewayDeviceRevocation>,
  work: () => Promise<T>,
) {
  return withPluginRuntimeGatewayRequestScope(
    {
      client: owner,
      context,
      isWebchatConnect: () => false,
      hasCurrentClientAuthority: source.isCurrent,
    },
    () =>
      withOperatorToolGatewayAuthority(
        {
          authenticatedUserProfile: owner.authenticatedUserProfile,
          scopes: owner.connect.scopes ?? [],
        },
        work,
      ),
  );
}
async function completeRun(request: GatewayRequest, sessionKey: string, sessionId: string) {
  if (!isRecord(request.params) || typeof request.params.runId !== "string") {
    throw new Error("Expected agent wait run ID");
  }
  await appendTranscriptMessage(
    { agentId: "main", sessionKey, sessionId },
    {
      message: {
        role: "assistant",
        __openclaw: { runId: request.params.runId },
        phase: "final_answer",
        stopReason: "stop",
        content: [{ type: "text", text: "Task complete" }],
      },
    },
  );
  return { status: "ok", terminalReply: { disposition: "visible", text: "Task complete" } };
}

async function trackActualReplyFlow() {
  const { runSessionsSendA2AFlow: runActualFlow } = await vi.importActual<
    typeof import("./sessions-send-tool.a2a.js")
  >("./sessions-send-tool.a2a.js");
  const settled = createDeferredCore();
  vi.mocked(runSessionsSendA2AFlow).mockImplementationOnce((params) =>
    runActualFlow(params).finally(settled.resolve),
  );
  return settled;
}

describe("sessions_send dispatch admission", () => {
  let state: OpenClawTestState;
  let registerWatch: MockInstance<typeof sessionStateEvents.registerSessionStateWatch>;

  beforeEach(async () => {
    state = await createOpenClawTestState({ scenario: "minimal" });
    setRuntimeConfigSnapshot(config);
    setActivePluginRegistry(createSessionConversationTestRegistry());
    resetGatewayWorkAdmission();
    vi.mocked(runSessionsSendA2AFlow).mockReset();
    registerWatch = vi.spyOn(sessionStateEvents, "registerSessionStateWatch");
    for (const [sessionKey, sessionId] of [
      [requesterSessionKey, "requester-session"],
      [targetSessionKey, "target-session"],
    ] as const) {
      await putSession(sessionKey, { sessionId, updatedAt: Date.now() });
    }
  });

  afterEach(async () => {
    await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
    registerWatch.mockRestore();
    resetGatewayWorkAdmission();
    await state.cleanup();
  });

  it.each([{ sessionKey: targetSessionKey }, { label: "synthetic-label" }])(
    "returns a schema-valid result when admission outlives its deadline: %o",
    async (target) => {
      const execution = vi
        .spyOn(sessionsSendExecutor, "executeSessionsSend")
        .mockReturnValue(new Promise(() => {}));
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      try {
        const tool = createTool();
        const pending = tool.execute("admission-deadline", {
          ...target,
          message: "Continue the task",
        });
        await vi.advanceTimersByTimeAsync(30_000);
        const { details } = await pending;
        expect(details).toMatchObject({
          runId,
          status: "error",
          error: expect.stringContaining("the message may have been accepted"),
        });
        expect(details).toEqual(
          "sessionKey" in target
            ? expect.objectContaining(target)
            : expect.not.objectContaining({ sessionKey: expect.anything() }),
        );
        expect(Value.Check(tool.outputSchema!, details)).toBe(true);
      } finally {
        vi.useRealTimers();
        execution.mockRestore();
      }
    },
  );

  it("applies peer preferences to new notifications without revoking accepted events", async () => {
    const callGateway = vi.fn();
    callGateway.mockResolvedValue({ key: targetSessionKey, agentId: "main" });
    const tool = createTool({ callGateway });
    const first = await tool.execute("notify-peer", {
      sessionKey: targetSessionKey,
      message: "accepted notice",
      mode: "notify",
    });
    expect(first.details).toMatchObject({
      status: "queued",
      durability: "process",
      runStarted: false,
    });
    expect(Value.Check(tool.outputSchema!, first.details)).toBe(true);
    if (!isRecord(first.details)) {
      throw new Error("Expected a notification receipt");
    }
    expect(Value.Check(tool.outputSchema!, { ...first.details, durability: "durable" })).toBe(
      false,
    );
    expect(Value.Check(tool.outputSchema!, { ...first.details, runStarted: true })).toBe(false);
    expect(callGateway.mock.calls.some(([request]) => request.method === "agent")).toBe(false);
    await putSession(targetSessionKey, {
      sessionId: "target-session",
      updatedAt: 2,
      communication: { receive: "never" },
    });
    const second = await tool.execute("notify-denied", {
      sessionKey: targetSessionKey,
      message: "unaccepted notice",
      mode: "notify",
    });
    expect(second.details).toMatchObject({ status: "forbidden" });
    const consumed = drainSystemEvents(targetSessionKey);
    expect(consumed).toHaveLength(1);
    expect(consumed[0]).toContain("accepted notice");
    expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
  });

  it.each([
    { right: "parent", ageMinutes: 0 },
    { right: "parent", ageMinutes: 31 },
    { right: "controller", ageMinutes: 31 },
    { right: "scoped", ageMinutes: 31 },
    { right: "bound-parent", ageMinutes: 31 },
  ] as const)(
    "keeps $right notification rights for a $ageMinutes-minute child",
    async ({ right, ageMinutes }) => {
      const parent = "agent:main:dashboard:notify-parent";
      const child = "agent:main:subagent:notify-child";
      const owner =
        right === "parent" || right === "bound-parent"
          ? parent
          : "agent:main:dashboard:other-parent";
      const sessionId = "notify-child-incarnation";
      const cfg: OpenClawConfig = { ...config, tools: { sessions: { visibility: "tree" } } };
      setRuntimeConfigSnapshot(cfg);
      await putSession(parent, { sessionId: "notify-parent", updatedAt: Date.now() });
      await putSession(child, {
        sessionId,
        updatedAt: Date.now() - ageMinutes * 60_000,
        endedAt: Date.now() - ageMinutes * 60_000,
        status: "done",
        parentSessionKey: owner,
        spawnedBy: owner,
        spawnDepth: 1,
      });
      const callGateway = vi.fn();
      callGateway.mockImplementation(async (request: GatewayRequest) => {
        if (request.method === "sessions.resolve") {
          return { key: child, agentId: "main" };
        }
        if (request.method === "sessions.describe") {
          return {
            session: {
              key: child,
              agentId: "main",
              sessionId,
              parentSessionKey: owner,
              spawnedBy: owner,
              childOwnerSessionKeys: [right === "controller" ? parent : owner],
              ...(right === "controller" ? { controlOwnerSessionKey: parent } : {}),
            },
          };
        }
        return unexpectedRequest(request);
      });
      const tool = createTool({
        config: cfg,
        agentSessionKey: parent,
        callGateway,
        ...(right === "bound-parent" ? { expectedTargetSessionId: sessionId } : {}),
      });
      using _ = {
        [Symbol.dispose]: createSessionVisibilityChecker.registerScopedAccessProvider((request) =>
          right === "scoped" &&
          request.requesterSessionKey === parent &&
          request.targetSessionKey === child
            ? { expectedSessionId: sessionId }
            : undefined,
        ),
      };
      const send = () =>
        tool.execute("notify-lineage", {
          sessionKey: child,
          message: "retained child context",
          mode: "notify",
        });
      const result = await send();
      if (right === "parent") {
        expect(result.details).toMatchObject({
          status: "queued",
          durability: "process",
          runStarted: false,
        });
        expect(drainSystemEvents(child)).toEqual([
          expect.stringContaining("retained child context"),
        ]);
      } else {
        expect(result.details).toMatchObject({
          status: "forbidden",
          error: expect.stringContaining(
            "Notifications cannot outlive an exact-session access grant",
          ),
        });
        expect(peekSystemEvents(child)).toEqual([]);
      }
      expect(callGateway.mock.calls.some(([request]) => request.method === "agent")).toBe(false);
      expect(registerWatch).not.toHaveBeenCalled();
    },
  );

  it.each(["send", "receive"] as const)(
    "rechecks an in-place default %s policy publication at final input admission",
    async (direction) => {
      const currentConfig: OpenClawConfig = {
        ...config,
        session: { ...config.session, communication: { send: "always", receive: "always" } },
      };
      setRuntimeConfigSnapshot(currentConfig);
      let admitted = false;
      const callGateway = mockAgentGateway(async (request) => {
        currentConfig.session!.communication![direction] = "never";
        setRuntimeConfigSnapshot(currentConfig);
        request.assertDispatchCurrent?.();
        request.sessionMutationCommitGuard?.();
        admitted = true;
        return { runId, status: "accepted" };
      });
      const result = await execute(
        createTool({ config: currentConfig, callGateway }),
        "revoked-default",
      );
      expect(admitted).toBe(false);
      expect(result.details).toMatchObject({
        status: "error",
        error: expect.stringContaining("communication"),
      });
      expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
    },
  );

  it("bounds default busy-child steering and retains receiver custody", async () => {
    const { context, owner, source } = operatorFixture("steer");
    const accepted = createDeferredCore();
    const receipt = createDeferredCore();
    const sessionFile = "/synthetic/steering-custody/session.jsonl";
    let continuationSignal: AbortSignal | undefined;
    const capture = operatorContinuation.captureOperatorToolGatewayContinuationContext;
    const observeCapture = vi
      .spyOn(operatorContinuation, "captureOperatorToolGatewayContinuationContext")
      .mockImplementation((...args) =>
        capture(...args)?.then((captured) => {
          continuationSignal = captured.signal;
          return captured;
        }),
      );
    let queueReturned = false;
    const selected = createEmbeddedRunHandle({
      runId: "selected-steer-run",
      guarded: true,
      supportsTranscriptCommitWait: true,
      queueMessage: async (_text, options) => {
        options?.onQueueAccepted?.(true);
        accepted.resolve();
        await receipt.promise;
        queueReturned = true;
        options?.onQueueSettled?.();
      },
    });
    const sibling = createEmbeddedRunHandle({ runId: "sibling-steer-run" });
    const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
    const operations = [storePath, `${storePath}.other`].map((storeScope) =>
      createReplyOperation({
        ...targetIdentity,
        resetTriggered: false,
        target: captureSessionTarget({
          storeScope,
          sessionKey: targetSessionKey,
          agentId: "main",
          incarnation: "target-session",
        }),
      }),
    );
    const attach = (
      handle: typeof selected,
      operation: Parameters<typeof attachActiveEmbeddedRun>[5],
      file?: string,
    ) =>
      attachActiveEmbeddedRun("target-session", handle, targetSessionKey, file, "main", operation);
    attach(sibling, operations[1]!);
    const captured = await operatorCapture.prepareGatewayOperatorRunAuthority({
      client: owner,
      context,
      hasCurrentClientAuthority: source.isCurrent,
    });
    if (!captured) {
      throw new Error("Expected the authenticated steering owner");
    }
    const requesterOrigin = {
      sessionKey: requesterSessionKey,
      operatorProfileId: captured.authority.profileId,
    };
    const admission = prepareAgentRunAdmission({
      cfg: config,
      operatorAuthority: captured.authority,
      operationalRunInstance: createOperationalRunInstanceRef("selected-steer-run"),
      facts: {
        agentId: "main",
        runId: "selected-steer-run",
        ingress: { kind: "system", state: "present", boundary: "steering-custody-test" },
      },
    });
    const nativeReady = createDeferredCore();
    const native = admission
      .admit("embedded", "steering-custody-test")
      .then((admittedRunContext) =>
        withPreparedEmbeddedRunToolAuthority(
          { admittedRunContext, replyOperation: operations[0] },
          {
            config,
            ...targetIdentity,
            runId: "selected-steer-run",
            sessionFile,
            workspaceDir: "/synthetic/steering-custody",
            provider: "openai",
            modelId: "gpt-test",
            requesterOrigin,
          },
          undefined,
          async (prepared) => {
            selected.toolAuthorityFingerprint = prepared.toolAuthorityFingerprint;
            attach(selected, prepared.replyOperation, sessionFile);
            nativeReady.resolve();
            await receipt.promise;
          },
        ),
      )
      .finally(() => {
        admission.close();
        captured.release();
      });
    const restoreGateway = interceptGateway(mockGateway(undefined, true));
    await putSession(targetSessionKey, {
      sessionId: "target-session",
      updatedAt: 1,
      spawnedBy: requesterSessionKey,
    });
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const liveness = createDiagnosticToolExecutionLiveness();
    const deadline = Date.now() + 60_000;
    let result: unknown;
    const pending = liveness
      .run(async () => {
        await awaitGateBeforeSettlement(
          nativeReady.promise,
          native,
          "Native owner was not prepared",
        );
        return await inOperatorScope(context, owner, source, () =>
          withGatewayToolCallerIdentity(
            {
              agentId: "main",
              sessionKey: requesterSessionKey,
              requesterOrigin,
              operatorAuthority:
                getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
              gatewayContextResolver: () => context,
              receiptAuthority: () => true,
            },
            () =>
              execute(createTool(), "steer-physical-owner", {
                mode: undefined,
                timeoutSeconds: undefined,
              }),
          ),
        );
      })
      .then((value) => {
        result = value.details;
        return value;
      });
    try {
      await assertPendingAtGate(accepted.promise, pending, "Native acceptance");
      expect(continuationSignal?.aborted).toBe(false);
      expect.soft(liveness.view.deadlineAtMs).toBe(deadline);
      await vi.advanceTimersByTimeAsync(30_000);
      expect.soft(result).toMatchObject({ status: "error", runId, sessionKey: targetSessionKey });
      expect.soft(continuationSignal?.aborted).toBe(false);
      detachActiveEmbeddedRun("target-session", sibling, targetSessionKey);
      await vi.advanceTimersByTimeAsync(0);
      expect(continuationSignal?.aborted).toBe(false);
      detachActiveEmbeddedRun("target-session", selected, targetSessionKey);
      await vi.advanceTimersByTimeAsync(0);
      expect(queueReturned).toBe(false);
      expect(continuationSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
      receipt.resolve();
      try {
        await Promise.all([pending, native]);
      } finally {
        for (const [index, handle] of [selected, sibling].entries()) {
          detachActiveEmbeddedRun("target-session", handle, targetSessionKey);
          operations[index]!.complete();
        }
        restoreGateway();
        observeCapture.mockRestore();
        source.release();
        liveness.close();
      }
    }
  });

  it.each([1, 1200])(
    "preserves a %s-second reply wait after slow admission",
    async (timeoutSeconds) => {
      await putSession(targetSessionKey, {
        sessionId: "target-session",
        updatedAt: 1,
        spawnedBy: requesterSessionKey,
      });
      const { context, owner, source } = operatorFixture("send");
      const finish = createDeferredCore();
      const admitted = createDeferredCore();
      const liveness = createDiagnosticToolExecutionLiveness();
      let result: unknown;
      let completion: SessionFollowupCompletion | undefined;
      const capturing = createDeferredCore();
      const allowCapture = createDeferredCore();
      let invocationStarted = false;
      const capture = operatorCapture.prepareGatewayOperatorRunAuthority;
      const heldCapture = vi
        .spyOn(operatorCapture, "prepareGatewayOperatorRunAuthority")
        .mockImplementation(async (...args) => {
          const captured = await capture(...args);
          if (invocationStarted) {
            capturing.resolve();
            await allowCapture.promise;
          }
          return captured;
        });
      vi.mocked(runSessionsSendA2AFlow).mockImplementationOnce(() => finish.promise);
      const callGateway = mockAgentGateway(async () => {
        const followup = readFollowupRequest(runId, targetSessionKey);
        if (!followup) {
          throw new Error("Expected retained child result custody");
        }
        completion = SessionFollowupCompletion.bind(followup);
        followup.completion = completion;
        completion.markAccepted(runId);
        admitted.resolve();
        return { runId, status: "accepted" };
      }, true);
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      const deadline = Date.now() + 30_000 + timeoutSeconds * 1000;
      const pending = liveness
        .run(() =>
          inOperatorScope(context, owner, source, async () => {
            const participants = createReplyTurnParticipants({
              operatorAuthority:
                getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
            });
            try {
              return await withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey: requesterSessionKey,
                  personalToolParticipants: participants,
                  gatewayContextResolver: () => context,
                  receiptAuthority: () => true,
                },
                () => {
                  invocationStarted = true;
                  return execute(
                    createTool({ agentSessionKey: requesterSessionKey, callGateway }),
                    "send-followup",
                    { timeoutSeconds },
                  );
                },
              );
            } finally {
              participants.close();
            }
          }),
        )
        .then((value) => {
          result = value.details;
          return value;
        });
      try {
        await assertPendingAtGate(capturing.promise, pending, "Reply-source capture");
        expect.soft(liveness.view.deadlineAtMs).toBe(deadline);
        await vi.advanceTimersByTimeAsync(2000);
        expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
        allowCapture.resolve();
        await assertPendingAtGate(admitted.promise, pending, "Child admission");
        if (timeoutSeconds > 1) {
          await vi.advanceTimersByTimeAsync(900_001);
          expect(result).toBeUndefined();
          await vi.advanceTimersByTimeAsync(299_999);
          expect.soft(result).toMatchObject({ status: "accepted", runId });
        }
        await completion!.settle(runId, {
          status: "ok",
          replyText: "Task complete",
          terminalReply: { disposition: "visible", text: "Task complete" },
        });
        completion!.finishExecution(runId);
        await vi.advanceTimersByTimeAsync(0);
        if (timeoutSeconds === 1) {
          expect((await pending).details).toMatchObject({ status: "ok", reply: "Task complete" });
          expect(runSessionsSendA2AFlow).not.toHaveBeenCalled();
        } else {
          expect(runSessionsSendA2AFlow).toHaveBeenCalledWith(
            expect.objectContaining({
              reply: expect.objectContaining({ replyText: "Task complete" }),
            }),
          );
          source.release();
          expect(readGatewayDeviceSourceAuthority(source.isCurrent)?.()).toBe(true);
        }
      } finally {
        vi.useRealTimers();
        allowCapture.resolve();
        finish.resolve();
        completion?.close();
        await pending;
        liveness.close();
        heldCapture.mockRestore();
        source.release();
      }
    },
  );

  it.each([
    { name: "top-level Slack", sourceKey: requesterSessionKey, threadId: undefined },
    {
      name: "legacy DM numeric thread",
      sourceKey: "agent:main:telegram:direct:peer-1",
      threadId: 42,
    },
    {
      name: "current source over fallback",
      sourceKey: requesterSessionKey,
      threadId: "42",
      fallback: true,
    },
    { name: "opaque self-send", sourceKey: "agent:main:direct:identity-linked-person", self: true },
  ])("preserves the admitted $name route after a later inbound turn", async (scenario) => {
    const { sourceKey } = scenario;
    const self = "self" in scenario;
    const fallback = "fallback" in scenario;
    const targetKey = self ? sourceKey : targetSessionKey;
    const slack = scenario.name === "top-level Slack";
    const sourceId = self ? "self-session" : "requester-session";
    const targetId = self ? sourceId : "target-session";
    const originalRoute = { channel: "telegram", accountId: "default", to: "original-recipient" };
    if (slack) {
      originalRoute.channel = "slack";
    }
    const laterRoute = { channel: "telegram", accountId: "other", to: "later-recipient" };
    const entry = { sessionId: sourceId, updatedAt: 1, lifecycleRevision: "original-generation" };
    const settled = await trackActualReplyFlow();
    await putSession(sourceKey, {
      ...entry,
      ...(self ? { delivery: normalizeSessionDeliveryState({ context: originalRoute }) } : {}),
    });
    if (!self) {
      await putSession(targetKey, { sessionId: targetId, updatedAt: 1, spawnedBy: sourceKey });
    }
    let completion: Record<string, unknown> | undefined;
    const callGateway = vi.fn().mockImplementation(async (request: GatewayRequest) => {
      switch (request.method) {
        case "sessions.resolve":
          return { key: targetKey, agentId: "main" };
        case "sessions.list":
          return {
            sessions: [
              {
                key: targetKey,
                agentId: "main",
                ...(self ? { deliveryContext: laterRoute } : { kind: "direct" }),
              },
            ],
          };
        case "agent.wait":
          return completeRun(request, targetKey, targetId);
        case "agent":
          if (!isRecord(request.params)) {
            throw new Error("Expected agent request parameters");
          }
          if (request.params.sessionKey === targetKey) {
            await putSession(sourceKey, {
              ...entry,
              updatedAt: 2,
              delivery: normalizeSessionDeliveryState({ context: laterRoute }),
            });
            return { runId };
          }
          completion = request.params;
          return { runId: "completion-run" };
        case "send":
          if (self) {
            return { messageId: "final-reply" };
          }
      }
      return unexpectedRequest(request);
    });
    const restoreGateway = interceptGateway(callGateway);
    // Cross-session routing has a transport fixture, not a native custody receipt.
    const prepareFollowup = self
      ? undefined
      : vi.spyOn(sessionsSendFollowup, "prepareSessionsSendFollowup").mockResolvedValue(undefined);
    try {
      const tool = createOpenClawTools({
        agentSessionKey: sourceKey,
        sessionId: sourceId,
        agentChannel: originalRoute.channel,
        agentAccountId: originalRoute.accountId,
        agentTo: self ? undefined : fallback ? "stale-recipient" : originalRoute.to,
        agentThreadId: self ? undefined : fallback ? 99 : scenario.threadId,
        currentMessagingTarget: self || fallback ? originalRoute.to : undefined,
        currentChannelId: fallback ? "native-channel-id" : undefined,
        currentThreadTs: fallback ? "42" : slack ? "1793210000.000100" : undefined,
        currentMessageId: slack ? "1793210000.000100" : undefined,
        replyToMode: slack ? "off" : undefined,
        config,
        disableMessageTool: true,
        disablePluginTools: true,
        wrapBeforeToolCallHook: false,
      }).find((candidate) => candidate.name === "sessions_send");
      expect(tool).toBeDefined();
      const result = await execute(tool!, self ? "self-followup" : "send-routed-task", {
        sessionKey: targetKey,
      });
      expect(result.details).toMatchObject({ status: "accepted", delivery: { status: "pending" } });
      await settled.promise;
      if (!self) {
        expect(completion).toMatchObject({
          sessionKey: sourceKey,
          expectedExistingSessionId: sourceId,
          expectedExistingSessionLifecycleRevision: entry.lifecycleRevision,
          ...originalRoute,
          threadId: slack ? undefined : "42",
          deliver: false,
          sourceReplyDeliveryMode: "message_tool_only",
        });
      } else {
        expect.soft(requestParams(callGateway, "agent")).toEqual([
          expect.objectContaining({
            ...originalRoute,
            sessionKey: sourceKey,
            deliver: false,
            sourceReplyDeliveryMode: "message_tool_only",
            inputProvenance: expect.objectContaining({
              kind: "inter_session",
              sourceSessionKey: sourceKey,
            }),
          }),
        ]);
        expect
          .soft(requestParams(callGateway, "send"))
          .toEqual([expect.objectContaining({ ...originalRoute, message: "Task complete" })]);
        const [sendParams] = requestParams(callGateway, "send");
        // The send follows the chat by key; it carries no transcript id to compare later.
        expect(readInProcessSessionDeliveryGeneration(sendParams)).toEqual({
          agentId: "main",
          storePath: expect.any(String),
          sessionKey: sourceKey,
        });
        expect(sendParams).toHaveProperty("idempotencyKey", `sessions-send:${runId}`);
        expect(sendParams).not.toHaveProperty("sessionGeneration");
      }
    } finally {
      prepareFollowup?.mockRestore();
      restoreGateway();
    }
  });

  it.each(["rejected", "pending"] as const)(
    "does not install a watch or start A2A when admission is %s",
    async (admission) => {
      const callGateway = mockGateway(async (request) => {
        switch (request.method) {
          case "agent":
            if (admission === "rejected") {
              throw new Error("Task admission failed before dispatch");
            }
            return { runId, status: "in_flight", admissionPending: true };
          case "agent.wait":
            return { status: "timeout" };
          default:
            return unexpectedRequest(request);
        }
      }, true);
      const result = await execute(createTool({ callGateway }), "send-followup", {
        watch: true,
        timeoutSeconds: 1,
      });
      expect.soft(result.details).toMatchObject({
        status: "error",
        runId,
        sessionKey: targetSessionKey,
        error:
          admission === "rejected"
            ? "Task admission failed before dispatch"
            : expect.stringMatching(/admission|unconfirmed|pending/i),
      });
      if (admission === "pending") {
        expect.soft(result.details).toMatchObject({
          sentBeforeError: true,
          error: expect.stringMatching(/(?:inspect|check).*before.*retry/i),
        });
      } else {
        expect.soft(result.details).not.toHaveProperty("sentBeforeError");
      }
      expect.soft(registerWatch).not.toHaveBeenCalled();
      expect.soft(runSessionsSendA2AFlow).not.toHaveBeenCalled();
      expect.soft(requestParams(callGateway, "agent")).toHaveLength(1);
      expect.soft(requestParams(callGateway, "agent.wait")).toHaveLength(0);
    },
  );
});
