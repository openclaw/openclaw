import { isDeepStrictEqual } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import { isRestartRecoveryTombstone } from "../config/sessions/lifecycle.js";
import { isNativeCommandSourceSessionKey } from "../config/sessions/native-command-source-session-key.js";
import {
  listSessionEntriesReadOnly,
  loadExactSessionEntryReadOnly,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  listExistingAgentDatabaseTargets,
  type ExistingAgentDatabaseTarget,
} from "../infra/session-sqlite-migration-readers.js";
import { restoreSessionWorktree } from "../sessions/session-worktree-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-maintenance-context.js";
import { runDoctorAgentDatabaseOperation } from "./doctor-agent-database-operation.js";

type ArchivedCommandSource = {
  target: ExistingAgentDatabaseTarget;
  key: string;
  sessionId: string;
  reason: string;
};

function isArchivedNativeCommandSource(sessionKey: string, entry: SessionEntry): boolean {
  return (
    entry.archivedAt !== undefined &&
    Boolean(entry.sessionId) &&
    isNativeCommandSourceSessionKey(sessionKey) &&
    !entry.pluginOwnerId &&
    !isRestartRecoveryTombstone(entry)
  );
}

/** Diagnose only exact native-command source lanes. */
export function detectArchivedNativeCommandSources(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): ArchivedCommandSource[] {
  const findings: ArchivedCommandSource[] = [];
  for (const target of listExistingAgentDatabaseTargets(params.cfg, params.env)) {
    const scan = runDoctorAgentDatabaseOperation({
      agentId: target.agentId,
      path: target.sqlitePath,
      run: () =>
        listSessionEntriesReadOnly({
          agentId: target.agentId,
          storePath: target.storePath,
          env: params.env,
          includeParticipants: false,
        }),
    });
    if (!scan.ok) {
      continue;
    }
    for (const { sessionKey, entry } of scan.value) {
      if (!isArchivedNativeCommandSource(sessionKey, entry)) {
        continue;
      }
      findings.push({
        target,
        key: sessionKey,
        sessionId: entry.sessionId,
        reason: entry.archiveReason ?? "unknown",
      });
    }
  }
  return findings.toSorted((a, b) => a.key.localeCompare(b.key));
}

export function noteArchivedNativeCommandSources(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): void {
  const findings = detectArchivedNativeCommandSources(params);
  if (findings.length === 0) {
    return;
  }
  note(
    [
      `${findings.length} archived native-command source session${findings.length === 1 ? "" : "s"} may block slash commands. This diagnostic does not restore them.`,
      ...findings.map(
        ({ key, sessionId, reason }) => `- ${key} (session ${sessionId}, reason ${reason})`,
      ),
      "Run standalone openclaw doctor --fix to restore these internal sources, or open Control UI → Sessions → Archived and restore an exact key. Unrelated archives are unaffected.",
    ].join("\n"),
    "Archived native commands",
  );
}

/** Explicit standalone repair runs only under Doctor's exclusive Gateway maintenance owner. */
export async function repairArchivedNativeCommandSources(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): Promise<{ found: number; repaired: number; skipped: number }> {
  const maintenance = getOpenClawDatabaseMaintenanceScope();
  if (!maintenance?.ownsSchemaMaintenance) {
    throw new Error("Native command archive repair requires Doctor maintenance ownership.");
  }
  const assertOwner = () => {
    maintenance.assertAdmission();
    maintenance.assertDatabaseAccess(resolveOpenClawStateSqlitePath(params.env));
  };
  assertOwner();
  const findings = detectArchivedNativeCommandSources(params);
  let repaired = 0;
  let skipped = 0;
  for (const finding of findings) {
    const scope = {
      agentId: finding.target.agentId,
      sessionKey: finding.key,
      storePath: finding.target.storePath,
      env: params.env,
    };
    try {
      assertOwner();
      const entry = loadExactSessionEntryReadOnly(scope)?.entry;
      if (
        !entry ||
        entry.sessionId !== finding.sessionId ||
        !isArchivedNativeCommandSource(finding.key, entry)
      ) {
        skipped++;
        continue;
      }
      const assertWorktree = await restoreSessionWorktree({
        entry,
        scope,
        commitGuard: assertOwner,
      });
      let committed = false;
      await patchSessionEntryCore(
        scope,
        (current) => {
          if (
            !isArchivedNativeCommandSource(finding.key, current) ||
            current.sessionId !== entry.sessionId ||
            current.lifecycleRevision !== entry.lifecycleRevision ||
            current.archivedAt !== entry.archivedAt ||
            !isDeepStrictEqual(current.worktree, entry.worktree)
          ) {
            return null;
          }
          const next = { ...current };
          delete next.archivedAt;
          delete next.archivedBy;
          delete next.archiveReason;
          return next;
        },
        {
          replaceEntry: true,
          preserveActivity: true,
          skipMaintenance: true,
          assertCommitAllowed: () => {
            assertOwner();
            assertWorktree();
          },
          onCommitted: () => {
            committed = true;
            repaired++;
          },
        },
      );
      assertOwner();
      if (!committed) {
        skipped++;
      }
    } catch (error) {
      assertOwner();
      skipped++;
      note(`- ${finding.key}: ${String(error)}`, "Native command restore skipped");
    }
  }
  if (findings.length > 0) {
    note(
      `Found ${findings.length} archived native-command source session(s); restored ${repaired}, skipped ${skipped}. Failed slash commands are not replayed.`,
      "Archived native commands",
    );
  }
  return { found: findings.length, repaired, skipped };
}
