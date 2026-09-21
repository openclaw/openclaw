import { vi } from "vitest";
import * as stateRead from "../../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { cronStoreKey } from "../store/key.js";
import {
  claimCronRunReceiptInDatabase,
  prepareCronRunReceiptClaim,
} from "../store/run-receipt-store.js";
import type { CronRunRecoveryProposal } from "../store/run-recovery-read.types.js";
import type { CronRunRecoveryResult } from "../store/run-recovery.types.js";
import type { CronJob } from "../types.js";
import { recoverCronRunProposals } from "./run-recovery.js";
import { createCronServiceState, type CronServiceState, type Logger } from "./state.js";

export async function observeCronRecoveryForTest(
  state: CronServiceState,
  jobId: string,
  queuedAtMs: number | undefined,
  runningAtMs: number | undefined,
): Promise<CronRunRecoveryProposal> {
  const result = await stateRead.executeExistingOpenClawStateRead(
    {},
    {
      type: "cron.observeRunRecovery",
      storeKey: cronStoreKey(state.deps.storePath),
      proposals: [{ jobId, queuedAtMs, runningAtMs }],
    },
  );
  if (
    !result?.ok ||
    result.type !== "cron.observeRunRecovery" ||
    result.observation.kind !== "observed"
  ) {
    throw new Error("Expected a recovery observation");
  }
  return result.observation.proposals[0]!;
}

export async function recoverCronRunForTest(
  state: CronServiceState,
  proposal: CronRunRecoveryProposal,
  mode: "startup" | "reclaim" = "reclaim",
): Promise<CronRunRecoveryResult> {
  let recovered: CronRunRecoveryResult | undefined;
  await recoverCronRunProposals(state, [proposal], {
    mode,
    onRecovery(_proposal, result) {
      recovered = result;
    },
  });
  if (!recovered) {
    throw new Error("Expected a recovery result");
  }
  return recovered;
}

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

export function claimCronRecoveryReceipt(storePath: string, job: CronJob, startedAtMs: number) {
  const prepared = prepareCronRunReceiptClaim({
    storePath,
    job,
    agentId: job.agentId ?? "alpha",
    startedAtMs,
  });
  return runOpenClawStateWriteTransaction(({ db }) =>
    claimCronRunReceiptInDatabase({
      database: db,
      prepared,
      resolveAgentId: (current) => current.agentId ?? "alpha",
    }),
  );
}
