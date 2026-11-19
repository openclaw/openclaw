import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  clearTestEmbeddedRun as clearActiveEmbeddedRun,
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
  testing as embeddedRunsTesting,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  finalizeRequesterFinalAttachment,
  promoteRequesterFinalAttachment,
} from "../../agents/subagents/requester-final-attachment.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { ensureClientVoiceAgentSessionEntry } from "../../talk/client-voice-session-write.js";
import { createConsultRunner } from "../talk/client-gateway-control.agent-consult-fixture.test-support.js";
import {
  coreParams,
  type ConsultParams,
} from "../talk/client-gateway-control.agent-consult.test-support.js";
import { useRelayFixtures } from "../talk/relay/fixture.test-support.js";
import { registerTalkRealtimeRelayAgentRun } from "../talk/relay/operations.js";

const mocks = vi.hoisted(() => ({
  createOperationalRunInstanceRef: vi.fn<() => OperationalRunInstanceRef>(),
  prepareAgentRunAdmission: vi.fn(
    (params: { operationalRunInstance: OperationalRunInstanceRef }) => ({
      operationalRunInstance: params.operationalRunInstance,
      admit: vi.fn(),
      close: vi.fn(),
    }),
  ),
  consultRealtimeVoiceAgent: vi.fn(async (params: ConsultParams) => {
    await params.onRunStarted?.({
      runId: "run-talk",
      sessionId: "session-talk",
      timeoutMs: 60_000,
    });
    await params.agentRuntime.runEmbeddedAgent(coreParams);
    return { text: "done" };
  }),
  runEmbeddedAgentCore: vi.fn(),
}));

// mock-isolation: controlled admission refs so requester-final claims are asserted deterministically.
vi.mock("../../agents/admitted-run-context.js", () => ({
  closeAdmittedRunDelegatedAuthority: vi.fn(),
  createOperationalRunInstanceRef: mocks.createOperationalRunInstanceRef,
  prepareAgentRunAdmission: mocks.prepareAgentRunAdmission,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgentCore,
}));
// mock-isolation: command-owner stand-in; the suite exercises Talk's requester-final completion claims.
vi.mock("../../agents/agent-command.js", async () => {
  const { createTalkCommandOwnerStandIn } =
    await import("../talk/client-agent-runtime.command-owner.test-support.js");
  return {
    agentCommandFromGatewayIngress: createTalkCommandOwnerStandIn({
      run: (params) => mocks.runEmbeddedAgentCore(params),
      prepareAdmission: (params) =>
        mocks.prepareAgentRunAdmission(
          params as { operationalRunInstance: OperationalRunInstanceRef },
        ),
    }),
  };
});
vi.mock("../../talk/agent-consult-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../talk/agent-consult-runtime.js")>()),
  consultRealtimeVoiceAgentInSessionRuntime: mocks.consultRealtimeVoiceAgent,
}));

const agentId = "researcher";
const sessionId = "session-talk";
const sessionKey = "agent:researcher:talk";

beforeEach(() => {
  vi.clearAllMocks();
  embeddedRunsTesting.resetActiveEmbeddedRuns();
});
afterEach(() => embeddedRunsTesting.resetActiveEmbeddedRuns());

it.each([
  [true, false],
  [false, false],
  [true, true],
  [false, true],
])(
  "Talk requester-final: preserves a promoted final only for a current owner (%s, yielded=%s)",
  async (current, yielded) => {
    const batch = {
      requesterAgentId: agentId,
      requesterSessionKey: sessionKey,
      batchRunIds: ["run-child"],
      rearmGeneration: current ? 1 : 2,
    };
    const finalAssistantVisibleText = current ? "late final" : "stale final";
    const instance = { instanceId: `instance:${batch.rearmGeneration}`, runId: "run-talk" };
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(instance);
    const core = createDeferredCore<{
      payloads: never[];
      meta: { durationMs: number; yielded?: true };
    }>();
    mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params: ConsultParams) => {
      await params.onRunStarted?.({ runId: "run-talk", sessionId, timeoutMs: 60_000 });
      await params.agentRuntime.runEmbeddedAgent(coreParams);
      return yielded ? { text: "yield acknowledgement", yielded: true } : { text: "done" };
    });
    if (current) {
      const handle = createEmbeddedRunHandle({ runId: "run-talk" });
      mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
        await withGatewayToolCallerIdentity(
          {
            agentId,
            sessionKey,
            operationalRunInstance: instance,
            embeddedRunToolAuthorityBinding: () => ({
              acceptsRequesterOrigin: () => false,
              source: "attempt",
              project: () => "authority",
              projectAsync: async () => "authority",
              assertRegistrationActive: () => {},
              assertActive: () => {},
            }),
          },
          () => {
            const operation = getCurrentSessionControllerOwner();
            if (!operation) {
              throw new Error("Talk consult has no controller-owned turn");
            }
            setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, agentId, operation);
          },
        );
        try {
          return await core.promise;
        } finally {
          clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        }
      });
    } else {
      mocks.runEmbeddedAgentCore.mockReturnValueOnce(core.promise);
    }
    let runCurrent = true;
    const append = vi.fn(() => true);
    const runner = createConsultRunner({
      context: { logGateway: { warn: vi.fn() } } as never,
      registerRun: vi.fn(async () => ({ release: vi.fn(), isCurrent: () => runCurrent })),
    });
    runner.runPrompt.adoptCompletionClaims();
    const run = runner.runPrompt({ prompt: "investigate", requesterFinal: { append } });
    await vi.waitFor(() => expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce());
    expect(promoteRequesterFinalAttachment({ ...batch, requesterTurnRunId: "run-talk" })).toBe(
      true,
    );
    core.resolve({
      payloads: [],
      meta: { durationMs: 0, ...(yielded ? { yielded: true as const } : {}) },
    });
    await expect(run).resolves.toEqual(
      yielded ? { text: "yield acknowledgement", yielded: true } : { text: "done" },
    );
    runCurrent = current;
    expect(runner.runPrompt.claimAppend()).toBe(current);
    expect(runner.runPrompt.claimAppend()).toBe(false);
    finalizeRequesterFinalAttachment({
      ...batch,
      requesterSessionId: sessionId,
      requesterYieldBatch: true,
      pause: false,
      delivered: true,
      finalAssistantVisibleText,
    });
    expect(append.mock.calls).toEqual(current ? [[finalAssistantVisibleText]] : []);
  },
);

