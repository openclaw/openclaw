import { vi } from "vitest";
import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import { testing as embeddedRunsTesting } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { createTalkClientAgentConsultRunner } from "./client-agent-consult.js";
import {
  config,
  coreParams,
  mocks,
  type ConsultParams,
} from "./client-gateway-control.agent-consult.test-support.js";
import type { TalkAgentConsultAuthority } from "./client-gateway-control.js";

export function createConsultRunner(
  overrides: Partial<Parameters<typeof createTalkClientAgentConsultRunner>[0]> = {},
) {
  return createTalkClientAgentConsultRunner({
    config,
    context: { chatAbortControllers: new Map(), logGateway: { warn: vi.fn() } } as never,
    sessionTarget: {
      agentId: "researcher",
      sessionKey: "main",
      canonicalKey: "agent:researcher:talk",
      storePath: "/tmp/sessions",
    },
    getVoiceSessionId: () => "voice-session",
    initialItems: [],
    registerRun: vi.fn(async () => ({ release: vi.fn(), isCurrent: () => true })),
    ...overrides,
  });
}

export function createRunner(
  registerRun: NonNullable<
    Parameters<typeof createTalkClientAgentConsultRunner>[0]["registerRun"]
  > = vi.fn(async () => ({ release: vi.fn(), isCurrent: () => true })),
  authority: TalkAgentConsultAuthority = { senderIsOwner: false, toolsAllow: ["read"] },
  options: { ownerConnId?: string } = {},
) {
  return createConsultRunner({ registerRun, authority, ...options });
}

export function resetConsultFixture() {
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
  mocks.controlRealtimeVoiceAgentRun.mockResolvedValue({
    ok: true,
    mode: "steer",
    sessionKey: "agent:researcher:talk",
    sessionId: "session-talk",
    active: true,
    queued: true,
    target: "embedded",
    message: "Steering accepted.",
    speak: true,
    show: true,
    suppress: false,
  });
  mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
    await params.onRunStarted?.({
      runId: "run-talk",
      sessionId: "session-talk",
      timeoutMs: 60_000,
    });
    await params.agentRuntime.runEmbeddedAgent({
      ...coreParams,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    });
    return { text: "done" };
  });
}
