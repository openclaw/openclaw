import { randomUUID } from "node:crypto";
import {
  createDrainRecorder,
  createQueueSettings,
  createQueueTestRun,
  drainRecordedQueue,
} from "./queue.test-helpers.js";
import { scheduleFollowupDrain } from "./queue/drain.js";
import { enqueueFollowupRun } from "./queue/enqueue.js";
import type { FollowupRun, QueueSettings } from "./queue/types.js";

type RunInput = Parameters<typeof createQueueTestRun>[0];

export function createQueueCase(overrides: Partial<QueueSettings> = {}, expectedCalls = 1) {
  const key = `queue-case-${randomUUID()}`;
  const settings = createQueueSettings(overrides);
  const recorder = createDrainRecorder(expectedCalls);
  const add = (run: FollowupRun, nextSettings = settings) =>
    enqueueFollowupRun(key, run, nextSettings);
  const enqueue = (params: RunInput, runOverrides?: Partial<FollowupRun["run"]>) => {
    const run = createQueueTestRun(params);
    Object.assign(run.run, runOverrides);
    return add(run);
  };
  const start = (runFollowup = recorder.runFollowup) => scheduleFollowupDrain(key, runFollowup);
  return {
    key,
    settings,
    ...recorder,
    add,
    enqueue,
    enqueueMany: (...runs: RunInput[]) => {
      for (const run of runs) {
        enqueue(run);
      }
    },
    slack: (
      prompt: string,
      runOverrides: Partial<FollowupRun["run"]>,
      route: Partial<RunInput> = {},
    ) =>
      enqueue(
        { prompt, originatingChannel: "slack", originatingTo: "channel:A", ...route },
        runOverrides,
      ),
    start,
    drain: (runFollowup = recorder.runFollowup) =>
      drainRecordedQueue(key, runFollowup, recorder.done),
  };
}