it.each([
  [true, true],
  [true, false],
  [false, true],
  [false, false],
])(
  "claims command speech after committed successor (current=%s, source=%s)",
  async (current, withSource) => {
    const instance = { instanceId: "successor-instance", runId: "run-talk" };
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(instance);
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async (params) => {
      const operation = getCurrentSessionControllerOwner();
      expect(operation).toBeDefined();
      operation?.updateSessionId("session-successor");
      params.onSessionIdChanged?.("session-successor");
      return {
        payloads: [{ text: "successor answer" }],
        meta: {
          durationMs: 0,
          terminalReply: { disposition: "visible", text: "successor answer" },
          agentMeta: { terminalReceipt: { runId: "run-talk", sessionId: "session-successor" } },
        },
      };
    });
    let runCurrent = true;
    const runner = createConsultRunner({
      ...(withSource ? { ownerConnId: "talk-successor-owner" } : {}),
      context: { logGateway: { warn: vi.fn() } } as never,
      registerRun: vi.fn(async () => ({ release: vi.fn(), isCurrent: () => runCurrent })),
    });
    runner.runPrompt.adoptCompletionClaims();
    await expect(runner.runPrompt({ prompt: "compact then answer" })).resolves.toEqual({
      text: "done",
    });
    runCurrent = current;
    expect(runner.runPrompt.claimAppend()).toBe(current);
    expect(runner.runPrompt.claimAppend()).toBe(false);
  },
);

const createRealRelay = useRelayFixtures();
it("claims successor speech through the real relay registration composition", async () => {
  await ensureClientVoiceAgentSessionEntry({ agentId, sessionKey });
  const { relay } = await createRealRelay({
    key: sessionKey,
    connId: "real-successor-owner",
    cfg: { agents: { entries: { researcher: {} } } },
  });
  const instance = { instanceId: "real-successor-instance", runId: "run-talk" };
  mocks.createOperationalRunInstanceRef.mockReturnValueOnce(instance);
  mocks.runEmbeddedAgentCore.mockImplementationOnce(async (params) => {
    getCurrentSessionControllerOwner()?.updateSessionId("session-successor");
    params.onSessionIdChanged?.("session-successor");
    return {
      payloads: [{ text: "answer" }],
      meta: {
        durationMs: 0,
        terminalReply: { disposition: "visible", text: "answer" },
        agentMeta: { terminalReceipt: { runId: "run-talk", sessionId: "session-successor" } },
      },
    };
  });
  mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params) => {
    await params.onRunStarted?.({ runId: "run-talk", sessionId, timeoutMs: 60000 });
    await params.agentRuntime.runEmbeddedAgent({
      ...coreParams,
      sessionTarget: { agentId, sessionKey, sessionId, storePath: relay.sessionTarget.storePath },
    });
    return { text: "done" };
  });
  const runner = createConsultRunner({
    sessionTarget: relay.sessionTarget,
    context: relay.context,
    ownerConnId: relay.connId,
    getVoiceSessionId: () => relay.id,
    registerRun: ({ runId, assertCurrent }) =>
      registerTalkRealtimeRelayAgentRun({
        relaySessionId: relay.id,
        connId: relay.connId,
        sessionKey,
        runId,
        assertCurrent,
      }),
  });
  runner.runPrompt.adoptCompletionClaims();
  await runner.runPrompt({ prompt: "compact then answer" });
  expect(runner.runPrompt.claimAppend()).toBe(true);
  expect(runner.runPrompt.claimAppend()).toBe(false);
});
