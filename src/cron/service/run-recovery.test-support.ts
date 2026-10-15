import { vi } from "vitest";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import {
  claimCronRunReceiptInDatabaseForTest,
  prepareCronRunReceiptClaim,
} from "../store/run-receipt-store.test-support.js";
import type { CronJob } from "../types.js";
import { createCronServiceState, type Logger } from "./state.js";

type RecoveryStateOverrides = Partial<
  Pick<
    Parameters<typeof createCronServiceState>[0],
    "cronConfig" | "enqueueSystemEvent" | "requestHeartbeat" | "sendCronFailureAlert"
  >
>;

export function makeCronRecoveryState(
  log: Logger,
  storePath: string,
  nowMs: number,
  overrides: RecoveryStateOverrides = {},
) {
  return createCronServiceState({
    scheduler: createTestGatewayScheduler(),
    storePath,
    cronEnabled: true,
    log,
    nowMs: () => nowMs,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    ...overrides,
  });
}

export function claimCronRecoveryReceipt(
  storePath: string,
  job: CronJob,
  startedAtMs: number,
  defaultAgentId = "alpha",
) {
  const prepared = prepareCronRunReceiptClaim({
    observed: undefined,
    storePath,
    job,
    agentId: job.agentId ?? defaultAgentId,
    startedAtMs,
  });
  return runOpenClawStateWriteTransaction(({ db }) =>
    claimCronRunReceiptInDatabaseForTest({
      database: db,
      prepared,
    }),
  );
}
