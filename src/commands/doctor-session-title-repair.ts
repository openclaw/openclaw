import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  isSessionTranscriptProjectionUnavailableError,
  patchSessionEntryCore,
  readSessionTranscriptBoundedMessageTailPage,
  readSessionTranscriptMessageEventPage,
  scanDoctorSessionEntriesTolerant,
} from "../config/sessions/session-accessor.js";
import { SessionTranscriptColdError } from "../config/sessions/session-cold-storage-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deriveGoalSessionTitle } from "../gateway/derive-goal-session-title.js";
import { projectSessionDisplayMessage } from "../gateway/session-display-projection.js";
import { hasExplicitSessionName } from "../gateway/session-title-state.js";
import {
  listExistingAgentDatabaseTargets,
  type ExistingAgentDatabaseTarget,
} from "../infra/session-sqlite-migration-readers.js";
import { isIncognitoSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { hasInterSessionUserProvenance } from "../sessions/input-provenance.js";
import { runDoctorAgentDatabaseOperation } from "./doctor-agent-database-operation.js";
import type { DoctorSqliteMaintenanceAuthority } from "./doctor-sqlite-maintenance-lock.js";

function readLegacySessionTitle(
  scope: Parameters<typeof readSessionTranscriptBoundedMessageTailPage>[0],
) {
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
      const message = asOptionalRecord(asOptionalRecord(event.event)?.message);
      const projected = projectSessionDisplayMessage(message);
      if (projected?.role === "user" && !hasInterSessionUserProvenance(message)) {
        const displayName = deriveGoalSessionTitle(projected.text);
        return displayName || undefined;
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
}) {
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
  const warnings: string[] = [];
  const report = {
    found: 0,
    repaired: 0,
    scannedStores: 0,
    warnings,
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
        const sessions: Array<{ sessionKey: string; sessionId: string }> = [];
        scanDoctorSessionEntriesTolerant(
          scope,
          ({ entry, sessionKey, recoveredFromProjections }) => {
            if (
              !recoveredFromProjections &&
              !entry.incognito &&
              !isIncognitoSessionKey(sessionKey) &&
              // Spawn owns child labels; its first user message is a runtime task envelope.
              !isSubagentSessionKey(sessionKey) &&
              !hasExplicitSessionName(entry)
            ) {
              sessions.push({ sessionKey, sessionId: entry.sessionId });
            }
          },
        );
        return sessions;
      },
    });
    if (!scan.ok) {
      continue;
    }
    for (const { sessionKey, sessionId } of scan.value) {
      if (params.apply) {
        assertRepairAuthority();
      }
      try {
        const session = { ...scope, sessionKey, sessionId };
        const title = readLegacySessionTitle(session);
        if (!title) {
          continue;
        }
        report.found++;
        if (!params.apply) {
          continue;
        }
        // Offline Doctor owns these stores; concurrent title changes are best effort.
        await patchSessionEntryCore(session, () => ({ displayName: title }), {
          preserveActivity: true,
          skipMaintenance: true,
          assertCommitAllowed: assertRepairAuthority,
          onCommitted: () => {
            report.repaired++;
          },
        });
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
