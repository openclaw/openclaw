/** Shared test fixtures for reply queue and typing-controller tests. */
import path from "node:path";
import { onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createReplyOperationExecutionCustody } from "../../sessions/session-controller.execution-custody.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { createSessionControllerWatchdog } from "../../sessions/session-controller.watchdog.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { RunReplyAgentParams } from "./agent-runner-core.js";
import type { FollowupRun } from "./queue.js";
import type { TypingController } from "./typing.js";

export function createReplyParams(
  followupRun: RunReplyAgentParams["followupRun"],
  overrides: Partial<RunReplyAgentParams> = {},
): RunReplyAgentParams {
  return {
    commandBody: followupRun.prompt,
    followupRun,
    queueKey: followupRun.run.sessionKey!,
    defaultModel: followupRun.run.model,
    sessionCtx: {},
    resolvedQueue: { mode: "interrupt" },
    shouldSteer: false,
    shouldFollowup: false,
    isActive: false,
    typing: createMockTypingController(),
    resolvedVerboseLevel: "off",
    isNewSession: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    shouldInjectGroupIntro: false,
    typingMode: "never",
    ...overrides,
  };
}

/** Creates a stateful reply-operation double without registering global run state. */
export function createMockReplyOperation(
  overrides: {
    abortSignal?: AbortSignal;
    key?: string;
    sessionId?: string;
    toolAuthorityFingerprint?: string;
  } = {},
) {
  const failMock = vi.fn();
  const freezeAbortMock = vi.fn();
  let sessionId = overrides.sessionId ?? "session";
  const updateSessionIdMock = vi.fn((nextSessionId: string) => {
    sessionId = nextSessionId;
  });
  let toolAuthorityFingerprint = overrides.toolAuthorityFingerprint;
  let toolAuthoritySnapshot: Parameters<ReplyOperation["bindToolAuthoritySnapshot"]>[0] | undefined;
  let toolAuthorityRoute: ReplyOperation["toolAuthorityRoute"];
  const owner = createDeferredCore();
  const watchdog = createSessionControllerWatchdog({
    startedAtMs: Date.now(),
    isCurrent: () => true,
    readPhase: () =>
      replyOperation.result ? "terminal" : replyOperation.abortFrozen ? "finishing" : "active",
    requestStop: () => "blocked",
    expireCleanup: () => "blocked",
  });
  const executionCustody = createReplyOperationExecutionCustody();
  const complete = () =>
    executionCustody.completeWhenReleased(() => {
      watchdog.close();
      owner.resolve();
    });
  const replyOperation: ReplyOperation = {
    watchdog,
    admissionRetired: false,
    retireAdmissionAfterFencing: vi.fn(async () => false),
    retainExecution: () => executionCustody.retain(),
    ownerSettlement: owner.promise,
    registerExecutionCleanup: vi.fn(() => () => {}),
    registerTerminalProducerFence: vi.fn(() => () => {}),
    terminalProducerBlocked: false,
    key: overrides.key ?? "main",
    get sessionId() {
      return sessionId;
    },
    turnKind: "visible",
    abortSignal: overrides.abortSignal ?? new AbortController().signal,
    resetTriggered: false,
    terminalRecovery: false,
    acceptedSteeredInboundAudio: false,
    sourceReplyDelivered: false,
    get toolAuthorityFingerprint() {
      return toolAuthorityFingerprint;
    },
    get toolAuthorityRoute() {
      return toolAuthorityRoute;
    },
    phase: "running",
    result: null,
    abortFrozen: false,
    staleExpiryReason: undefined,
    startedAtMs: Date.now(),
    lastActivityAtMs: Date.now(),
    hasOwnedSessionId: (candidateSessionId) => candidateSessionId === sessionId,
    captureOwnedSessionIds: vi.fn(() => new Set([sessionId])),
    recordActivity: vi.fn(),
    setPhase: vi.fn(),
    markWaitingForDeferredMaintenance: vi.fn(),
    markDeferredMaintenanceWaitEnded: vi.fn(),
    markWaitingForGlobalLane: vi.fn(),
    markGlobalLaneWaitEnded: vi.fn(),
    markTerminalRecovery: vi.fn(),
    markSteeredInputAccepted: vi.fn(),
    markSourceReplyDelivered: vi.fn(),
    bindToolAuthoritySnapshot: vi.fn((snapshot) => {
      if (replyOperation.result || (toolAuthoritySnapshot && toolAuthoritySnapshot !== snapshot)) {
        throw new Error("Reply operation cannot change tool authority after admission");
      }
      if (toolAuthoritySnapshot) {
        return;
      }
      const fingerprint = snapshot.fingerprint();
      if (!fingerprint) {
        throw new Error("Reply operation tool authority fingerprint is required");
      }
      toolAuthoritySnapshot = snapshot;
      toolAuthorityFingerprint = fingerprint;
    }),
    bindToolAuthoritySnapshotAsync: vi.fn(async (snapshot) => {
      if (replyOperation.result || (toolAuthoritySnapshot && toolAuthoritySnapshot !== snapshot)) {
        throw new Error("Reply operation cannot change tool authority after admission");
      }
      if (!toolAuthoritySnapshot) {
        toolAuthorityFingerprint = await (snapshot.fingerprintAsync?.() ?? snapshot.fingerprint());
        toolAuthoritySnapshot = snapshot;
      }
    }),
    projectToolAuthorityFingerprint: vi.fn((overlay) => {
      if (replyOperation.result || !toolAuthoritySnapshot || !toolAuthorityRoute) {
        return undefined;
      }
      try {
        return toolAuthoritySnapshot.project(overlay, toolAuthorityRoute);
      } catch {
        return undefined;
      }
    }),
    projectToolAuthorityFingerprintAsync: vi.fn(async (overlay) => {
      if (replyOperation.result || !toolAuthoritySnapshot || !toolAuthorityRoute) {
        return undefined;
      }
      return (
        toolAuthoritySnapshot.projectAsync?.(overlay, toolAuthorityRoute) ??
        toolAuthoritySnapshot.project(overlay, toolAuthorityRoute)
      );
    }),
    setAutomaticFallbackRoute: vi.fn(),
    bindToolAuthorityRoute: vi.fn((route) => {
      if (replyOperation.result || !toolAuthoritySnapshot) {
        throw new Error("Reply operation has no active tool authority snapshot");
      }
      const fingerprint = toolAuthoritySnapshot.fingerprint(route);
      toolAuthorityRoute = { ...route };
      toolAuthorityFingerprint = fingerprint;
      return fingerprint;
    }),
    bindToolAuthorityRouteAsync: vi.fn(async (route) => {
      if (replyOperation.result || !toolAuthoritySnapshot) {
        throw new Error("Reply operation has no active tool authority snapshot");
      }
      toolAuthorityFingerprint = await (toolAuthoritySnapshot.fingerprintAsync?.(route) ??
        toolAuthoritySnapshot.fingerprint(route));
      toolAuthorityRoute = { ...route };
      return toolAuthorityFingerprint;
    }),
    updateSessionId: updateSessionIdMock,
    updateSessionKey: vi.fn(),
    attachBackend: vi.fn(),
    detachBackend: vi.fn(),
    freezeAbort: freezeAbortMock,
    retainFailureUntilComplete: vi.fn(),
    yield: vi.fn(() => true),
    complete: vi.fn(complete),
    completeThen: vi.fn((afterClear) => {
      complete();
      afterClear();
    }),
    completeWithAfterClearBarrier: vi.fn((barrier) => {
      void Promise.resolve(barrier).then(complete, complete);
    }),

    fail: failMock,
    abort: vi.fn(() => true),
    abortForStall: vi.fn(() => true),
    abortByUser: vi.fn(() => true),
    abortForRestart: vi.fn(() => true),
    supersede: vi.fn(() => true),
  };
  return { replyOperation, failMock, freezeAbortMock, updateSessionIdMock };
}

