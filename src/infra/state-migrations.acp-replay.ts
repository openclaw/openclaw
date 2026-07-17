// Doctor-only import for the retired ACP replay JSON ledger.
import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { isRecord } from "../utils.js";
import { withFileLock } from "./file-lock.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

const LEGACY_LEDGER_VERSION = 1;
const LEGACY_LEDGER_LOCK_OPTIONS = {
  retries: {
    retries: 8,
    factor: 2,
    minTimeout: 50,
    maxTimeout: 5_000,
    randomize: true,
  },
  stale: 15_000,
  staleRecovery: "fail-closed",
} as const;

type LegacyAcpReplayEvent = {
  seq: number;
  at: number;
  sessionId: string;
  sessionKey: string;
  runId?: string;
  update: SessionUpdate;
};

type LegacyAcpReplaySession = {
  sessionId: string;
  sessionKey: string;
  cwd: string;
  complete: boolean;
  createdAt: number;
  updatedAt: number;
  nextSeq: number;
  events: LegacyAcpReplayEvent[];
};

type LegacySourceIdentity = {
  dev: number | bigint;
  ino: number | bigint;
  mtimeMs: number | bigint;
  sha256: string;
  size: number | bigint;
};

export function resolveLegacyAcpReplayLedgerPath(stateDir: string): string {
  return path.join(stateDir, "acp", "event-ledger.json");
}

function resolveLegacyAcpReplayClaimPath(sourcePath: string): string {
  return `${sourcePath}.doctor-import`;
}

/** Detect the retired ledger only when an explicit doctor flow opts in. */
export function detectLegacyAcpReplayLedger(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["acpReplayLedger"] {
  const sourcePath = resolveLegacyAcpReplayLedgerPath(params.stateDir);
  const claimPath = resolveLegacyAcpReplayClaimPath(sourcePath);
  return {
    sourcePath,
    hasLegacy:
      params.doctorOnlyStateMigrations === true &&
      (fsSync.existsSync(sourcePath) || fsSync.existsSync(claimPath)),
  };
}

function parseLegacyEvent(raw: unknown, sessionId: string): LegacyAcpReplayEvent {
  if (!isRecord(raw) || !isRecord(raw.update)) {
    throw new Error(`legacy ACP replay session ${sessionId} contains an invalid event`);
  }
  if (
    typeof raw.seq !== "number" ||
    !Number.isInteger(raw.seq) ||
    raw.seq < 1 ||
    typeof raw.at !== "number" ||
    !Number.isFinite(raw.at) ||
    raw.sessionId !== sessionId ||
    typeof raw.sessionKey !== "string" ||
    typeof raw.update.sessionUpdate !== "string"
  ) {
    throw new Error(`legacy ACP replay session ${sessionId} contains an invalid event`);
  }
  if (raw.runId !== undefined && (typeof raw.runId !== "string" || raw.runId.length === 0)) {
    throw new Error(`legacy ACP replay session ${sessionId} contains an invalid run id`);
  }
  return {
    seq: raw.seq,
    at: raw.at,
    sessionId,
    sessionKey: raw.sessionKey,
    ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
    update: structuredClone(raw.update) as SessionUpdate,
  };
}

function parseLegacySession(raw: unknown, expectedSessionId: string): LegacyAcpReplaySession {
  if (
    !isRecord(raw) ||
    raw.sessionId !== expectedSessionId ||
    typeof raw.sessionKey !== "string" ||
    typeof raw.cwd !== "string" ||
    typeof raw.complete !== "boolean" ||
    typeof raw.createdAt !== "number" ||
    !Number.isFinite(raw.createdAt) ||
    typeof raw.updatedAt !== "number" ||
    !Number.isFinite(raw.updatedAt) ||
    typeof raw.nextSeq !== "number" ||
    !Number.isInteger(raw.nextSeq) ||
    raw.nextSeq < 1 ||
    !Array.isArray(raw.events)
  ) {
    throw new Error(`legacy ACP replay session ${expectedSessionId} is invalid`);
  }
  const events = raw.events.map((event) => parseLegacyEvent(event, expectedSessionId));
  const sequences = new Set(events.map((event) => event.seq));
  const maxSeq = events.reduce((max, event) => Math.max(max, event.seq), 0);
  if (sequences.size !== events.length || raw.nextSeq <= maxSeq) {
    throw new Error(`legacy ACP replay session ${expectedSessionId} has invalid sequencing`);
  }
  return {
    sessionId: expectedSessionId,
    sessionKey: raw.sessionKey,
    cwd: raw.cwd,
    complete: raw.complete,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    nextSeq: raw.nextSeq,
    events: events.toSorted((left, right) => left.seq - right.seq),
  };
}

function parseLegacyLedger(raw: string): LegacyAcpReplaySession[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed) || parsed.version !== LEGACY_LEDGER_VERSION || !isRecord(parsed.sessions)) {
    throw new Error("legacy ACP replay ledger must be a version 1 JSON object");
  }
  return Object.entries(parsed.sessions).map(([sessionId, session]) =>
    parseLegacySession(session, sessionId),
  );
}

