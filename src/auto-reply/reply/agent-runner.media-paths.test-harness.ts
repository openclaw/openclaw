import path from "node:path";
import { afterEach, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  isTestCliProvider,
  runInitialModelFallbackAttempt,
  type TestModelFallbackRunnerParams,
} from "../../agents/test-helpers/model-fallback-runner.test-support.js";
import { clearRuntimeConfigSnapshot } from "../../config/config.js";
import {
  createReplyOperation as createRegisteredReplyOperation,
  type ReplyOperation,
} from "../../sessions/session-controller.js";
import type { QueueSettings } from "./queue.js";
import { prepareReplyToolAuthority } from "./reply-tool-authority.js";
import {
  createMockFollowupRun,
  createMockReplyOperation,
  createReplyParams,
} from "./test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let testWorkspaceDir: string;

const runEmbeddedAgentMock = vi.fn();
const runWithModelFallbackMock = vi.fn();
const abortEmbeddedAgentRunMock = vi.fn();
const compactEmbeddedAgentSessionMock = vi.fn();
const isEmbeddedAgentRunActiveMock = vi.fn(() => false);
const isEmbeddedAgentRunStreamingMock = vi.fn(() => false);
/** Scripted receipt for the fake reply backend's message injection. */
type BackendQueueOutcome =
  | {
      queued: true;
      transcriptCommit?: "unconfirmed";
      errorMessage?: string;
      [key: string]: unknown;
    }
  | { queued: false; reason: string; [key: string]: unknown };
const backendQueueMessageMock = vi.fn(
  async (sessionId: string, _text: string, _options?: unknown): Promise<BackendQueueOutcome> => ({
    queued: false,
    sessionId,
    reason: "not_streaming",
    gatewayHealth: "live",
  }),
);
const waitForEmbeddedAgentRunEndMock = vi.fn();
const enqueueFollowupRunMock = vi.fn();
const parkedSteerAdmitMock = vi.fn(async () => "steer" as const);
const parkedSteerAcceptedMock = vi.fn();
const parkedSteerFallbackMock = vi.fn();
const parkedSteerConsumeMock = vi.fn();
const reserveSteerCandidateMock = vi.fn(() => ({
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
    isCliProvider: isTestCliProvider,
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

vi.mock("../../agents/embedded-agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/embedded-agent.js")>()),
  abortEmbeddedAgentRun: abortEmbeddedAgentRunMock,
  compactEmbeddedAgentSession: compactEmbeddedAgentSessionMock,
  isSessionRunActive: isEmbeddedAgentRunActiveMock,
  isSessionNativeAttemptStreaming: isEmbeddedAgentRunStreamingMock,
  runEmbeddedAgent: runEmbeddedAgentMock,
  waitForSessionRunEnd: waitForEmbeddedAgentRunEndMock,
}));

// mock-isolation: The scripted reply backend owns cleanup; media cases must not detach process-wide native runs.
vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  detachActiveEmbeddedRun: vi.fn(),
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

vi.mock("../../agents/sandbox/context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/sandbox/context.js")>();
  return {
    ...actual,
    ensureSandboxWorkspaceForSession: async () => null,
    prepareSandboxWorkspaceForSession: async () => null,
  };
});

vi.mock("./session-updates.js", () => ({
  incrementCompactionCount: async () => undefined,
}));

vi.mock("./agent-runner-memory.js", () => ({
  runMemoryFlushIfNeeded: async ({ sessionEntry }: { sessionEntry?: unknown }) => ({
    sessionEntry,
    outcome: "skipped",
  }),
  runSessionCompactionIfNeeded: async ({ sessionEntry }: { sessionEntry?: unknown }) =>
    sessionEntry,
}));

vi.mock("./queue.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queue.js")>();
  return {
    ...actual,
    admitFollowupRunLifecycle: vi.fn(async () => {}),
    completeFollowupRunLifecycle: actual.completeFollowupRunLifecycle,
    enqueueFollowupRun: enqueueFollowupRunMock,
    reserveSteerCandidate: reserveSteerCandidateMock,
    refreshQueuedFollowupSession: refreshQueuedFollowupSessionMock,
    resolveFollowupAbortSignal: vi.fn(() => undefined),
    scheduleFollowupDrain: scheduleFollowupDrainMock,
  };
});

