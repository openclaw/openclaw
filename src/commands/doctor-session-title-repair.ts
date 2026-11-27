import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { INTERNAL_WAKE_TRANSCRIPT_PROMPTS } from "../auto-reply/heartbeat.js";
import {
  isSessionTranscriptProjectionUnavailableError,
  patchSessionEntryCore,
  readSessionTranscriptBoundedMessageTailPage,
  readSessionTranscriptMessageEventPage,
  scanDoctorSessionEntriesTolerant,
} from "../config/sessions/session-accessor.js";
import { SessionTranscriptColdError } from "../config/sessions/session-transcript-cold-error.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deriveGoalSessionTitle } from "../gateway/derive-goal-session-title.js";
import { projectSessionDisplayMessage } from "../gateway/session-display-projection.js";
import { hasExplicitSessionName } from "../gateway/session-title-state.js";
import {
  listExistingAgentDatabaseTargets,
  type ExistingAgentDatabaseTarget,
} from "../infra/session-sqlite-migration-readers.js";
import { prepareArtifactPreservingSqliteRead } from "../infra/sqlite-snapshot-source.js";
import { isIncognitoSessionKey, isSubagentSessionKey } from "../routing/session-key.js";
import { normalizeInputProvenance } from "../sessions/input-provenance.js";
import { getActiveOpenClawStateDatabaseReadSnapshotAsync } from "../state/openclaw-state-db-readonly.js";
import { runDoctorAgentDatabaseOperation } from "./doctor-agent-database-operation.js";
import type { DoctorSqliteMaintenanceAuthority } from "./doctor-sqlite-maintenance-lock.js";

// Snapshot of the title formatter before internal wakes were excluded (#179219).
// Its exec title collapsed whitespace and truncated at the preceding word boundary.
const legacyWakeTitleByPrompt = new Map<string, string>(
  Object.values(INTERNAL_WAKE_TRANSCRIPT_PROMPTS).map((prompt) => [
    prompt,
    prompt === INTERNAL_WAKE_TRANSCRIPT_PROMPTS.exec
      ? "[OpenClaw exec completion] Disable automatic completion…"
      : prompt,
  ]),
);
const legacyWakeTitles = new Set(legacyWakeTitleByPrompt.values());

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
      if (projected?.role === "user") {
        const provenance = normalizeInputProvenance(message?.provenance);
        if (provenance?.kind === "inter_session") {
          continue;
        }
        return {
          displayName: deriveGoalSessionTitle(projected.text) || undefined,
          legacyWakeTitle:
            provenance?.kind === "external_user"
              ? undefined
              : legacyWakeTitleByPrompt.get(projected.text),
        };
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

/** Repair historical titles while Doctor owns session maintenance. */
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
  await getActiveOpenClawStateDatabaseReadSnapshotAsync({ env: params.env });
  for (const target of params.targets ?? listExistingAgentDatabaseTargets(params.cfg, params.env)) {
    if (params.apply) {
      assertRepairAuthority();
    }
    report.scannedStores++;
    await prepareArtifactPreservingSqliteRead(target.sqlitePath);
    const scope = { agentId: target.agentId, storePath: target.storePath, env: params.env };
    const scan = runDoctorAgentDatabaseOperation({
      agentId: target.agentId,
      path: target.sqlitePath,
      run: () => {
        const sessions: Array<{
          sessionKey: string;
          sessionId: string;
          legacyWakeTitle?: string;
        }> = [];
        scanDoctorSessionEntriesTolerant(
          scope,
          ({ entry, sessionKey, recoveredFromProjections }) => {
            // A matching name only selects a candidate; the first transcript input must
            // corroborate the same historical wake before Doctor may clear it.
            const legacyWakeTitle = legacyWakeTitles.has(entry.displayName ?? "")
              ? entry.displayName
              : undefined;
            if (
              !recoveredFromProjections &&
              !entry.incognito &&
              !isIncognitoSessionKey(sessionKey) &&
              // Spawn owns child labels; its first user message is a runtime task envelope.
              !isSubagentSessionKey(sessionKey) &&
              !hasExplicitSessionName(
                legacyWakeTitle ? { ...entry, displayName: undefined } : entry,
              )
            ) {
              sessions.push({ sessionKey, sessionId: entry.sessionId, legacyWakeTitle });
            }
          },
        );
        return sessions;
      },
    });
    if (!scan.ok) {
      continue;
    }
    for (const { sessionKey, sessionId, legacyWakeTitle } of scan.value) {
      if (params.apply) {
        assertRepairAuthority();
      }
      try {
        const session = { ...scope, sessionKey, sessionId };
        const source = readLegacySessionTitle(session);
        if (legacyWakeTitle && source?.legacyWakeTitle !== legacyWakeTitle) {
          continue;
        }
        const title = source?.displayName;
        if (!title && !legacyWakeTitle) {
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
