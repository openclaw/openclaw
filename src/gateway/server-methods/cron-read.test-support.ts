import { expectDefined } from "@openclaw/normalization-core";
import { vi } from "vitest";
import { cronRunLogEntryToDetail, cronRunStorageStatus } from "../../cron/run-history-detail.js";
import type { CronRunLogEntry } from "../../cron/run-log-types.js";
import { CronService } from "../../cron/service.js";
import { createNoopLogger } from "../../cron/service.test-harness.js";
import { cronStoreKey } from "../../cron/store/key.js";
import { recordCronRunInDatabase } from "../../cron/store/run-history.kernel.js";
import type { CronRunHistoryWrite } from "../../cron/store/run-history.types.js";
import type { CronJobCreate } from "../../cron/types.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { createTestGatewayScheduler } from "../../test-utils/gateway-scheduler-clock.js";
import { cronHandlers } from "./cron.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

export function createHistoryJob(
  agentId: string,
  sessionKey: string,
  name = sessionKey,
): CronJobCreate {
  return {
    name,
    agentId,
    owner: { agentId, sessionKey },
    enabled: false,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "fixture" },
    delivery: { mode: "none" },
  };
}

export function persistRuns(records: CronRunHistoryWrite[]) {
  runOpenClawStateWriteTransaction(({ db }) => {
    for (const record of records) {
      recordCronRunInDatabase(db, record);
    }
  });
}

export function historyRecord(
  entry: CronRunLogEntry,
  storePath: string,
  agentId: string,
  runId: string,
): CronRunHistoryWrite {
  const storeKey = cronStoreKey(storePath);
  return {
    storeKey,
    jobId: entry.jobId,
    runId,
    agentId,
    sessionKey: entry.sessionKey,
    startedAt: entry.runAtMs ?? entry.ts,
    endedAt: entry.ts,
    status: cronRunStorageStatus(entry),
    summary: entry.summary,
    detail: cronRunLogEntryToDetail(entry, { storeKey }),
  };
}

export function createReadService(
  options: Omit<ConstructorParameters<typeof CronService>[0], "scheduler" | "nowMs" | "log">,
) {
  return new CronService({
    scheduler: createTestGatewayScheduler(),
    nowMs: () => Date.now(),
    log: createNoopLogger(),
    ...options,
  });
}

export async function callCron(
  context: GatewayRequestHandlerOptions["context"],
  method: string,
  params: Record<string, unknown>,
  options: Partial<Pick<GatewayRequestHandlerOptions, "client" | "hasCurrentClientAuthority">> = {},
) {
  const respond = vi.fn<RespondFn>();
  await expectDefined(
    cronHandlers[method],
    method,
  )({
    req: { type: "req", id: method, method, params },
    params,
    context,
    client: null,
    respond,
    isWebchatConnect: () => false,
    ...options,
  });
  return respond;
}