vi.mock("../../media/outbound-attachment.js", () => ({
  resolveOutboundAttachmentFromUrl: (...args: unknown[]) =>
    resolveOutboundAttachmentFromUrlMock(...args),
}));

// Observe initial preparation and execution through their shared media-context owner.
vi.mock("./reply-media-paths.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("./reply-media-paths.js")>();
  return {
    ...mod,
    createReplyMediaContext: (...args: Parameters<typeof mod.createReplyMediaContext>) => {
      createReplyMediaContextRuntimeMock(...args);
      return mod.createReplyMediaContext(...args);
    },
  };
});

const { runReplyAgent } = await import("./agent-runner-run.js");

function createMediaFollowupRun(overrides: Parameters<typeof createMockFollowupRun>[0] = {}) {
  const followupRun = createMockFollowupRun({
    ...overrides,
    run: { senderId: "alice", ...overrides.run },
  });
  followupRun.run.thinkingCatalog = [
    {
      provider: followupRun.run.provider,
      id: followupRun.run.model,
      input: ["text", "image"],
    },
  ];
  return followupRun;
}

async function makeRunReplyAgentParams(
  overrides: Partial<Parameters<typeof runReplyAgent>[0]> & {
    provider?: string;
    prompt?: string;
    workspaceDir?: string;
  } = {},
): Promise<Parameters<typeof runReplyAgent>[0]> {
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
    await replyOperation.bindToolAuthoritySnapshotAsync(prepareReplyToolAuthority(followupRun));
  }
  if (overrides.isActive === true) {
    replyOperation.attachBackend({
      kind: "embedded",
      cancel: vi.fn(),
      supportsQueueMessageImages: true,
      supportsTranscriptCommitWait: true,
      taskSuggestionDeliveryMode: followupRun.run.taskSuggestionDeliveryMode,
      messageInjectionV2: {
        version: 2,
        isAvailable: () => true,
        async queueMessage() {
          throw new Error("Expected asynchronous prepared injection");
        },
        async queueMessageAsync(text, options, preparation) {
          await preparation.prepareCurrent();
          preparation.assertCurrent();
          const outcome = await backendQueueMessageMock(replyOperation.sessionId, text, options);
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

  return createReplyParams(followupRun, {
    commandBody: prompt,
    queueKey: overrides.sessionKey ?? "main",
    resolvedQueue: { mode: "interrupt" } as QueueSettings,
    sessionCtx: {
      Provider: provider,
      Surface: provider,
      To: "chat-1",
      OriginatingTo: "chat-1",
      AccountId: "default",
      MessageSid: "msg-1",
    },
    defaultModel: "anthropic/claude",
    typingMode: "instant",
    replyOperation,
    ...overrides,
  });
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
  backendQueueMessageMock.mockReset();
  backendQueueMessageMock.mockImplementation(async (sessionId: string) => ({
    queued: false,
    sessionId,
    reason: "not_streaming",
    gatewayHealth: "live",
  }));
  waitForEmbeddedAgentRunEndMock.mockReset();
  enqueueFollowupRunMock.mockReset();
  parkedSteerAdmitMock.mockReset();
  parkedSteerAdmitMock.mockResolvedValue("steer");
  parkedSteerAcceptedMock.mockReset();
  parkedSteerFallbackMock.mockReset();
  parkedSteerConsumeMock.mockReset();
  reserveSteerCandidateMock.mockReset();
  reserveSteerCandidateMock.mockReturnValue({
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
  createMediaFollowupRun,
  createReplyMediaContextRuntimeMock,
  enqueueFollowupRunMock,
  makeRunReplyAgentParams,
  reserveSteerCandidateMock,
  parkedSteerConsumeMock,
  parkedSteerFallbackMock,
  backendQueueMessageMock,
  resolveOutboundAttachmentFromUrlMock,
  runEmbeddedAgentMock,
  runReplyAgent,
  tempDirs,
  testWorkspaceDir,
};
