import { vi } from "vitest";
import { runActiveReplySteer } from "./agent-runner-steer-adoption.js";
import type {
  ReplyBackendHandle,
  ReplyBackendMessageInjectionV2,
} from "./reply-run-registry.contracts.js";
import type { ReplyOperation } from "./reply-run-registry.js";
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
    restartRecoverySourceTurnId: undefined,
    replyOperationRunState: undefined,
    releaseAdmissionTicket() {},
    touchActiveSessionEntry: async () => {},
    typing,
    typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
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
    cancel,
    toolAuthorityFingerprint,
    messageInjectionV2: { version: 2, isAvailable: () => true, ...injection },
    ...(runId === undefined ? {} : { runId }),
  });
  operation.setPhase("running");
}
