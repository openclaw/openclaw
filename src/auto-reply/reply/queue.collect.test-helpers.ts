// Collect-mode enqueue helpers shared by the collect queue suites.
//
// Enqueue is durable now, so every helper awaits the shared-state write and the
// multi-run helpers enqueue sequentially: collect batching and overflow eviction
// both depend on admission order.
import type { FollowupRun, QueueSettings } from "./queue.js";
import { enqueueFollowupRun } from "./queue.js";
import {
  createQueueTestRun as createRun,
  createQueueSettings,
  createDrainRecorder,
} from "./queue.test-helpers.js";

export async function enqueueTestRun(
  key: string,
  params: Parameters<typeof createRun>[0],
  settings: QueueSettings,
  runOverrides?: Partial<FollowupRun["run"]>,
): Promise<boolean> {
  const run = createRun(params);
  if (runOverrides) {
    run.run = { ...run.run, ...runOverrides };
  }
  return await enqueueFollowupRun(key, run, settings);
}

export async function enqueueSlackRun(
  key: string,
  settings: QueueSettings,
  prompt: string,
  runOverrides: Partial<FollowupRun["run"]>,
  routeOverrides: Partial<Parameters<typeof createRun>[0]> = {},
): Promise<boolean> {
  return await enqueueTestRun(
    key,
    { prompt, originatingChannel: "slack", originatingTo: "channel:A", ...routeOverrides },
    settings,
    runOverrides,
  );
}

export function createQueueCase(
  key: string,
  overrides: Partial<QueueSettings> = {},
  expectedCalls = 1,
) {
  return { key, ...createDrainRecorder(expectedCalls), settings: createQueueSettings(overrides) };
}

export async function enqueueTestRuns(
  key: string,
  settings: QueueSettings,
  ...runs: Parameters<typeof createRun>[0][]
): Promise<void> {
  for (const run of runs) {
    await enqueueTestRun(key, run, settings);
  }
}

export async function enqueueRoutedRuns(
  key: string,
  settings: QueueSettings,
  route: Omit<Parameters<typeof createRun>[0], "prompt">,
  ...prompts: string[]
): Promise<void> {
  for (const prompt of prompts) {
    await enqueueTestRun(key, { prompt, ...route }, settings);
  }
}
