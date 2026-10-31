import fs from "node:fs";
import path from "node:path";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  readDeferredPluginSessionImport,
  readStaleDeferredPluginSessionImport,
} from "../../infra/deferred-plugin-session-sources.js";
import { recordStartupMigrationWarnings } from "../../infra/state-migrations.messages.js";
import { formatDoctorStateRepairFailure } from "../../infra/state-repair-message.js";
import { readAgentDatabaseAdmissionRefusal } from "../../state/agent-database-admission.js";
import { createAgentDatabaseDeletionClassifier } from "../../state/agent-deletion-discovery.js";
import { readAgentDatabaseDeletionSnapshot } from "../../state/agent-deletion-journal.read.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  isLegacySessionRecordOwnedByTarget,
  listLegacySessionTranscriptFiles,
  readLegacySessionStoreEntries,
  shouldFilterLegacySessionRecordsByTarget,
} from "./legacy-store-inspection.js";
import { SessionStoreMigrationRequiredError } from "./migration-required.js";
import {
  resolveSqliteTargetFromSessionStorePath,
  type SessionStoreRegistryRead,
} from "./session-sqlite-target.js";
import {
  resolveAllAgentSessionStoreTargetsSync,
  resolveConfiguredAgentDatabaseTargets,
} from "./targets.js";

export function assertSessionStoreMigrationComplete(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  targets?: readonly { agentId?: string; storePath: string }[];
  registeredDatabases?: SessionStoreRegistryRead;
  operation?: "doctor";
}): void {
  const env = params.env ?? process.env;
  const readOptions = { env, registeredDatabases: params.registeredDatabases };
  const targets = (
    params.targets ?? resolveAllAgentSessionStoreTargetsSync(params.cfg, readOptions)
  ).filter(
    (target) => !target.agentId || !readAgentDatabaseAdmissionRefusal(target.agentId, { env }),
  );
  const sourcesByPath = new Map<string, typeof targets>();
  for (const target of targets) {
    const sourcePath = path.resolve(target.storePath);
    sourcesByPath.set(sourcePath, [...(sourcesByPath.get(sourcePath) ?? []), target]);
  }
  const legacySources = [...sourcesByPath].filter(
    ([storePath]) => !storePath.endsWith(".sqlite") && fs.existsSync(storePath),
  );
  if (legacySources.length === 0) {
    return;
  }
  const deletionSnapshot = readAgentDatabaseDeletionSnapshot(
    env,
    params.operation === "doctor" ? "maintenance" : "runtime",
  );
  const classifyDeletion =
    deletionSnapshot &&
    createAgentDatabaseDeletionClassifier({
      env,
      retainedDeletions: deletionSnapshot.retainedDeletions,
      registeredAgentDatabases: deletionSnapshot.registeredAgentDatabases,
      configuredAgentDatabaseTargets: resolveConfiguredAgentDatabaseTargets(
        params.cfg,
        readOptions,
      ),
    });
  const legacyStore = legacySources.find(([storePath, candidates]) => {
    type SourceOwner = {
      target: { agentId: string; storePath: string };
      destination: string;
      retained: boolean;
      imported: boolean;
    };
    const owners = new Map<string, SourceOwner>();
    for (const target of candidates) {
      if (!target.agentId) {
        return true;
      }
      const destination = resolveSqliteTargetFromSessionStorePath(target.storePath, {
        agentId: target.agentId,
        ...readOptions,
      }).path;
      const deletion =
        classifyDeletion?.(storePath, target.agentId) ??
        classifyDeletion?.(destination, target.agentId);
      const staleImport = readStaleDeferredPluginSessionImport({
        target: { ...target, agentId: target.agentId },
        sqlitePath: destination,
        env,
      });
      if (staleImport) {
        recordStartupMigrationWarnings([
          `Session import receipt belongs to another database; serving live SQLite at ${destination}. Run openclaw doctor --fix to recover retained history.`,
        ]);
      }
      // A foreign receipt leaves recovery inputs protected, not a migration veto on this database.
      const retained =
        (deletion !== undefined && deletion !== "unavailable") || Boolean(staleImport);
      owners.set(`${target.agentId}\0${destination}`, {
        target: { ...target, agentId: target.agentId },
        destination,
        retained,
        imported:
          !retained &&
          readDeferredPluginSessionImport({
            cfg: params.cfg,
            target: { ...target, agentId: target.agentId },
            sqlitePath: destination,
            env,
            purpose: "readiness",
          }) !== undefined,
      });
    }
    // A shared path still needs record-level ownership even when every candidate is held.
    if (
      [...owners.values()].every(
        ({ target, retained, imported }) =>
          (imported || retained) && !shouldFilterLegacySessionRecordsByTarget(target),
      )
    ) {
      return false;
    }
    // A roster entry is only a possible importer. Inspect retained source ownership
    // here, never in runtime session access, and bind parsed bytes to every receipt.
    const issues: Array<{ code: string; message: string; sessionKey?: string }> = [];
    const source = readLegacySessionStoreEntries({ storePath }, issues);
    if (issues.some((issue) => issue.code !== "entry_invalid") || !source.bytes) {
      return [...owners.values()].some(({ imported, retained }) => !imported && !retained);
    }
    // Empty indexes may have unindexed history: retain the existing requirement
    // for every named owner's verified receipt rather than infer ownership here.
    const required = new Set<SourceOwner>(source.entries.length === 0 ? owners.values() : []);
    for (const sessionKey of [
      ...source.entries.map((entry) => entry.sessionKey),
      ...issues.flatMap((issue) => (issue.sessionKey ? [issue.sessionKey] : [])),
    ]) {
      const matches = [...owners.values()].filter(
        ({ target }) =>
          !shouldFilterLegacySessionRecordsByTarget(target) ||
          isLegacySessionRecordOwnedByTarget(params.cfg, target, sessionKey),
      );
      if (matches.length !== 1) {
        return true;
      }
      required.add(matches[0]!);
    }
    let hasUnindexedHistory: boolean | undefined;
    return [...required].some(({ target, destination, retained, imported }) => {
      if (
        imported ||
        (retained &&
          (source.entries.length > 0 || !shouldFilterLegacySessionRecordsByTarget(target)))
      ) {
        return false;
      }
      // Owners without a database cannot have completed a core session import.
      // Without a receipt or unindexed history, demanding one deadlocks startup:
      // Doctor refuses to create a database just for the receipt.
      if (source.entries.length === 0 && !fs.existsSync(destination)) {
        hasUnindexedHistory ??=
          listLegacySessionTranscriptFiles(path.dirname(storePath)).length > 0;
        if (!hasUnindexedHistory) {
          return false;
        }
      }
      return true;
    });
  })?.[0];
  if (legacyStore) {
    throw new SessionStoreMigrationRequiredError(
      params.operation === "doctor"
        ? formatDoctorStateRepairFailure(
            `Legacy session store requires migration at ${legacyStore}`,
            "Repair the retained source using the migration report's named file and validation error, preserving the original history.",
          )
        : `Legacy session store requires migration: ${legacyStore}. Run "${formatCliCommand("openclaw doctor --fix", env)}" against the same state/config before starting OpenClaw.`,
    );
  }
}
