import { note } from "../../packages/terminal-core/src/note.js";
import { scanDoctorSessionEntriesTolerant } from "../config/sessions/session-accessor.js";
import { hasLegacySessionEntryState } from "../config/sessions/session-entry-state-format.js";
import { stripRuntimeOnlySessionSkillsFields } from "../config/sessions/store-entry-shape.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  listExistingAgentDatabaseTargets,
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
import { migrateLegacySessionEntryState } from "./doctor/shared/session-entry-shape.js";

export type SessionDeliveryStateRepairReport = {
  found: number;
  repaired: number;
  scannedStores: number;
};

/** Scan or rewrite legacy delivery fields inside existing session row JSON. */
export function repairCanonicalSessionDeliveryStates(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targets?: readonly ExistingAgentDatabaseTarget[];
}): SessionDeliveryStateRepairReport {
  return repairCanonicalSessionEntries({
    ...params,
    transform: normalizeLegacySessionEntryDelivery,
    updateDeliveryProjection: true,
  });
}

export function repairCanonicalSessionResolvedSkills(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  targets?: readonly ExistingAgentDatabaseTarget[];
}): SessionDeliveryStateRepairReport {
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
  transform: (entry: SessionEntry, sessionKey: string, phase: "scan" | "repair") => SessionEntry;
  updateDeliveryProjection: boolean;
};

type PreparedSessionEntryRepairParams =
  | (SessionEntryRepairParams & { source: "canonical" })
  | (Omit<SessionEntryRepairParams, "transform"> & {
      source: "raw";
      rawNeedsRepair: (entry: Record<string, unknown>) => boolean;
      rawTransform: (
        entry: Record<string, unknown>,
        sessionKey: string,
        updatedAt: number,
      ) => Record<string, unknown>;
      deferSchemaRepair?: boolean;
    });

function prepareSessionEntryRepairs(params: PreparedSessionEntryRepairParams) {
  const targets = params.targets ?? listExistingAgentDatabaseTargets(params.cfg, params.env);
  const pending = targets.flatMap((target) => {
    const sessionKeys: string[] = [];
    const scope = { agentId: target.agentId, env: params.env, storePath: target.sqlitePath };
    const scan = () => {
      const identity = readDatabasePathIdentitySync(target.sqlitePath);
      if (params.source === "raw") {
        scanDoctorSessionEntryRecords(
          scope,
          ({ entry, sessionKey }) => {
            if (params.rawNeedsRepair(entry)) {
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
      return operation.ok && sessionKeys.length > 0 ? [operation.value] : [];
    } catch (error) {
      if (
        params.source === "raw" &&
        params.deferSchemaRepair &&
        (error instanceof SqliteSchemaMismatchError ||
          error instanceof OpenClawAgentDatabaseMediaMigrationRequiredError)
      ) {
        note(
          `- Session entry inspection awaits its database schema repair: ${formatErrorMessage(error)}`,
          "Session SQLite",
        );
        return [];
      }
      throw error;
    }
  });
  return {
    targets,
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
): SessionDeliveryStateRepairReport {
  const plan = prepareSessionEntryRepairs({ ...params, source: "canonical" });
  return {
    found: plan.found,
    repaired: params.apply ? plan.apply() : 0,
    scannedStores: plan.scannedStores,
  };
}

/** Raw repair and its backup precede all canonical session readers. */
export async function repairLegacySessionEntryStates(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  authority?: DoctorSqliteMaintenanceAuthority;
  targets?: readonly ExistingAgentDatabaseTarget[];
  deferSchemaRepair?: boolean;
}): Promise<SessionDeliveryStateRepairReport> {
  try {
    const plan = prepareSessionEntryRepairs({
      ...params,
      source: "raw",
      rawNeedsRepair: hasLegacySessionEntryState,
      rawTransform: (entry, _sessionKey, updatedAt) =>
        hasLegacySessionEntryState(entry)
          ? migrateLegacySessionEntryState(entry, updatedAt)
          : entry,
      updateDeliveryProjection: false,
    });
    const report = { found: plan.found, repaired: 0, scannedStores: plan.scannedStores };
    if (!params.apply || plan.found === 0) {
      return report;
    }
    const maintenance = getOpenClawDatabaseMaintenanceScope();
    const authority =
      params.authority ??
      (maintenance?.ownsSchemaMaintenance
        ? { assertCurrent: () => maintenance.assertAdmission() }
        : undefined);
    if (!authority) {
      throw new Error("Session entry state repair requires Doctor maintenance ownership.");
    }
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
      databasePaths: plan.targets.map((target) => target.sqlitePath),
      authority: { assertCurrent },
    });
    assertCurrent();
    note(backup.changes.map((change) => `- ${change}`).join("\n"), "Session SQLite backups");
    report.repaired = plan.apply(assertTargetCurrent);
    for (const { target, scope, identity } of plan.pending) {
      assertTargetCurrent(target);
      scanDoctorSessionEntryRecords(
        scope,
        ({ entry, sessionKey }) => {
          if (hasLegacySessionEntryState(entry)) {
            throw new Error(
              `Legacy session state remains in ${sessionKey}; original rows are backed up. Resolve the remaining row repair before retrying Doctor.`,
            );
          }
        },
        identity,
      );
      assertTargetCurrent(target);
    }
    note(
      `- Canonicalized entry state for ${report.repaired} durable session row(s).`,
      "Session SQLite",
    );
    return report;
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
