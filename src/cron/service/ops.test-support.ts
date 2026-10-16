import { vi } from "vitest";
import { createCronRegressionState } from "../../../test/helpers/cron/service-regression-fixtures.js";
import type { CronEvent, CronServiceDeps } from "./state.js";

export function createOkIsolatedCronStateFactory(log: CronServiceDeps["log"]) {
  return function createOkIsolatedCronState(params: {
    storePath: string;
    now: number;
    summary?: string;
    onEvent?: (event: CronEvent) => void;
    triggersEnabled?: boolean;
  }) {
    return createCronRegressionState({
      log,
      storePath: params.storePath,
      nowMs: () => params.now,
      ...(params.triggersEnabled ? { cronConfig: { triggers: { enabled: true } } } : {}),
      runIsolatedAgentJob: vi.fn(async () => ({
        status: "ok" as const,
        delivered: true,
        ...(params.summary === undefined ? {} : { summary: params.summary }),
      })),
      ...(params.onEvent ? { onEvent: params.onEvent } : {}),
    });
  };
}
