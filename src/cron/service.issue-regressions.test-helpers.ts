import { vi } from "vitest";
import {
  createDefaultIsolatedRunner,
  noopLogger,
  setupCronRegressionFixtures,
  topOfHourOffsetMs,
} from "../../test/helpers/cron/service-regression-fixtures.js";
// Cron issue regression helpers share mocks for service regression tests.
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { CronService } from "./service.js";

type CronServiceOptions = ConstructorParameters<typeof CronService>[0];

/** Sets up temp store fixtures for cron service issue-regression tests. */
export const setupCronIssueRegressionFixtures = () =>
  setupCronRegressionFixtures({ prefix: "cron-issues-" });

export { topOfHourOffsetMs };

export async function startCronForStore(params: {
  storePath: string;
  cronEnabled?: boolean;
  enqueueSystemEvent?: CronServiceOptions["enqueueSystemEvent"];
  runSessionEvent?: CronServiceOptions["runSessionEvent"];
  runIsolatedAgentJob?: CronServiceOptions["runIsolatedAgentJob"];
  onEvent?: CronServiceOptions["onEvent"];
}) {
  const enqueueSystemEvent =
    params.enqueueSystemEvent ?? (vi.fn() as unknown as CronServiceOptions["enqueueSystemEvent"]);
  const runSessionEvent = params.runSessionEvent ?? vi.fn(async () => ({ status: "ok" as const }));
  const runIsolatedAgentJob = params.runIsolatedAgentJob ?? createDefaultIsolatedRunner();

  const cron = new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    cronEnabled: params.cronEnabled ?? true,
    storePath: params.storePath,
    log: noopLogger,
    enqueueSystemEvent,
    runSessionEvent,
    enqueueSessionEvent: vi.fn(),
    runIsolatedAgentJob,
    ...(params.onEvent ? { onEvent: params.onEvent } : {}),
  });
  await cron.start();
  return cron;
}
