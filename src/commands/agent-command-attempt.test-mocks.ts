// Command-attempt fixtures preserve execution handoffs without starting external runtimes.
import { vi } from "vitest";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { getAgentAttemptExecutionMocks } from "./agent-command-state.test-mocks.js";

const attemptExecutionMocks = getAgentAttemptExecutionMocks();

vi.mock("../agents/command/session-store.runtime.js", async () => {
  const accessor = await import("../config/sessions/session-accessor.js");
  return {
    loadSessionEntry: accessor.loadSessionEntry,
    loadSessionEntryReadOnly: accessor.loadSessionEntryReadOnly,
    updateSessionStoreAfterAgentRun: vi.fn(async () => undefined),
  };
});

vi.mock("../agents/command/cli-compaction.js", () => {
  return {
    runCliTurnCompactionLifecycle: vi.fn(
      async (params: { sessionEntry?: unknown }) => params.sessionEntry,
    ),
  };
});

vi.mock("../agents/command/attempt-execution.runtime.js", () => {
  return {
    buildAcpResult: vi.fn(),
    createAcpToolLifecycleTracker: () => ({
      active: new Map(),
      terminalToolCallIds: new Set(),
      saturated: false,
    }),
    createAcpVisibleTextAccumulator: vi.fn(),
    emitAcpAssistantDelta: vi.fn(),
    emitAcpLifecycleEnd: vi.fn(),
    emitAcpLifecycleError: vi.fn(),
    emitAcpLifecycleStart: vi.fn(),
    persistAcpTurnTranscript: vi.fn(async (params: { sessionEntry?: unknown }) => ({
      kind: "persisted",
      sessionEntry: params.sessionEntry,
    })),
    persistCliTurnTranscript: vi.fn(async (params: { sessionEntry?: unknown }) => ({
      kind: "persisted",
      sessionEntry: params.sessionEntry,
    })),
    runAgentAttempt: vi.fn(async (params: Record<string, unknown>) => {
      if (attemptExecutionMocks.useRealRunAgentAttempt) {
        const actual = await vi.importActual<
          typeof import("../agents/command/attempt-execution.js")
        >("../agents/command/attempt-execution.js");
        return await actual.runAgentAttempt(params as never);
      }
      const opts = params.opts as Record<string, unknown>;
      const runContext = params.runContext as Record<string, unknown>;
      const sessionEntry = params.sessionEntry as
        | {
            authProfileOverride?: string;
            authProfileOverrideSource?: string;
          }
        | undefined;
      const providerOverride = params.providerOverride as string;
      const authProfileProvider = params.authProfileProvider as string;
      const authProfileId =
        providerOverride === authProfileProvider ? sessionEntry?.authProfileOverride : undefined;

      return await runEmbeddedAgent({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        agentId: params.sessionAgentId,
        trigger: "user",
        messageChannel: params.messageChannel,
        agentAccountId: runContext.accountId,
        messageTo: opts.replyTo ?? opts.to,
        messageThreadId: opts.threadId,
        sessionFile: params.sessionFile,
        workspaceDir: params.workspaceDir,
        config: params.cfg,
        skillsSnapshot: params.skillsSnapshot,
        prompt: params.body,
        images: opts.images,
        imageOrder: opts.imageOrder,
        clientTools: opts.clientTools,
        provider: providerOverride,
        model: params.modelOverride,
        authProfileId,
        authProfileIdSource: authProfileId ? sessionEntry?.authProfileOverrideSource : undefined,
        thinkLevel: params.resolvedThinkLevel,
        fastMode: params.fastMode,
        verboseLevel: params.resolvedVerboseLevel,
        timeoutMs: params.timeoutMs,
        runId: params.runId,
        lane: opts.lane,
        abortSignal: opts.abortSignal,
        extraSystemPrompt: opts.extraSystemPrompt,
        bootstrapContextMode: opts.bootstrapContextMode,
        bootstrapContextRunKind: opts.bootstrapContextRunKind,
        internalEvents: opts.internalEvents,
        inputProvenance: opts.inputProvenance,
        streamParams: opts.streamParams,
        agentDir: params.agentDir,
        allowTransientCooldownProbe: params.allowTransientCooldownProbe,
        cleanupBundleMcpOnRunEnd: opts.cleanupBundleMcpOnRunEnd,
        cleanupCliLiveSessionOnRunEnd: opts.cleanupCliLiveSessionOnRunEnd,
        modelRun: opts.modelRun,
        promptMode: opts.promptMode,
        disableTools: opts.modelRun === true,
        onAgentEvent: params.onAgentEvent,
      } as never);
    }),
    sessionTranscriptHasContent: vi.fn(async () => false),
  };
});
