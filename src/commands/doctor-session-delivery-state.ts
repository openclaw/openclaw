import { note } from "../../packages/terminal-core/src/note.js";
import { scanDoctorSessionEntriesTolerant } from "../config/sessions/session-accessor.js";
import { SESSION_ENTRY_NUMERIC_FIELDS } from "../config/sessions/session-entry-numeric-snapshot.js";
import {
  hasLegacySessionEntryState,
  hasLegacySessionProviderState,
} from "../config/sessions/session-entry-state-format.js";
import { stripRuntimeOnlySessionSkillsFields } from "../config/sessions/store-entry-shape.js";
import { resolveAllAgentSessionStoreCandidateTargetsSync } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  projectExistingAgentDatabaseTargets,
  type ExistingAgentDatabaseTarget,
} from "../infra/session-sqlite-migration-readers.js";
import { SqliteSchemaMismatchError } from "../infra/sqlite-schema-issues.js";
import {
  assertExistingDatabaseIdentity,
  readDatabasePathIdentitySync,
} from "../infra/sqlite-worker-identity.js";
import { normalizeLegacySessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import {
  createLegacyStateMigrationStepReceipt,
  DoctorStateMigrationRefusalError,
} from "../infra/state-migrations.messages.js";
import { AgentDatabaseMaintenanceRequiredError } from "../state/openclaw-agent-db-maintenance-authority.js";
import { OpenClawAgentDatabaseMediaMigrationRequiredError } from "../state/openclaw-agent-db-migration-required.js";
import {
  closeOpenClawAgentDatabaseByPath,
  isOpenClawAgentDatabaseOpen,
} from "../state/openclaw-agent-db.js";
import { getOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { runDoctorAgentDatabaseOperation } from "./doctor-agent-database-operation.js";
import { backupDoctorSqliteDatabases } from "./doctor-migration-backup.js";
import type { DoctorSqliteMaintenanceAuthority } from "./doctor-sqlite-maintenance-lock.js";
import {
  rewriteDoctorSessionEntries,
  scanDoctorSessionEntryRecords,
} from "./doctor/shared/session-entry-rewrite.js";
import {
  inspectLegacyRestartTombstone,
  migrateLegacySessionEntryState,
  type SessionEntryStateRepair,
} from "./doctor/shared/session-entry-shape.js";

export type SessionDeliveryStateRepairReport = ReturnType<typeof repairCanonicalSessionEntries>;

type CanonicalSessionRepairOptions = Omit<
  Parameters<typeof repairCanonicalSessionEntries>[0],
  "transform" | "updateDeliveryProjection"
>;

/** Scan or rewrite legacy delivery fields inside existing session row JSON. */
export function repairCanonicalSessionDeliveryStates(params: CanonicalSessionRepairOptions) {
  return repairCanonicalSessionEntries({
    ...params,
    transform: normalizeLegacySessionEntryDelivery,
    updateDeliveryProjection: true,
  });
}

export function repairCanonicalSessionResolvedSkills(params: CanonicalSessionRepairOptions) {
  return repairCanonicalSessionEntries({
    ...params,
    transform: stripRuntimeOnlySessionSkillsFields,
    updateDeliveryProjection: false,
  });
}

type SessionEntryRepairParams = {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targets?: readonly ExistingAgentDatabaseTarget[];
  registeredDatabases?: readonly { agentId: string; path: string }[];
  excludedDatabasePaths?: ReadonlySet<string>;
  integrityCheck?: "quick" | "full";
  transform: (entry: SessionEntry, sessionKey: string, phase: "scan" | "repair") => SessionEntry;
  updateDeliveryProjection: boolean;
};

type PreparedSessionEntryRepairParams =
  | (SessionEntryRepairParams & { source: "canonical" })
  | (Omit<SessionEntryRepairParams, "transform"> & {
      source: "raw";
      rawNeedsRepair: (entry: Record<string, unknown>, sessionKey: string) => boolean;
      rawTransform: (
        entry: Record<string, unknown>,
        sessionKey: string,
        updatedAt: number,
      ) => SessionEntryStateRepair;
      deferSchemaRepair?: boolean;
      deferToMediaPreparation?: boolean;
    });

function prepareSessionEntryRepairs(params: PreparedSessionEntryRepairParams) {
  const targets = (
    params.targets ??
    projectExistingAgentDatabaseTargets(
      resolveAllAgentSessionStoreCandidateTargetsSync(params.cfg, {
        env: params.env,
        ...(params.registeredDatabases ? { registeredDatabases: params.registeredDatabases } : {}),
      }),
      params.env,
      params.cfg,
    )
  ).filter((target) => !params.excludedDatabasePaths?.has(target.sqlitePath));
  const inspectedTargets: Array<ExistingAgentDatabaseTarget & { canonicalPath: string }> = [];
  const pending = targets.flatMap((target) => {
    const sessionKeys: string[] = [];
    const scope = { agentId: target.agentId, env: params.env, storePath: target.sqlitePath };
    const scan = () => {
      const identity = readDatabasePathIdentitySync(target.sqlitePath);
      if (params.source === "raw") {
        scanDoctorSessionEntryRecords(
          scope,
          ({ entry, sessionKey }) => {
            if (params.rawNeedsRepair(entry, sessionKey)) {
              sessionKeys.push(sessionKey);
            }
          },
          identity,
        );
      } else {
        scanDoctorSessionEntriesTolerant(
          scope,
          ({ entry, recoveredFromProjections, sessionKey }) => {
            if (
              !recoveredFromProjections &&
              params.transform(entry, sessionKey, "scan") !== entry
            ) {
              sessionKeys.push(sessionKey);
            }
          },
        );
      }
      assertExistingDatabaseIdentity(target.sqlitePath, identity.key, identity.birthtime);
      return { target, scope, sessionKeys, identity };
    };
    try {
      const operation =
        params.source === "raw"
          ? { ok: true, value: scan() }
          : runDoctorAgentDatabaseOperation({
              agentId: target.agentId,
              path: target.sqlitePath,
              run: scan,
            });
      if (!operation.ok) {
        return [];
      }
      inspectedTargets.push({
        ...target,
        canonicalPath: operation.value.identity.canonicalPath,
      });
      return sessionKeys.length > 0 ? [operation.value] : [];
    } catch (error) {
      if (
        params.source === "raw" &&
        (params.deferToMediaPreparation ||
          (params.deferSchemaRepair &&
            (error instanceof SqliteSchemaMismatchError ||
              error instanceof AgentDatabaseMaintenanceRequiredError ||
              error instanceof OpenClawAgentDatabaseMediaMigrationRequiredError)))
      ) {
        const owner = params.deferToMediaPreparation
          ? "media database preparation"
          : "database schema repair";
        note(
          `- Session entry inspection awaits ${owner}: ${formatErrorMessage(error)}`,
          "Session SQLite",
        );
        return [];
      }
      throw error;
    }
  });
  return {
    targets,
    inspectedTargets,
    pending,
    found: pending.reduce((count, item) => count + item.sessionKeys.length, 0),
    scannedStores: targets.length,
    apply(assertCurrent?: (target: ExistingAgentDatabaseTarget) => void): number {
      let repaired = 0;
      for (const { target, scope, sessionKeys, identity } of pending) {
        const wasOpen = isOpenClawAgentDatabaseOpen(target.sqlitePath);
        try {
          repaired += rewriteDoctorSessionEntries({
            scope,
            sessionKeys,
            integrityCheck: params.integrityCheck ?? "quick",
            ...(params.source === "raw"
              ? { rawTransform: params.rawTransform }
              : {
                  transform: (entry: SessionEntry, sessionKey: string) =>
                    params.transform(entry, sessionKey, "repair"),
                }),
            expectedIdentity: identity,
            updateDeliveryProjection: params.updateDeliveryProjection,
            ...(assertCurrent ? { assertCurrent: () => assertCurrent(target) } : {}),
          });
        } finally {
          if (!wasOpen) {
            closeOpenClawAgentDatabaseByPath(target.sqlitePath);
          }
        }
      }
      return repaired;
    },
  };
}

export function repairCanonicalSessionEntries(
  params: SessionEntryRepairParams & { apply: boolean },
) {
  const plan = prepareSessionEntryRepairs({ ...params, source: "canonical" });
  return {
    found: plan.found,
    repaired: params.apply ? plan.apply() : 0,
    scannedStores: plan.scannedStores,
  };
}

function needsLegacySessionEntryRepair(entry: Record<string, unknown>): boolean {
  return (
    hasLegacySessionEntryState(entry) ||
    inspectLegacyRestartTombstone(entry)?.retire ||
    SESSION_ENTRY_NUMERIC_FIELDS.some((field) => typeof entry[field] === "string")
  );
}

/** Raw repair and its backup precede all canonical session readers. */
export async function repairLegacySessionEntryStates(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  authority?: DoctorSqliteMaintenanceAuthority;
  targets?: readonly ExistingAgentDatabaseTarget[];
  registeredDatabases?: readonly { agentId: string; path: string }[];
  excludedDatabasePaths?: ReadonlySet<string>;
  deferSchemaRepair?: boolean;
  deferToMediaPreparation?: boolean;
  integrityCheck?: "quick" | "full";
  onInspectedTargets?: (
    targets: readonly (ExistingAgentDatabaseTarget & { canonicalPath: string })[],
  ) => void;
}): Promise<SessionDeliveryStateRepairReport> {
  try {
    const recoveredTombstones = new Set<string>();
    const retainedWarnings = new Map<string, string>();
    const reportRetained = () => {
      for (const [sessionKey, warning] of retainedWarnings) {
        note(`${sessionKey}: ${warning}`, "Session recovery warning");
      }
    };
    const plan = prepareSessionEntryRepairs({
      ...params,
      source: "raw",
      rawNeedsRepair: (entry, sessionKey) => {
        const tombstone = inspectLegacyRestartTombstone(entry);
        if (tombstone && !tombstone.retire) {
          retainedWarnings.set(sessionKey, tombstone.warning);
        }
        return needsLegacySessionEntryRepair(entry);
      },
      rawTransform: (entry, sessionKey, updatedAt) => {
        if (!needsLegacySessionEntryRepair(entry)) {
          return { entry };
        }
        const next = migrateLegacySessionEntryState(entry, updatedAt);
        const tombstone = inspectLegacyRestartTombstone(entry);
        retainedWarnings.delete(sessionKey);
        if (tombstone?.retire) {
          recoveredTombstones.add(sessionKey);
        } else if (tombstone) {
          retainedWarnings.set(sessionKey, tombstone.warning);
        }
        return {
          ...next,
          entry: hasLegacySessionProviderState(entry)
            ? normalizeLegacySessionEntryDelivery(next.entry)
            : next.entry,
        };
      },
      updateDeliveryProjection: true,
    });
    const report = { found: plan.found, repaired: 0, scannedStores: plan.scannedStores };
    if (!params.apply || plan.found === 0) {
      reportRetained();
      params.onInspectedTargets?.(plan.inspectedTargets);
      return report;
    }
    const runWithAuthority = async (authority: DoctorSqliteMaintenanceAuthority) => {
      const identities = new Map(plan.pending.map(({ target, identity }) => [target, identity]));
      const assertTargetCurrent = (target: ExistingAgentDatabaseTarget) => {
        authority.assertCurrent();
        const identity = identities.get(target)!;
        assertExistingDatabaseIdentity(target.sqlitePath, identity.key, identity.birthtime);
      };
      const assertCurrent = () => {
        for (const target of identities.keys()) {
          assertTargetCurrent(target);
        }
      };
      assertCurrent();
      const backup = await backupDoctorSqliteDatabases({
        env: params.env,
        pendingDatabasePaths: plan.pending.map(({ target }) => target.sqlitePath),
        databasePaths: (params.deferToMediaPreparation ? plan.inspectedTargets : plan.targets).map(
          (target) => target.sqlitePath,
        ),
        authority: { assertCurrent },
      });
      assertCurrent();
      note(backup.changes.map((change) => `- ${change}`).join("\n"), "Session SQLite backups");
      report.repaired = plan.apply(assertTargetCurrent);
      reportRetained();
      for (const sessionKey of recoveredTombstones) {
        note(
          `Recovered legacy restart tombstone for ${sessionKey}; obsolete claims and pending delivery retired (original state backed up).`,
          "Session recovery warning",
        );
      }
      params.onInspectedTargets?.(plan.inspectedTargets);
      note(
        `- Canonicalized entry state for ${report.repaired} durable session row(s).`,
        "Session SQLite",
      );
      return report;
    };
    const maintenance = getOpenClawDatabaseMaintenanceScope();
    const authority =
      params.authority ??
      (maintenance?.ownsSchemaMaintenance
        ? { assertCurrent: () => maintenance.assertAdmission() }
        : undefined);
    if (authority) {
      return await runWithAuthority(authority);
    }
    const { withDoctorSqliteMaintenanceLock } = await import("./doctor-sqlite-maintenance-lock.js");
    return await withDoctorSqliteMaintenanceLock({
      env: params.env,
      operation: "session entry state repair",
      run: runWithAuthority,
    });
  } catch (error) {
    const endpoints = [{ kind: "owner" as const, id: "session-entry-state" }];
    throw new DoctorStateMigrationRefusalError([
      createLegacyStateMigrationStepReceipt(
        {
          id: "session-entry-state",
          phase: "final",
          source: endpoints,
          target: endpoints,
          requiredness: "required",
          reversibility: "checkpoint-required",
        },
        { changes: [], warnings: [formatErrorMessage(error)] },
      ),
    ]);
  }
}
