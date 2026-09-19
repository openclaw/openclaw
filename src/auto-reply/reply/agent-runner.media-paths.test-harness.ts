import path from "node:path";
import { afterEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { EmbeddedAgentQueueMessageOutcome } from "../../agents/embedded-agent-runner/runs.js";
import {
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { clearRuntimeConfigSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { QueueSettings } from "./queue.js";
import {
  createReplyOperation as createRegisteredReplyOperation,
  type ReplyOperation,
} from "./reply-run-registry.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import {
  createMockFollowupRun,
  createMockReplyOperation,
  createMockTypingController,
} from "./test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let testWorkspaceDir: string;

const runEmbeddedAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const abortEmbeddedAgentRunMock = vi.fn();
const compactEmbeddedAgentSessionMock = vi.fn();
const isEmbeddedAgentRunActiveMock = vi.fn(() => false);
const isEmbeddedAgentRunStreamingMock = vi.fn(() => false);
const queueEmbeddedAgentMessageWithOutcomeAsyncMock = vi.fn(
  async (
    sessionId: string,
    _text: string,
    _options?: unknown,
  ): Promise<EmbeddedAgentQueueMessageOutcome> => ({
    queued: false,
    sessionId,
    reason: "not_streaming",
    gatewayHealth: "live",
  }),
);
const resolveEmbeddedSessionLaneMock = vi.fn();
const waitForEmbeddedAgentRunEndMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();
const parkedSteerAdmitMock = vi.fn(async () => "steer" as const);
const parkedSteerAcceptedMock = vi.fn();
const parkedSteerFallbackMock = vi.fn();
const parkedSteerConsumeMock = vi.fn();
const parkSteerCandidateMock = vi.fn(() => ({
  admit: parkedSteerAdmitMock,
  accepted: parkedSteerAcceptedMock,
  fallback: parkedSteerFallbackMock,
  consume: parkedSteerConsumeMock,
}));
const scheduleFollowupDrainMock = vi.fn();
const refreshQueuedFollowupSessionMock = vi.fn();
const resolveCommandSecretRefsViaGatewayMock = vi.fn();
const resolveOutboundAttachmentFromUrlMock = vi.fn();
const createReplyMediaContextRuntimeMock = vi.fn();
const EXPECTED_STEER_QUEUE_IDENTITY =
  "channel-user:v1:6f3f31084a7a2a6ff17176c0c16682e64d9f21301f64ff7e5bf1173b54fadc33";
const registeredOperations: ReplyOperation[] = [];
vi.mock("../../agents/model-fallback-runner.js", () => ({
  runWithModelFallback: (params: TestModelFallbackRunnerParams) => runWithModelFallbackMock(params),
}));

vi.mock("../../agents/model-fallback-attempt.js", () => ({
  isFallbackSummaryError: (err: unknown) =>
    err instanceof Error &&
    err.name === "FallbackSummaryError" &&
    Array.isArray((err as { attempts?: unknown[] }).attempts),
}));

vi.mock("../../agents/model-selection.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-selection.js")>(
    "../../agents/model-selection.js",
  );
  return {
    ...actual,
    isCliProvider: (provider: string, _cfg?: OpenClawConfig) => {
      const normalized = provider.trim().toLowerCase();
      return (
        normalized === "claude-cli" ||
        normalized === "google-gemini-cli" ||
        normalized === "codex-cli"
      );
    },
  };
});

vi.mock("../../agents/model-runtime-aliases.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/model-runtime-aliases.js")>(
    "../../agents/model-runtime-aliases.js",
  );
  const normalize = (value: string) => value.trim().toLowerCase();
  return {
    ...actual,
    areRuntimeModelRefsEquivalent: (left: string, right: string) =>
      normalize(left) === normalize(right),
  };
});

vi.mock("../../agents/context.js", () => ({
  resolveContextTokensForModel: () => 200_000,
}));

vi.mock("../../infra/agent-events.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/agent-events.js")>(
    "../../infra/agent-events.js",
  );
  return {
    ...actual,
    emitAgentEvent: vi.fn(),
    registerAgentRunContext: vi.fn(),
  };
});
vi.mock("../../infra/agent-run-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../../infra/agent-run-registry.js")>(
    "../../infra/agent-run-registry.js",
  );
  return {
    ...actual,
    registerAgentRunContext: vi.fn(),
  };
});

