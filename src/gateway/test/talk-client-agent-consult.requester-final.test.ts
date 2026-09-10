import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationalRunInstanceRef } from "../../agents/admitted-run-context.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedRunsTesting,
} from "../../agents/embedded-agent-runner/runs.test-support.js";
import {
  consumeRequesterFinalAttachment,
  promoteRequesterFinalAttachment,
} from "../../agents/subagents/requester-final-attachment.js";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";

type ConsultParams = Parameters<
  typeof import("../../talk/agent-consult-runtime.js").consultRealtimeVoiceAgent
>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  consultRealtimeVoiceAgent: vi.fn(),
  createOperationalRunInstanceRef: vi.fn((runId: string) => ({
    instanceId: `instance:${runId}`,
    runId,
  })),
  prepareAgentRunAdmission: vi.fn(),
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

import { createTalkClientAgentConsultRunner } from "../talk-client-agent-consult.js";

const config = {} as OpenClawConfig;
const coreParams = {
  config,
  prompt: "check",
  runId: "run-talk",
  sessionId: "session-talk",
  sessionTarget: {
    agentId: "researcher",
    sessionId: "session-talk",
    sessionKey: "agent:researcher:talk",
    storePath: "/tmp/sessions",
  },
  timeoutMs: 1,
  workspaceDir: "/tmp/workspace",
} as Parameters<PluginRuntime["agent"]["runEmbeddedAgent"]>[0];

function createRunner(isRunCurrent: (runId: string) => boolean = () => true) {
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
    registerRun: vi.fn(),
    isRunCurrent,
  });
}

describe("Talk requester-final consult ownership", () => {
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
    mocks.consultRealtimeVoiceAgent.mockImplementation(async (params: ConsultParams) => {
      params.onRunStarted?.({ runId: "run-talk", sessionId: "session-talk", timeoutMs: 60_000 });
      await params.agentRuntime.runEmbeddedAgent(coreParams);
      return { text: "done" };
    });
  });

  afterEach(() => {
    embeddedRunsTesting.resetActiveEmbeddedRuns();
  });

  it("promotes and consumes a yielded final exactly once", async () => {
    const core = deferred<{ payloads: never[] }>();
    const handle = createEmbeddedRunHandle({ runId: "run-talk" });
    const operationalRunInstance = {
      instanceId: "instance:yielded-final",
      runId: "run-talk",
    };
    mocks.createOperationalRunInstanceRef.mockReturnValueOnce(operationalRunInstance);
    mocks.runEmbeddedAgentCore.mockImplementationOnce(async () => {
      await withGatewayToolCallerIdentity(
        {
          agentId: "researcher",
          sessionKey: "agent:researcher:talk",
          operationalRunInstance,
          embeddedRunToolAuthorityBinding: () => ({
            source: "attempt",
            project: () => "authority",
            assertActive: () => {},
          }),
        },
        () => setActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk"),
      );
      try {
        return await core.promise;
      } finally {
        clearActiveEmbeddedRun("session-talk", handle, "agent:researcher:talk");
      }
    });
    const append = vi.fn(() => true);
    const runner = createRunner();
    runner.runPrompt.adoptCompletionClaims();

    const run = runner.runPrompt({ prompt: "investigate", requesterFinal: { append } });
    await vi.waitFor(() => expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce());
    expect(
      promoteRequesterFinalAttachment({
        requesterAgentId: "researcher",
        requesterSessionKey: "agent:researcher:talk",
        requesterTurnRunId: "run-talk",
        batchRunIds: ["run-child"],
        rearmGeneration: 1,
      }),
    ).toBe(true);
    core.resolve({ payloads: [] });
    await expect(run).resolves.toEqual({ text: "done" });
    expect(runner.runPrompt.claimAppend()).toBe(true);
    expect(
      consumeRequesterFinalAttachment({
        requesterAgentId: "researcher",
        requesterSessionKey: "agent:researcher:talk",
        requesterSessionId: "session-talk",
        batchRunIds: ["run-child"],
        rearmGeneration: 1,
        text: "late final",
      }),
    ).toBe("appended");
    expect(append).toHaveBeenCalledExactlyOnceWith("late final");
  });

  it("revokes a promoted final when its run owner is stale", async () => {
    const core = deferred<{ payloads: never[] }>();
    mocks.runEmbeddedAgentCore.mockReturnValueOnce(core.promise);
    const append = vi.fn(() => true);
    let runCurrent = true;
    const runner = createRunner(() => runCurrent);
    runner.runPrompt.adoptCompletionClaims();

    const run = runner.runPrompt({ prompt: "investigate", requesterFinal: { append } });
    await vi.waitFor(() => expect(mocks.runEmbeddedAgentCore).toHaveBeenCalledOnce());
    expect(
      promoteRequesterFinalAttachment({
        requesterAgentId: "researcher",
        requesterSessionKey: "agent:researcher:talk",
        requesterTurnRunId: "run-talk",
        batchRunIds: ["run-child"],
        rearmGeneration: 2,
      }),
    ).toBe(true);
    core.resolve({ payloads: [] });
    await expect(run).resolves.toEqual({ text: "done" });

    runCurrent = false;
    expect(runner.runPrompt.claimAppend()).toBe(false);
    expect(
      consumeRequesterFinalAttachment({
        requesterAgentId: "researcher",
        requesterSessionKey: "agent:researcher:talk",
        requesterSessionId: "session-talk",
        batchRunIds: ["run-child"],
        rearmGeneration: 2,
        text: "stale final",
      }),
    ).toBe("missing");
    expect(append).not.toHaveBeenCalled();
  });
});
