import { vi } from "vitest";
import { CronService } from "./service.js";
import {
  createDefaultIsolatedRunner,
  noopLogger,
  setupCronRegressionFixtures,
} from "./service.regression-fixtures.js";

export type CronServiceOptions = ConstructorParameters<typeof CronService>[0];

export const setupCronIssueRegressionFixtures = () =>
  setupCronRegressionFixtures({ prefix: "cron-issues-" });

export {
  createAbortAwareIsolatedRunner,
  createDueIsolatedJob,
  createIsolatedRegressionJob,
  createRunningCronServiceState,
  createDeferred,
  noopLogger,
  topOfHourOffsetMs,
  writeCronJobs,
  writeCronStoreSnapshot,
} from "./service.regression-fixtures.js";

export async function startCronForStore(params: {
  storePath: string;
  cronEnabled?: boolean;
  enqueueSystemEvent?: CronServiceOptions["enqueueSystemEvent"];
  requestHeartbeatNow?: CronServiceOptions["requestHeartbeatNow"];
  runIsolatedAgentJob?: CronServiceOptions["runIsolatedAgentJob"];
  onEvent?: CronServiceOptions["onEvent"];
}) {
  const enqueueSystemEvent =
    params.enqueueSystemEvent ?? (vi.fn() as unknown as CronServiceOptions["enqueueSystemEvent"]);
  const requestHeartbeatNow =
    params.requestHeartbeatNow ?? (vi.fn() as unknown as CronServiceOptions["requestHeartbeatNow"]);
  const runIsolatedAgentJob = params.runIsolatedAgentJob ?? createDefaultIsolatedRunner();

  const cron = new CronService({
    cronEnabled: params.cronEnabled ?? true,
    storePath: params.storePath,
    log: noopLogger,
    enqueueSystemEvent,
    requestHeartbeatNow,
    runIsolatedAgentJob,
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
  await cron.start();
  return cron;
}