vi.mock("../../agents/embedded-agent.js", () => ({
  abortEmbeddedAgentRun: abortEmbeddedAgentRunMock,
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
  isEmbeddedAgentRunActive: isEmbeddedAgentRunActiveMock,
  isEmbeddedAgentRunStreaming: isEmbeddedAgentRunStreamingMock,
  queueEmbeddedAgentMessageWithOutcomeAsync: queueEmbeddedAgentMessageWithOutcomeAsyncMock,
  resolveEmbeddedSessionLane: resolveEmbeddedSessionLaneMock,
  runEmbeddedAgent: runEmbeddedAgentMock,
  waitForEmbeddedAgentRunEnd: waitForEmbeddedAgentRunEndMock,
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  clearActiveEmbeddedRun: vi.fn(),
  formatEmbeddedAgentQueueFailureSummary: (outcome: { reason?: string; sessionId?: string }) =>
    outcome.reason && outcome.sessionId
      ? `queue_message_failed reason=${outcome.reason} sessionId=${outcome.sessionId} gatewayHealth=live`
      : undefined,
  queueEmbeddedAgentMessageWithOutcomeAsync: queueEmbeddedAgentMessageWithOutcomeAsyncMock,
}));

vi.mock("../../cli/command-secret-gateway.js", () => ({
  resolveCommandSecretRefsViaGateway: (...args: unknown[]) =>
    resolveCommandSecretRefsViaGatewayMock(...args),
}));

vi.mock("../../cli/command-secret-targets.js", () => ({
  getAgentRuntimeCommandSecretTargetIds: () => new Set<string>(),
  getAgentRuntimeOptionalCommandSecretPaths: () => new Set<string>(),
  getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
}));

vi.mock("../../agents/sandbox.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/sandbox.js")>();
  return {
    ...actual,
    ensureSandboxWorkspaceForSession: async () => null,
  };
});

vi.mock("./session-updates.js", () => ({
  incrementCompactionCount: async () => undefined,
}));

vi.mock("./session-usage.js", () => ({
  persistSessionUsageUpdate: async () => undefined,
}));

vi.mock("./agent-runner-memory.js", () => ({
  runMemoryFlushIfNeeded: async ({ sessionEntry }: { sessionEntry?: unknown }) => ({
    sessionEntry,
    outcome: "skipped",
  }),
  runSessionCompactionIfNeeded: async ({ sessionEntry }: { sessionEntry?: unknown }) =>
    sessionEntry,
}));

vi.mock("./queue.js", () => ({
  admitFollowupRunLifecycle: vi.fn(async () => {}),
  enqueueFollowupRun: enqueueFollowupRunMock,
  parkSteerCandidate: parkSteerCandidateMock,
  refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock,
  resolveFollowupAbortSignal: vi.fn(() => undefined),
  scheduleFollowupDrain: scheduleFollowupDrainMock,
}));

vi.mock("../../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromUrl: (...args: unknown[]) =>
    resolveOutboundAttachmentFromUrlMock(...args),
}));

// Spy on the .runtime import path used by agent-runner-execution.ts so we can assert
// that the fix prevents a second media context from being created inside executeAgentTurn.
vi.mock("./reply-media-paths.runtime.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./reply-media-paths.runtime.js")>();
  return {
    createReplyMediaContext: (...args: Parameters<typeof mod.createReplyMediaContext>) => {
      createReplyMediaContextRuntimeMock(...args);
      return mod.createReplyMediaContext(...args);
    },
    createReplyMediaPathNormalizer: mod.createReplyMediaPathNormalizer,
  };
});

const { runReplyAgent } = await import("./agent-runner.js");

function createMediaFollowupRun(overrides: Parameters<typeof createMockFollowupRun>[0]) {
  const followupRun = createMockFollowupRun(overrides);
  followupRun.run.thinkingCatalog = [
    {
      provider: followupRun.run.provider,
      id: followupRun.run.model,
      input: ["text", "image"],
    },
  ];
  return followupRun;
}