function estimateSessionBytes(session: LegacyAcpReplaySession): number {
  return session.sessionId.length + session.sessionKey.length + session.cwd.length + 32;
}

function estimateEventBytes(event: LegacyAcpReplayEvent, updateJson: string): number {
  return (
    event.sessionId.length +
    event.sessionKey.length +
    updateJson.length +
    (event.runId?.length ?? 0) +
    32
  );
}

function sourceIdentity(
  stat: Awaited<ReturnType<typeof fs.lstat>>,
  raw: string,
): LegacySourceIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    mtimeMs: stat.mtimeMs,
    sha256: createHash("sha256").update(raw).digest("hex"),
    size: stat.size,
  };
}

function sourceIdentityMatches(left: LegacySourceIdentity, right: LegacySourceIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

function reconcileCanonicalSession(db: DatabaseSync, session: LegacyAcpReplaySession): boolean {
  const stored = db
    .prepare(
      `SELECT session_key, cwd, complete, created_at, updated_at, next_seq, estimated_bytes
         FROM acp_replay_sessions
        WHERE session_id = ?`,
    )
    .get(session.sessionId) as
    | {
        session_key: string;
        cwd: string;
        complete: number | bigint;
        created_at: number | bigint;
        updated_at: number | bigint;
        next_seq: number | bigint;
        estimated_bytes: number | bigint;
      }
    | undefined;
  if (
    !stored ||
    stored.session_key !== session.sessionKey ||
    stored.cwd !== session.cwd ||
    Number(stored.complete) !== (session.complete ? 1 : 0) ||
    Number(stored.created_at) !== session.createdAt ||
    Number(stored.updated_at) !== session.updatedAt ||
    Number(stored.next_seq) !== session.nextSeq
  ) {
    return false;
  }

  const storedEvents = db
    .prepare(
      `SELECT seq, at, session_key, run_id, update_json, estimated_bytes
         FROM acp_replay_events
        WHERE session_id = ?
        ORDER BY seq ASC`,
    )
    .all(session.sessionId) as Array<{
    seq: number | bigint;
    at: number | bigint;
    session_key: string;
    run_id: string | null;
    update_json: string;
    estimated_bytes: number | bigint;
  }>;
  if (storedEvents.length !== session.events.length) {
    return false;
  }

  const expectedEventBytes: number[] = [];
  for (const [index, event] of session.events.entries()) {
    const storedEvent = storedEvents[index];
    if (!storedEvent) {
      return false;
    }
    let storedUpdate: unknown;
    try {
      storedUpdate = JSON.parse(storedEvent.update_json);
    } catch {
      return false;
    }
    if (
      Number(storedEvent.seq) !== event.seq ||
      Number(storedEvent.at) !== event.at ||
      storedEvent.session_key !== event.sessionKey ||
      storedEvent.run_id !== (event.runId ?? null) ||
      !isDeepStrictEqual(storedUpdate, event.update)
    ) {
      return false;
    }
    expectedEventBytes.push(estimateEventBytes(event, JSON.stringify(event.update)));
  }

  const updateEventBytes = db.prepare(
    `UPDATE acp_replay_events
        SET estimated_bytes = ?
      WHERE session_id = ? AND seq = ?`,
  );
  for (const [index, event] of session.events.entries()) {
    const expectedBytes = expectedEventBytes[index];
    if (
      expectedBytes !== undefined &&
      Number(storedEvents[index]?.estimated_bytes) !== expectedBytes
    ) {
      updateEventBytes.run(expectedBytes, session.sessionId, event.seq);
    }
  }
  const expectedSessionBytes =
    estimateSessionBytes(session) + expectedEventBytes.reduce((sum, value) => sum + value, 0);
  if (Number(stored.estimated_bytes) !== expectedSessionBytes) {
    db.prepare("UPDATE acp_replay_sessions SET estimated_bytes = ? WHERE session_id = ?").run(
      expectedSessionBytes,
      session.sessionId,
    );
  }
  return true;
}

/** Import, verify, and remove the retired JSON ledger during explicit doctor repair. */
export async function migrateLegacyAcpReplayLedger(params: {
  detected: LegacyStateDetection["acpReplayLedger"];
  stateDir: string;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!params.detected.hasLegacy) {
    return { changes, warnings };
  }

  try {
    const result = await withFileLock(
      params.detected.sourcePath,
      LEGACY_LEDGER_LOCK_OPTIONS,
      async () => {
        const claimPath = resolveLegacyAcpReplayClaimPath(params.detected.sourcePath);
        const resumedClaim = fsSync.existsSync(claimPath);
        const activePath = resumedClaim ? claimPath : params.detected.sourcePath;
        const before = await fs.lstat(activePath);
        if (!before.isFile() || before.isSymbolicLink()) {
          throw new Error("legacy ACP replay source is not a regular non-symlink file");
        }
        const raw = await fs.readFile(activePath, "utf8");
        const identity = sourceIdentity(before, raw);
        const sessions = parseLegacyLedger(raw);
        let importedSessions = 0;
        let importedEvents = 0;
        let retainedSessions = 0;
        let claimedThisRun = false;

        try {
          if (!resumedClaim) {
            await fs.rename(params.detected.sourcePath, claimPath);
            claimedThisRun = true;
            const claimedStat = await fs.lstat(claimPath);
            const claimedRaw = await fs.readFile(claimPath, "utf8");
            if (!sourceIdentityMatches(identity, sourceIdentity(claimedStat, claimedRaw))) {
              throw new Error("legacy ACP replay source changed while doctor was claiming it");
            }
          }

          runOpenClawStateWriteTransaction(
            ({ db }) => {
              const sessionExists = db.prepare(
                "SELECT 1 FROM acp_replay_sessions WHERE session_id = ?",
              );
              const insertSession = db.prepare(
                `INSERT INTO acp_replay_sessions (
                   session_id, session_key, cwd, complete, created_at, updated_at, next_seq,
                   estimated_bytes
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              );
              const insertEvent = db.prepare(
                `INSERT INTO acp_replay_events (
                   session_id, seq, at, session_key, run_id, update_json, estimated_bytes
                 ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              );
              const updateSessionBytes = db.prepare(
                "UPDATE acp_replay_sessions SET estimated_bytes = ? WHERE session_id = ?",
              );
              const missingSessions: LegacyAcpReplaySession[] = [];
              for (const session of sessions) {
                if (sessionExists.get(session.sessionId)) {
                  if (!reconcileCanonicalSession(db, session)) {
                    throw new Error(
                      `canonical ACP replay session ${session.sessionId} conflicts with the legacy source`,
                    );
                  }
                  retainedSessions += 1;
                  continue;
                }
                missingSessions.push(session);
              }

              for (const session of missingSessions) {
                let estimatedBytes = estimateSessionBytes(session);
                insertSession.run(
                  session.sessionId,
                  session.sessionKey,
                  session.cwd,
                  session.complete ? 1 : 0,
                  session.createdAt,
                  session.updatedAt,
                  session.nextSeq,
                  estimatedBytes,
                );
                for (const event of session.events) {
                  const updateJson = JSON.stringify(event.update);
                  const eventBytes = estimateEventBytes(event, updateJson);
                  insertEvent.run(
                    event.sessionId,
                    event.seq,
                    event.at,
                    event.sessionKey,
                    event.runId ?? null,
                    updateJson,
                    eventBytes,
                  );
                  estimatedBytes += eventBytes;
                  importedEvents += 1;
                }
                updateSessionBytes.run(estimatedBytes, session.sessionId);
                if (!reconcileCanonicalSession(db, session)) {
                  throw new Error(
                    `failed verifying imported ACP replay session ${session.sessionId}`,
                  );
                }
                importedSessions += 1;
              }
            },
            { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
          );
          await fs.unlink(claimPath);
          return {
            importedSessions,
            importedEvents,
            retainedSessions,
            pendingSource: fsSync.existsSync(params.detected.sourcePath),
          };
        } catch (error) {
          if (claimedThisRun && !fsSync.existsSync(params.detected.sourcePath)) {
            await fs.rename(claimPath, params.detected.sourcePath).catch(() => {});
          }
          throw error;
        }
      },
    );
    changes.push(
      `Migrated ${result.importedSessions} ACP replay session(s) and ${result.importedEvents} event(s) → shared SQLite state`,
    );
    if (result.retainedSessions > 0) {
      changes.push(
        `Kept ${result.retainedSessions} existing ACP replay session(s) from shared SQLite state`,
      );
    }
    changes.push(`Removed retired ACP replay ledger ${params.detected.sourcePath}`);
    if (result.pendingSource) {
      warnings.push(
        `A newer ACP replay ledger remains at ${params.detected.sourcePath}; rerun doctor to migrate it`,
      );
    }
  } catch (error) {
    warnings.push(
      `Failed migrating legacy ACP replay ledger ${params.detected.sourcePath}: ${String(error)}`,
    );
  }
  return { changes, warnings };
}
