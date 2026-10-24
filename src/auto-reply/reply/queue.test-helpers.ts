import { afterAll, beforeAll, expect } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { defaultRuntime } from "../../runtime.js";
import { deferSessionControllerClaimBeforeExecution } from "../../sessions/session-controller.mailbox-claim.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun, scheduleFollowupDrain } from "./queue.js";

const slackRoute = { originatingChannel: "slack", originatingTo: "channel:A" };

export function createQueueTestRun(
  params: Pick<FollowupRun, "prompt"> & Partial<Omit<FollowupRun, "run">>,
  execution: Partial<FollowupRun["run"]> = {},
): FollowupRun {
  return {
    enqueuedAt: Date.now(),
    ...params,
    run: {
      agentId: "agent",
      agentDir: "/tmp",
      // Logical test keys must not alias the physical incarnation of an earlier case.
      sessionId: `queue-test:${expect.getState().currentTestName}`,
      sessionFile: "/tmp/session.json",
      workspaceDir: "/tmp",
      config: {},
      provider: "openai",
      model: "gpt-test",
      timeoutMs: 10_000,
      blockReplyBreak: "text_end",
      ...execution,
    },
  };
}

export function installQueueRuntimeErrorSilencer(): void {
  let previousRuntimeError: typeof defaultRuntime.error;

  beforeAll(() => {
    previousRuntimeError = defaultRuntime.error;
    defaultRuntime.error = () => {};
  });

  afterAll(() => {
    defaultRuntime.error = previousRuntimeError;
  });
}

export function createQueueSettings(overrides: Partial<QueueSettings> = {}): QueueSettings {
  return { mode: "collect", debounceMs: 0, cap: 50, dropPolicy: "summarize", ...overrides };
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
  return enqueueFollowupRun(key, createQueueTestRun(params, runOverrides), settings);
}

export function enqueueSlackRun(
  key: string,
  settings: QueueSettings,
  prompt: string,
  run: Partial<FollowupRun["run"]>,
  route: Partial<Parameters<typeof createQueueTestRun>[0]> = {},
) {
  return enqueueTestRun(key, { prompt, ...slackRoute, ...route }, settings, run);
}

/** Synthetic preparation owner: the callback has not entered a model/tool effect. */
export function rejectQueuePreparation(run: FollowupRun, error: Error): never {
  const claim = run.controllerClaim ?? run.controllerInput?.claim;
  if (!claim || !deferSessionControllerClaimBeforeExecution(claim)) {
    throw new Error("Cannot retry a committed or released test execution", { cause: error });
  }
  throw error;
}