function makeRunReplyAgentParams(
  overrides: Partial<Parameters<typeof runReplyAgent>[0]> & {
    provider?: string;
    prompt?: string;
    workspaceDir?: string;
  } = {},
): Parameters<typeof runReplyAgent>[0] {
  const provider = overrides.provider ?? "whatsapp";
  const prompt = overrides.prompt ?? "generate chart";
  const runWorkspaceDir = overrides.workspaceDir ?? testWorkspaceDir;
  const followupRun =
    overrides.followupRun ??
    createMediaFollowupRun({
      prompt,
      run: {
        agentId: "main",
        thinkingCatalog: [{ provider: "anthropic", id: "claude", input: ["text"] }],
        messageProvider: provider,
        workspaceDir: runWorkspaceDir,
      },
    });
  const replyOperation =
    overrides.replyOperation ??
    (overrides.isActive === true
      ? createRegisteredReplyOperation({
          sessionKey: overrides.sessionKey ?? "main",
          sessionId: followupRun.run.sessionId,
          resetTriggered: false,
        })
      : createMockReplyOperation().replyOperation);
  if (overrides.isActive === true) {
    registeredOperations.push(replyOperation);
    if (!overrides.replyOperation) {
      replyOperation.setPhase("running");
    }
  }
  if (overrides.isActive === true && !overrides.replyOperation) {
    replyOperation.bindToolAuthoritySnapshot(prepareReplyToolAuthority(followupRun));
  }
  if (overrides.isActive === true) {
    replyOperation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      supportsQueueMessageImages: true,
      taskSuggestionDeliveryMode: followupRun.run.taskSuggestionDeliveryMode,
      messageInjection: {
        isAvailable: () => true,
        queueMessage: async (text, options) => {
          const outcome = await queueEmbeddedAgentMessageWithOutcomeAsyncMock(
            replyOperation.sessionId,
            text,
            options,
          );
          if (!outcome.queued) {
            throw new Error(outcome.reason);
          }
          return outcome.transcriptCommit === "unconfirmed"
            ? {
                transcriptCommit: outcome.transcriptCommit,
                errorMessage: outcome.errorMessage ?? "commit unconfirmed",
              }
            : undefined;
        },
      },
    });
  }

  return {
    commandBody: prompt,
    followupRun,
    queueKey: "main",
    resolvedQueue: { mode: "interrupt" } as QueueSettings,
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    typing: createMockTypingController(),
    sessionCtx: {
      Provider: provider,
      Surface: provider,
      To: "chat-1",
      OriginatingTo: "chat-1",
      AccountId: "default",
      MessageSid: "msg-1",
    },
    defaultModel: "anthropic/claude",
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "instant",
    replyOperation,
    ...overrides,
  };
}

export function resetAgentRunnerMediaTestState() {
  testWorkspaceDir = tempDirs.make("openclaw-agent-media-workspace-");
  runEmbeddedAgentMock.mockReset();
  runWithModelFallbackMock.mockReset();
  abortEmbeddedAgentRunMock.mockReset();
  compactEmbeddedAgentSessionMock.mockReset();
  isEmbeddedAgentRunActiveMock.mockReset();
  isEmbeddedAgentRunActiveMock.mockReturnValue(false);
  isEmbeddedAgentRunStreamingMock.mockReset();
  isEmbeddedAgentRunStreamingMock.mockReturnValue(false);
  queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockReset();
  queueEmbeddedAgentMessageWithOutcomeAsyncMock.mockImplementation(async (sessionId: string) => ({
    queued: false,
    sessionId,
    reason: "not_streaming",
    gatewayHealth: "live",
  }));
  resolveEmbeddedSessionLaneMock.mockReset();
  waitForEmbeddedAgentRunEndMock.mockReset();
  enqueueFollowupRunMock.mockReset();
  parkedSteerAdmitMock.mockReset();
  parkedSteerAdmitMock.mockResolvedValue("steer");
  parkedSteerAcceptedMock.mockReset();
  parkedSteerFallbackMock.mockReset();
  parkedSteerConsumeMock.mockReset();
  parkSteerCandidateMock.mockReset();
  parkSteerCandidateMock.mockReturnValue({
    admit: parkedSteerAdmitMock,
    accepted: parkedSteerAcceptedMock,
    fallback: parkedSteerFallbackMock,
    consume: parkedSteerConsumeMock,
  });
  scheduleFollowupDrainMock.mockReset();
  refreshQueuedFollowupSessionMock.mockReset();
  resolveCommandSecretRefsViaGatewayMock.mockReset();
  resolveCommandSecretRefsViaGatewayMock.mockImplementation(async ({ config }) => ({
    resolvedConfig: config,
    diagnostics: [],
    targetStatesByPath: {},
    hadUnresolvedTargets: false,
  }));
  resolveOutboundAttachmentFromUrlMock.mockReset();
  createReplyMediaContextRuntimeMock.mockReset();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  resolveOutboundAttachmentFromUrlMock.mockImplementation(async (mediaUrl: string) => ({
    path: path.join("/tmp/outbound-media", path.basename(mediaUrl)),
  }));
  runWithModelFallbackMock.mockImplementation(async (params: TestModelFallbackRunnerParams) => ({
    result: await runInitialModelFallbackAttempt(params),
    provider: params.provider,
    model: params.model,
    attempts: [],
  }));
}

export function cleanupAgentRunnerMediaTestState() {
  clearRuntimeConfigSnapshot();
  for (const operation of registeredOperations.splice(0)) {
    operation.complete();
  }
  vi.useRealTimers();
}

export {
  EXPECTED_STEER_QUEUE_IDENTITY,
  createMediaFollowupRun,
  createReplyMediaContextRuntimeMock,
  enqueueFollowupRunMock,
  makeRunReplyAgentParams,
  parkSteerCandidateMock,
  parkedSteerConsumeMock,
  parkedSteerFallbackMock,
  queueEmbeddedAgentMessageWithOutcomeAsyncMock,
  resolveOutboundAttachmentFromUrlMock,
  runEmbeddedAgentMock,
  runReplyAgent,
  tempDirs,
  testWorkspaceDir,
};
