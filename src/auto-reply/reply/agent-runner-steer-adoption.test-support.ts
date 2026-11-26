import { vi } from "vitest";
import type {
  ReplyBackendHandle,
  ReplyBackendMessageInjectionV2,
} from "../../sessions/session-controller.contracts.js";
import type { ReplyOperation } from "../../sessions/session-controller.js";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import { createMockTypingController } from "./test-helpers.js";
import { createTypingSignaler } from "./typing-mode.js";

type SteerParams = Parameters<typeof runActiveReplySteer>[0];
export function createSteerParams(
  key: string,
  followupRun: SteerParams["followupRun"],
  providedReplyOperation: SteerParams["providedReplyOperation"],
  overrides: Pick<SteerParams, "runFollowup"> & Partial<SteerParams>,
): SteerParams {
  const typing = createMockTypingController();
  return {
    followupRun,
    providedReplyOperation,
    opts: undefined,
    queueKey: key,
    sessionKey: key,
    sessionCtx: {},
    resolvedQueue: { mode: "steer", debounceMs: 0 },
    sourceTurnId: undefined,
    replyOperationRunState: undefined,
    touchActiveSessionEntry: async () => {},
    typingSignals: createTypingSignaler({ typing, mode: "never" }),
    ...overrides,
  };
}

export function attachSteerBackend(
  operation: ReplyOperation,
  toolAuthorityFingerprint: string,
  options: Omit<ReplyBackendMessageInjectionV2, "version" | "isAvailable"> &
    Partial<Pick<ReplyBackendHandle, "runId" | "cancel">>,
) {
  const { runId, cancel = vi.fn(), ...injection } = options;
  operation.attachBackend({
    kind: "embedded",
    supportsTranscriptCommitWait: true,
    cancel,
    toolAuthorityFingerprint,
    messageInjectionV2: { version: 2, isAvailable: () => true, ...injection },
    ...(runId === undefined ? {} : { runId }),
  });
  operation.setPhase("running");
}
