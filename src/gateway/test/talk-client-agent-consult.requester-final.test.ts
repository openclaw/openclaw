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
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { getCurrentSessionControllerOwner } from "../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";

type ConsultParams = Parameters<
  typeof import("../../talk/agent-consult-runtime.js").consultRealtimeVoiceAgent
>[0];

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

import { createTalkClientAgentConsultRunner } from "../talk/client-agent-consult.js";

const config = {};
const target = {
  agentId: "researcher",
  sessionId: "session-talk",
  sessionKey: "agent:researcher:talk",
  storePath: "/tmp/sessions",
};
const { agentId, sessionId, sessionKey } = target;
const requester = {
  requesterAgentId: agentId,
  requesterSessionKey: sessionKey,
};
const batchRunIds = ["run-child"];
const coreParams = {
  config,
  prompt: "check",
  runId: "run-talk",
  sessionId,
  sessionTarget: target,
  timeoutMs: 1,
  workspaceDir: "/tmp/workspace",
} as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];

function createRunner(isCurrent: () => boolean) {
  return createTalkClientAgentConsultRunner({
    config,
    context: { logGateway: { warn: vi.fn() } } as never,
    sessionTarget: {
      ...target,
      sessionKey: "main",
      canonicalKey: sessionKey,
      assertCurrent: vi.fn(),
    },
    getVoiceSessionId: () => "voice-session",
    initialItems: [],
    registerRun: vi.fn(async () => ({ release: vi.fn(), isCurrent })),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  embeddedRunsTesting.resetActiveEmbeddedRuns();
});
afterEach(() => embeddedRunsTesting.resetActiveEmbeddedRuns());

it.each([
  ["promotes and consumes a yielded final exactly once", true, 1, "late final"],
  ["revokes a promoted final when its run owner is stale", false, 2, "stale final"],
] as const)(
  "Talk requester-final: %s",
  async (_name, current, rearmGeneration, finalAssistantVisibleText) => {
    const instance = { instanceId: `instance:${rearmGeneration}`, runId: "run-talk" };
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
    const runner = createRunner(() => runCurrent);
    runner.runPrompt.adoptCompletionClaims();
    const run = runner.runPrompt({ prompt: "investigate", requesterFinal: { append } });
    await vi.waitFor(() => expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce());
    expect(
      promoteRequesterFinalAttachment({
        ...requester,
        requesterTurnRunId: "run-talk",
        batchRunIds,
        rearmGeneration,
      }),
    ).toBe(true);
    core.resolve({ payloads: [] });
    await expect(run).resolves.toEqual({ text: "done" });
    runCurrent = current;
    expect(runner.runPrompt.claimAppend()).toBe(current);
    finalizeRequesterFinalAttachment({
      ...requester,
      requesterSessionId: sessionId,
      batchRunIds,
      rearmGeneration,
      requesterYieldBatch: true,
      pause: false,
      delivered: true,
      finalAssistantVisibleText,
    });
    expect(append.mock.calls).toEqual(current ? [[finalAssistantVisibleText]] : []);
  },
);
