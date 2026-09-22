import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isSessionTranscriptProjectionUnavailableError,
  loadSessionEntry,
  patchSessionEntryCore,
  readSessionTranscriptBoundedMessageTailPage,
  readSessionTranscriptMessageEventPage,
  readSessionTranscriptWatermark,
  scanDoctorSessionEntriesTolerant,
} from "../config/sessions/session-accessor.js";
import { SessionTranscriptColdError } from "../config/sessions/session-cold-storage-state.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deriveGoalSessionTitle } from "../gateway/derive-goal-session-title.js";
import { projectSessionDisplayMessage } from "../gateway/session-display-projection.js";
import { hasExplicitSessionName, sessionTitleRequests } from "../gateway/session-title-state.js";
import { sqliteMessageEventWithSeq } from "../gateway/session-transcript-entry-message.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { runDoctorAgentDatabaseOperation } from "./doctor-agent-database-operation.js";
import {
  listExistingAgentDatabaseTargets,
  type ExistingAgentDatabaseTarget,
} from "./doctor-session-sqlite-readers.js";
import type { DoctorSqliteMaintenanceAuthority } from "./doctor-sqlite-maintenance-lock.js";

type SessionTitleRepairScope = {
  agentId: string;
  storePath: string;
  sessionKey: string;
  sessionId: string;
  sessionEntry: SessionEntry;
  env: NodeJS.ProcessEnv;
};

export type SessionTitleRepairReport = {
  found: number;
  repaired: number;
  scannedStores: number;
  warnings: string[];
};

function readLegacySessionTitle(scope: SessionTitleRepairScope) {
  try {
    const { totalMessages } = readSessionTranscriptMessageEventPage(scope, {
      maxMessages: 0,
      offset: 0,
    });
    if (!totalMessages) {
      return undefined;
    }
    const head = readSessionTranscriptBoundedMessageTailPage(scope, {
      maxMessages: 100,
      maxBytes: 64 * 1024,
      offset: Math.max(0, totalMessages - 100),
    });
    // A skipped first message must not let a later task become the session title.
    if (head.totalMessages !== totalMessages || head.events.length !== head.scannedMessages) {
      return undefined;
    }
    for (const event of head.events) {
      const message = asOptionalRecord(sqliteMessageEventWithSeq(event));
      const projected = projectSessionDisplayMessage(message);
      if (projected?.role === "user" && !hasInterSessionUserProvenance(message)) {
        const displayName = deriveGoalSessionTitle(projected.text);
        return displayName
          ? { displayName, generation: head.snapshot.generation ?? null }
          : undefined;
      }
    }
    return undefined;
  } catch (error) {
    if (
      isSessionTranscriptProjectionUnavailableError(error) ||
      error instanceof SessionTranscriptColdError
    ) {
      return undefined;
    }
    throw error;
  }
}

/** Derive missing historical titles while Doctor owns session maintenance. */
export async function repairLegacySessionTitles(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  apply: boolean;
  authority?: DoctorSqliteMaintenanceAuthority;
  targets?: readonly ExistingAgentDatabaseTarget[];
}): Promise<SessionTitleRepairReport> {
  const authority = params.authority;
  const assertRepairAuthority = () => {
    if (!authority) {
      throw new Error("Session title repair requires Doctor maintenance ownership.");
    }
    authority.assertCurrent();
  };
  if (params.apply) {
    assertRepairAuthority();
  }
  const report: SessionTitleRepairReport = {
    found: 0,
    repaired: 0,
    scannedStores: 0,
    warnings: [],
  };
  for (const target of params.targets ?? listExistingAgentDatabaseTargets(params.cfg, params.env)) {
    if (params.apply) {
      assertRepairAuthority();
    }
    report.scannedStores++;
    const scope = { agentId: target.agentId, storePath: target.storePath, env: params.env };
    const scan = runDoctorAgentDatabaseOperation({
      agentId: target.agentId,
      path: target.sqlitePath,
      run: () => {
        const keys: string[] = [];
        scanDoctorSessionEntriesTolerant(
          scope,
          ({ entry, sessionKey, recoveredFromProjections }) => {
            if (
              !recoveredFromProjections &&
              !entry.incognito &&
              !isIncognitoSessionKey(sessionKey) &&
              entry.status !== "running" &&
              !hasExplicitSessionName(entry)
            ) {
              keys.push(sessionKey);
            }
          },
        );
        return keys;
      },
    });
    if (!scan.ok) {
      continue;
    }
    for (const sessionKey of scan.value) {
      if (params.apply) {
        assertRepairAuthority();
      }
      try {
        const entry = loadSessionEntry({ ...scope, sessionKey });
        if (
          !entry ||
          entry.incognito ||
          entry.status === "running" ||
          hasExplicitSessionName(entry)
        ) {
          continue;
        }
        const session = { ...scope, sessionKey, sessionId: entry.sessionId, sessionEntry: entry };
        if (sessionTitleRequests.get(session)) {
          continue;
        }
        const title = readLegacySessionTitle(session);
        if (!title) {
          continue;
        }
        report.found++;
        if (!params.apply) {
          continue;
        }
        await patchSessionEntryCore(
          session,
          (current) =>
            current.sessionId === entry.sessionId &&
            current.lifecycleRevision === entry.lifecycleRevision &&
            current.status !== "running" &&
            !current.incognito &&
            !hasExplicitSessionName(current)
              ? { displayName: Buffer.from(title.displayName, "utf16le").toString("utf16le") }
              : null,
          {
            preserveActivity: true,
            skipMaintenance: true,
            assertCommitAllowed: assertRepairAuthority,
            shouldCommit: () =>
              !sessionTitleRequests.get(session) &&
              readSessionTranscriptWatermark(session).generation === title.generation,
            onCommitted: () => {
              report.repaired++;
            },
          },
        );
        assertRepairAuthority();
      } catch (error) {
        if (params.apply) {
          assertRepairAuthority();
        }
        report.warnings.push(`Could not repair the title for ${sessionKey}: ${String(error)}`);
      }
    }
  }
  return report;
}
