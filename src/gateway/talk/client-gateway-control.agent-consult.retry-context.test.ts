import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { testing as embeddedRunsTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { checkClientVoiceToolConfirmationPolicy } from "../../talk/client-voice-confirmation.js";
import {
  noteClientVoiceConfirmationUtteranceForTest as noteClientVoiceConfirmationUtterance,
  resetClientVoiceConfirmationStateForTest,
} from "../../talk/client-voice-confirmation.test-support.js";

const { config, coreParams, mocks } = await vi.hoisted(
  () => import("./client-gateway-control.agent-consult.test-support.js"),
);

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
vi.mock("../../talk/agent-run-control.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../talk/agent-run-control.js")>()),
  controlRealtimeVoiceAgentRun: mocks.controlRealtimeVoiceAgentRun,
}));

import { createTalkClientAgentConsultRunner } from "./client-agent-consult.js";
import type { ConsultParams } from "./client-gateway-control.agent-consult.test-support.js";

function createRunner() {
  return createTalkClientAgentConsultRunner({
    config,
    context: { chatAbortControllers: new Map(), logGateway: { warn: vi.fn() } } as never,
    sessionTarget: {
      agentId: "researcher",
      sessionKey: "main",
      canonicalKey: "agent:researcher:talk",
      storePath: "/tmp/sessions",
    },
    authority: { senderIsOwner: false, toolsAllow: ["read"] },
    getVoiceSessionId: () => "voice-session",
    initialItems: [],
    registerRun: vi.fn(),
  });
}

describe("Talk client agent consult retry context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    mocks.createOperationalRunInstanceRef.mockImplementation((runId: string) => ({
      instanceId: `instance:${runId}`,
      runId,
    }));
    mocks.prepareAgentRunAdmission.mockImplementation(
      (params: { operationalRunInstance: OperationalRunInstanceRef }) => ({
        operationalRunInstance: params.operationalRunInstance,
        admit: vi.fn(),
        close: mocks.close,
      }),
    );
    mocks.runEmbeddedAgentCore.mockResolvedValue({ payloads: [] });
  });

  afterEach(() => {
    embeddedRunsTesting.resetActiveEmbeddedRuns();
    resetClientVoiceConfirmationStateForTest();
  });

  it("carries the exact confirmed call into a tool-call consult", async () => {
    const now = Date.now();
    const toolParams = { action: "send", message: "confirmed message" };
    const challenge = checkClientVoiceToolConfirmationPolicy({
      agentId: "researcher",
      voiceSessionId: "voice-session",
      runId: "run-original",
      toolName: "message",
      toolCallId: "blocked-message-call",
      toolParams,
      now,
    });
    if (challenge.allowed) {
      throw new Error("expected challenge");
    }
    const confirmationId = challenge.reason.match(/VOICE_CONFIRMATION_REQUIRED:([^\s]+)/)?.[1];
    noteClientVoiceConfirmationUtterance({
      agentId: "researcher",
      voiceSessionId: "voice-session",
      text: "yes",
      timestamp: now + 1,
    });
    mocks.consultRealtimeVoiceAgent.mockImplementationOnce(async (params: ConsultParams) => {
      params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 1 });
      await params.agentRuntime.runEmbeddedAgent(coreParams);
      return { text: "done" };
    });
    await createRunner().runArgs({ question: "Confirm", confirmationId });
    expect(mocks.runEmbeddedAgentCore.mock.calls[0]?.[0].extraSystemPrompt).toContain(
      "previously blocked tool call",
    );
    expect(mocks.runEmbeddedAgentCore.mock.calls[0]?.[0].extraSystemPrompt).toContain(
      "blocked-message-call",
    );
  });
});
