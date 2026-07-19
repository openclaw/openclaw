import fs from "node:fs/promises";
import path from "node:path";
import {
  parseRestartSentinelEnvelope,
  type RestartSentinelPayload,
} from "./restart-sentinel-store.js";

export const UPDATE_RECOVERY_JOURNAL_ENV = "OPENCLAW_UPDATE_RECOVERY_JOURNAL";
export const UPDATE_RECOVERY_LOCATOR_ENV = "OPENCLAW_UPDATE_RECOVERY_LOCATOR";
export const UPDATE_RECOVERY_JOURNAL_FILENAME = "update-recovery-journal.json";

export type UpdateRecoveryJournal = {
  version: 1;
  handoffId: string;
  payload: RestartSentinelPayload;
  committedPayload: RestartSentinelPayload;
};

const JOURNAL_LOCK_STALE_MS = 30_000;
const JOURNAL_LOCK_TIMEOUT_MS = 5_000;

function isConfirmedPayload(payload: RestartSentinelPayload): boolean {
  return payload.stats?.confirmationTier === "human"
    ? payload.stats.confirmationStatus === "human-confirmed"
    : payload.stats?.confirmationStatus === "delivery-acked";
}

export function resolveUpdateRecoveryJournalPath(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const filePath = env[UPDATE_RECOVERY_JOURNAL_ENV]?.trim();
  return filePath ? path.resolve(filePath) : null;
}

export function resolveUpdateRecoveryJournalPathFromSnapshot(snapshotRoot: string): string {
  return path.join(path.resolve(snapshotRoot), UPDATE_RECOVERY_JOURNAL_FILENAME);
}

export async function writeUpdateRecoveryLocator(params: {
  filePath: string;
  handoffId: string;
  journalPath: string;
}): Promise<void> {
  const filePath = path.resolve(params.filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const staged = `${filePath}.stage-${process.pid}-${Date.now()}`;
  await fs.writeFile(
    staged,
    `${JSON.stringify({ version: 1, handoffId: params.handoffId, journalPath: path.resolve(params.journalPath) }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await fs.rename(staged, filePath);
}

function parseUpdateRecoveryJournal(value: unknown): UpdateRecoveryJournal | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<UpdateRecoveryJournal>;
  const envelope = parseRestartSentinelEnvelope({ version: 1, payload: candidate.payload });
  const committedEnvelope = parseRestartSentinelEnvelope({
    version: 1,
    payload: candidate.committedPayload,
  });
  if (
    candidate.version !== 1 ||
    typeof candidate.handoffId !== "string" ||
    !candidate.handoffId ||
    !envelope ||
    !committedEnvelope ||
    envelope.payload.stats?.handoffId !== candidate.handoffId ||
    committedEnvelope.payload.stats?.handoffId !== candidate.handoffId
  ) {
    return null;
  }
  return {
    version: 1,
    handoffId: candidate.handoffId,
    payload: envelope.payload,
    committedPayload: committedEnvelope.payload,
  };
}

export async function readUpdateRecoveryJournal(filePath: string): Promise<UpdateRecoveryJournal> {
  const canonicalPath = path.resolve(filePath);
  const parsed = parseUpdateRecoveryJournal(
    JSON.parse(await fs.readFile(canonicalPath, "utf8")) as unknown,
  );
  if (!parsed) {
    throw new Error(`invalid update recovery journal: ${canonicalPath}`);
  }
  return parsed;
}

async function writeJournalFile(filePath: string, journal: UpdateRecoveryJournal): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const staged = `${filePath}.stage-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(staged, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(staged, filePath);
  } catch (error) {
    await fs.rm(staged, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function withJournalLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + JOURNAL_LOCK_TIMEOUT_MS;
  let lock: Awaited<ReturnType<typeof fs.open>> | null = null;
  while (!lock) {
    try {
      lock = await fs.open(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > JOURNAL_LOCK_STALE_MS) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out acquiring update recovery journal lock: ${filePath}`, {
          cause: error,
        });
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
    }
  }
  try {
    return await operation();
  } finally {
    await lock.close().catch(() => undefined);
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}

export async function writeUpdateRecoveryJournal(params: {
  filePath: string;
  handoffId: string;
  payload: RestartSentinelPayload;
}): Promise<UpdateRecoveryJournal> {
  const filePath = path.resolve(params.filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  return await withJournalLock(filePath, async () => {
    const journal = {
      version: 1,
      handoffId: params.handoffId,
      payload: params.payload,
      committedPayload: params.payload,
    } as const;
    await writeJournalFile(filePath, journal);
    return journal;
  });
}

export async function rewriteUpdateRecoveryJournal(params: {
  filePath: string;
  handoffId: string;
  rewrite: (payload: RestartSentinelPayload) => RestartSentinelPayload | null;
  stageConfirmation?: boolean;
}): Promise<UpdateRecoveryJournal | null> {
  const canonicalPath = path.resolve(params.filePath);
  return await withJournalLock(canonicalPath, async () => {
    const current = await readUpdateRecoveryJournal(canonicalPath);
    if (current.handoffId !== params.handoffId) {
      return null;
    }
    const payload = params.rewrite(
      params.stageConfirmation ? current.payload : current.committedPayload,
    );
    if (!payload) {
      return null;
    }
    const stagedConfirmationPending =
      !params.stageConfirmation &&
      isConfirmedPayload(current.payload) &&
      !isConfirmedPayload(current.committedPayload);
    const next = {
      version: 1,
      handoffId: params.handoffId,
      payload: stagedConfirmationPending ? current.payload : payload,
      committedPayload: params.stageConfirmation ? current.committedPayload : payload,
    } as const;
    await writeJournalFile(canonicalPath, next);
    return next;
  });
}

export async function commitUpdateRecoveryJournal(params: {
  filePath: string;
  handoffId: string;
  payload: RestartSentinelPayload;
}): Promise<UpdateRecoveryJournal> {
  const canonicalPath = path.resolve(params.filePath);
  return await withJournalLock(canonicalPath, async () => {
    const current = await readUpdateRecoveryJournal(canonicalPath);
    if (current.handoffId !== params.handoffId) {
      throw new Error("update recovery journal handoff changed before confirmation commit");
    }
    const next = {
      version: 1,
      handoffId: params.handoffId,
      payload: params.payload,
      committedPayload: params.payload,
    } as const;
    await writeJournalFile(canonicalPath, next);
    return next;
  });
}
