import path from "node:path";
import { vi } from "vitest";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "../src/agents/admitted-run-context.js";
import { createEmbeddedRunLaneController } from "../src/agents/embedded-agent-runner/run/lane-controller.js";
import type { RunEmbeddedAgentParams } from "../src/agents/embedded-agent-runner/run/params.js";
import { prepareAndDispatchEmbeddedRunAttempt } from "../src/agents/embedded-agent-runner/run/run-attempt-dispatch.js";
import { registerAgentHarness } from "../src/agents/harness/registry.js";
import type { AgentHarness } from "../src/agents/harness/types.js";
import { getAgentEventLifecycleGeneration } from "../src/infra/agent-events.js";

/** Capture the host-issued scope at the real dispatch boundary, not a hand-built route. */
export async function captureNativeYieldDispatchScope(params: {
  workspaceDir: string;
  config: NonNullable<RunEmbeddedAgentParams["config"]>;
  sessionKey: string;
  messageProvider?: string;
  messageTo?: string;
  agentAccountId?: string;
  messageThreadId?: string | number;
}) {
  const agentId = "main";
  const runId = "native-yield-dispatch-proof";
  const sessionId = "proof-session";
  const harnessId = "native-yield-dispatch-fixture";
  const admission = prepareAgentRunAdmission({
    cfg: params.config,
    facts: {
      runId,
      agentId,
      ingress: { kind: "system", boundary: "dispatch-proof", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef(runId),
  });
  const admittedRunContext = await admission.admit("plugin-harness", "dispatch-proof");
  const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async (attempt) => ({
    terminal: { kind: "ok" },
    sessionIdUsed: attempt.sessionId,
    messagesSnapshot: [],
    assistantTexts: [],
    toolMetas: [],
    lastAssistant: undefined,
    didSendViaMessagingTool: false,
    messagingToolSentTexts: [],
    messagingToolSentMediaUrls: [],
    messagingToolSentTargets: [],
    cloudCodeAssistFormatError: false,
    replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
    itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
  }));
  registerAgentHarness({
    id: harnessId,
    label: "Synthetic dispatch capture",
    supports: () => ({ supported: true }),
    conversationToolPolicySupport: "exact",
    runAttempt,
  });
  const runParams = {
    ...params,
    admittedRunContext,
    agentId,
    runId,
    sessionId,
    sessionTarget: {
      agentId,
      sessionId,
      sessionKey: params.sessionKey,
      expectedLifecycleRevision: "proof-revision",
    },
    sessionFile: params.sessionKey,
    prompt: "Synthetic dispatch capture",
    timeoutMs: 5_000,
    disableTrajectory: true,
  };
  let lifecycleGeneration = getAgentEventLifecycleGeneration();
  const laneController = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => runParams,
    globalLane: "native-yield-dispatch-proof-global",
    sessionLane: "native-yield-dispatch-proof-session",
    initialQueuedLifecycleGeneration: lifecycleGeneration,
    setLifecycleGeneration: (value) => {
      lifecycleGeneration = value;
    },
    setParams() {},
  });
  const authProfileStore = { version: 1, profiles: {} };
  const input = {
    runInput: {
      runParams,
      provider: "fixture",
      modelId: "fixture-model",
      workspaceResolution: { agentId, workspaceDir: params.workspaceDir },
      workspaceDir: params.workspaceDir,
      agentDir: path.join(params.workspaceDir, "agent"),
      isCanonicalWorkspace: true,
      resolvedSessionKey: params.sessionKey,
      resolvedToolResultFormat: "markdown",
      startedAtMs: Date.now(),
      startupStages: { mark: vi.fn() },
      emitStartupStageSummary: vi.fn(),
      lifecycleGeneration,
      laneController,
      progressController: {
        resolveAttemptFastModeParam: () => false,
        maybeAnnounceFastModeAutoOff: vi.fn(),
        notifyExecutionPhase: vi.fn(),
        notifyRunProgress: vi.fn(),
        notifyToolResult: vi.fn(),
        notifyAgentEvent: vi.fn(),
      },
    },
    preparedRuntime: {
      requestedModelId: "fixture-model",
      nativeModelOwned: true,
      attemptAuthProfileStore: authProfileStore,
      resolveRunAttemptAuthProfileStore: () => authProfileStore,
      snapshot: () => ({
        agentHarness: { id: harnessId },
        pluginHarnessOwnsTransport: true,
        effectiveModel: {
          id: "fixture-model",
          provider: "fixture",
          api: "openai-responses",
          input: ["text"],
        },
        thinkLevel: "off",
        apiKeyInfo: null,
        runtimeAuthState: null,
        activePreparedAuthPlan: {
          providerForAuth: "fixture",
          authProfileProviderForAuth: "fixture",
        },
        providerRuntimeHandle: { provider: "fixture" },
      }),
    },
    sessionPromptState: {
      sessionId,
      sessionFile: params.sessionKey,
      sessionTarget: { agentId, sessionId, sessionKey: params.sessionKey },
      activePrompt: { persisted: false, internal: false },
      onUserMessagePersisted: vi.fn(),
      settleOwnedTranscriptProjection: vi.fn(),
      suppressNextUserMessagePersistence: false,
    },
    terminalRetryState: { beforeFinalizeRevisionAttempts: 0 },
    provider: "fixture",
    modelId: "fixture-model",
    replayState: { replayInvalid: false, hadPotentialSideEffects: false },
    startupStagesEmitted: false,
    bootstrapPromptWarningSignaturesSeen: [],
    resolveRuntimeFallbackReason: () => null,
    observeToolOutcome: vi.fn(),
    isTurnTainted: () => false,
    allocateToolOutcomeOrdinal: () => 1,
    getPostCompactionAbortError: () => undefined,
    setPostCompactionAbortController() {},
    clearPostCompactionAbortController() {},
  } as unknown as Parameters<typeof prepareAndDispatchEmbeddedRunAttempt>[0];
  try {
    await prepareAndDispatchEmbeddedRunAttempt(input);
    const scope = runAttempt.mock.calls[0]?.[0].agentHarnessTaskRuntimeScope;
    if (!scope) {
      throw new Error("Dispatch did not supply a host-issued task runtime scope");
    }
    return scope;
  } finally {
    admission.close();
  }
}
