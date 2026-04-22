import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type RestartTransactionMode = "terminal-handoff" | "drain-then-restart";

export type RestartTransactionState =
  | "requested"
  | "acked"
  | "draining"
  | "handoff_pending"
  | "restarting"
  | "boot_recovered"
  | "completed"
  | "needs_attention";

export type RestartTransactionRequester = {
  actor?: string;
  deviceId?: string;
  clientIp?: string;
  entryPoint?: string;
};

export type RestartTransactionDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
};

export type RestartInterruptedTurnEnvelope = {
  sessionKey: string;
  turnId?: string;
  phase?: string;
  interruptionCause: string;
  pendingUserVisibleFollowupNote?: string | null;
  resumeEligible: boolean;
};

export type RestartTransaction = {
  restartId: string;
  requestedAt: number;
  requester?: RestartTransactionRequester | null;
  reason?: string | null;
  sessionKey?: string;
  turnId?: string;
  mode: RestartTransactionMode;
  state: RestartTransactionState;
  note?: string | null;
  deliveryContext?: RestartTransactionDeliveryContext | null;
  threadId?: string;
  interruptedTurn?: RestartInterruptedTurnEnvelope | null;
  finalOutcome?: string | null;
  finalizedAt?: number | null;
};

export type RestartTransactionFile = {
  version: 1;
  transaction: RestartTransaction;
};

const RESTART_TRANSACTION_FILENAME = "restart-transaction.json";

export function resolveRestartTransactionPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), RESTART_TRANSACTION_FILENAME);
}

export async function writeRestartTransaction(
  transaction: RestartTransaction,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const filePath = resolveRestartTransactionPath(env);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const data: RestartTransactionFile = {
    version: 1,
    transaction,
  };
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf-8");
  return filePath;
}

export async function readRestartTransaction(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartTransaction | null> {
  const filePath = resolveRestartTransactionPath(env);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    let parsed: RestartTransactionFile | undefined;
    try {
      parsed = JSON.parse(raw) as RestartTransactionFile | undefined;
    } catch {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }
    if (!parsed || parsed.version !== 1 || !parsed.transaction) {
      await fs.unlink(filePath).catch(() => {});
      return null;
    }
    return parsed.transaction;
  } catch {
    return null;
  }
}

export async function updateRestartTransaction(
  updater: (current: RestartTransaction | null) => RestartTransaction | null,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartTransaction | null> {
  const next = updater(await readRestartTransaction(env));
  if (!next) {
    return null;
  }
  await writeRestartTransaction(next, env);
  return next;
}

export function isPendingRestartTransaction(
  transaction: RestartTransaction | null | undefined,
): transaction is RestartTransaction {
  if (!transaction) {
    return false;
  }
  return transaction.state !== "completed" && transaction.state !== "needs_attention";
}