/** Creates a typed mock typing controller with optional method overrides. */
export function createMockTypingController(
  overrides: Partial<TypingController> = {},
): TypingController {
  return {
    onReplyStart: vi.fn(async () => {}),
    startTypingLoop: vi.fn(async () => {}),
    startTypingOnText: vi.fn(async () => {}),
    refreshTypingTtl: vi.fn(),
    isActive: vi.fn(() => false),
    markRunComplete: vi.fn(),
    markDispatchIdle: vi.fn(),
    cleanup: vi.fn(),
    ...overrides,
  };
}

/** Creates a minimal queued follow-up run fixture. */
export function createMockFollowupRun(
  overrides: Partial<Omit<FollowupRun, "run">> & { run?: Partial<FollowupRun["run"]> } = {},
): FollowupRun {
  const rootDir = useAutoCleanupTempDirTracker(onTestFinished).make("openclaw-mock-followup-");
  const skipProviderRuntimeHints = process.env.OPENCLAW_TEST_FAST === "1";
  return {
    prompt: "hello",
    summaryLine: "hello",
    enqueuedAt: Date.now(),
    originatingTo: "channel:C1",
    ...overrides,
    run: {
      agentId: "main",
      agentDir: path.join(rootDir, "agent"),
      sessionId: "session",
      sessionKey: "main",
      messageProvider: "whatsapp",
      agentAccountId: "primary",
      sessionFile: path.join(rootDir, "session.jsonl"),
      workspaceDir: rootDir,
      config: {},
      skillsSnapshot: { prompt: "", skills: [] },
      provider: "anthropic",
      model: "claude",
      thinkingCatalog: [
        {
          provider: overrides.run?.provider ?? "anthropic",
          id: overrides.run?.model ?? "claude",
          input: ["text"],
        },
      ],
      verboseLevel: "off",
      elevatedLevel: "off",
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
      timeoutMs: 1_000,
      blockReplyBreak: "message_end",
      skipProviderRuntimeHints,
      ...overrides.run,
    },
  };
}
