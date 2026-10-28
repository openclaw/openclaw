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
import { createConsultRunner } from "../talk/client-gateway-control.agent-consult-fixture.test-support.js";
import {
  coreParams,
  type ConsultParams,
} from "../talk/client-gateway-control.agent-consult.test-support.js";

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

vi.mock("../../agents/admitted-run-context.js", () => ({
  createOperationalRunInstanceRef: mocks.createOperationalRunInstanceRef,
  prepareAgentRunAdmission: mocks.prepareAgentRunAdmission,
}));
vi.mock("../../agents/embedded-agent.js", () => ({
  runEmbeddedAgent: mocks.runEmbeddedAgentCore,
}));
vi.mock("../../talk/agent-consult-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../talk/agent-consult-runtime.js")>()),
  consultRealtimeVoiceAgent: mocks.consultRealtimeVoiceAgent,
}));

const agentId = "researcher";
const sessionId = "session-talk";
const sessionKey = "agent:researcher:talk";

beforeEach(() => {
  vi.clearAllMocks();
  embeddedRunsTesting.resetActiveEmbeddedRuns();
});
afterEach(() => embeddedRunsTesting.resetActiveEmbeddedRuns());

it.each([true, false])(
  "Talk requester-final: preserves a promoted final only for a current owner (%s)",
  async (current) => {
    const batch = {
      requesterAgentId: agentId,
      requesterSessionKey: sessionKey,
      batchRunIds: ["run-child"],
      rearmGeneration: current ? 1 : 2,
    };
    const finalAssistantVisibleText = current ? "late final" : "stale final";
    const instance = { instanceId: `instance:${batch.rearmGeneration}`, runId: "run-talk" };
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(instance);
    const core = createDeferredCore<{ payloads: never[] }>();
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
    core.resolve({ payloads: [] });
    await expect(run).resolves.toEqual({ text: "done" });
    runCurrent = current;
    expect(runner.runPrompt.claimAppend()).toBe(current);
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
