/** Test helpers for queued follow-up reply runs. */
import { afterAll, beforeAll, expect } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { defaultRuntime } from "../../runtime.js";
import { deferSessionControllerClaimBeforeExecution } from "../../sessions/session-controller.mailbox-claim.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";

/** Builds a minimal queued follow-up run fixture. */
export function createQueueTestRun(params: {
  prompt: string;
  messageId?: string;
  originatingChannel?: FollowupRun["originatingChannel"];
  originatingTo?: string;
  originatingAccountId?: string;
  originatingThreadId?: string | number;
  originatingReplyToId?: string;
  originatingReplyToMode?: FollowupRun["originatingReplyToMode"];
  originatingChatType?: string;
  currentInboundEventKind?: FollowupRun["currentInboundEventKind"];
}): FollowupRun {
  return {
    prompt: params.prompt,
    messageId: params.messageId,
    enqueuedAt: Date.now(),
    originatingChannel: params.originatingChannel,
    originatingTo: params.originatingTo,
    originatingAccountId: params.originatingAccountId,
    originatingThreadId: params.originatingThreadId,
    originatingReplyToId: params.originatingReplyToId,
    originatingReplyToMode: params.originatingReplyToMode,
    originatingChatType: params.originatingChatType,
    currentInboundEventKind: params.currentInboundEventKind,
    run: {
      agentId: "agent",
      agentDir: "/tmp",
      // Logical test keys must not alias the physical incarnation of an earlier case.
      sessionId: `queue-test:${expect.getState().currentTestName}`,
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp",
      config: {} as OpenClawConfig,
      provider: "openai",
      model: "gpt-test",
      timeoutMs: 10_000,
      blockReplyBreak: "text_end",
    },
  };
}

/** Suppresses runtime error logging while queue tests intentionally trigger failures. */
export function installQueueRuntimeErrorSilencer(): void {
  let previousRuntimeError: typeof defaultRuntime.error;

  beforeAll(() => {
    previousRuntimeError = defaultRuntime.error;
    defaultRuntime.error = (() => {}) as typeof defaultRuntime.error;
  });

  afterAll(() => {
    defaultRuntime.error = previousRuntimeError;
  });
}

export function createQueueSettings(overrides: Partial<QueueSettings> = {}): QueueSettings {
  return {
    mode: "collect",
    debounceMs: 0,
    cap: 50,
    dropPolicy: "summarize",
    ...overrides,
  };
}

export function createDrainRecorder(expectedCalls = 1) {
  const calls: Array<FollowupRun & { currentTurnImagesPrepared?: true }> = [];
  const done = createDeferred();
  const runFollowup = async (run: FollowupRun) => {
    calls.push(run);
    if (calls.length >= expectedCalls) {
      done.resolve();
    }
  };
  return { calls, done, runFollowup };
}

export async function drainRecordedQueue(
  key: string,
  runFollowup: ReturnType<typeof createDrainRecorder>["runFollowup"],
  done: ReturnType<typeof createDrainRecorder>["done"],
) {
  scheduleFollowupDrain(key, runFollowup);
  await done.promise;
}

export function enqueueTestRun(
  key: string,
  params: Parameters<typeof createQueueTestRun>[0],
  settings: QueueSettings,
  runOverrides?: Partial<FollowupRun["run"]>,
) {
  const run = createQueueTestRun(params);
  if (runOverrides) {
    run.run = { ...run.run, ...runOverrides };
  }
  return enqueueFollowupRun(key, run, settings);
}

export function enqueueSlackRun(
  key: string,
  settings: QueueSettings,
  prompt: string,
  runOverrides: Partial<FollowupRun["run"]>,
  routeOverrides: Partial<Parameters<typeof createQueueTestRun>[0]> = {},
) {
  return enqueueTestRun(
    key,
    { prompt, originatingChannel: "slack", originatingTo: "channel:A", ...routeOverrides },
    settings,
    runOverrides,
  );
}

/** Synthetic preparation owner: the callback has not entered a model/tool effect. */
export function rejectQueuePreparation(run: FollowupRun, error: Error): never {
  const claim = run.controllerClaim ?? run.controllerInput?.claim;
  if (!claim || !deferSessionControllerClaimBeforeExecution(claim)) {
    throw new Error("Cannot retry a committed or released test execution", { cause: error });
  }
  throw error;
}
