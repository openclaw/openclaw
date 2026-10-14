/** Doctor-owned migration and repair of persisted generated provider catalogs. */
import { note } from "../../packages/terminal-core/src/note.js";
import { listAgentIds, resolveAgentDir, resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { repairPluginModelCatalogTransportMetadata } from "../agents/plugin-model-catalog-repair.js";
import {
  inspectLegacyPluginModelCatalogs,
  loadPersistedPluginModelCatalogsReadOnly,
  migrateLegacyPluginModelCatalogs,
  repairPersistedPluginModelCatalogs,
  type PluginModelCatalogMigrationIssue,
} from "../agents/plugin-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding } from "../flows/health-checks.js";
import type { RuntimeEnv } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

function catalogMigrationFinding(issue: PluginModelCatalogMigrationIssue): HealthFinding {
  const historical = issue.kind === "superseded-source" || issue.kind === "cleanup-failed";
  const fixHint =
    issue.kind === "conflicting-sources"
      ? "Keep every retained source. Compare their accounts and credentials with the current catalog before selecting an authoritative recovery source; do not overwrite either copy. Rerun openclaw doctor --fix after reconciling the conflict."
      : issue.kind === "superseded-source"
        ? "No cleanup is required merely because this older source was retained. Keep it for recovery and verify your expected accounts with openclaw models status."
        : issue.kind === "cleanup-failed"
          ? "The catalog was verified in SQLite, but its source could not be removed. Keep the source, correct its directory permissions, and rerun openclaw doctor --fix to retry cleanup. Verify current accounts with openclaw models status."
          : "Keep the retained catalog sources and recovery copy. Correct the reported source access or concurrent-writer problem, then rerun openclaw doctor --fix to verify the import. Check openclaw models status for the expected providers.";
  return {
    checkId: `core/doctor/plugin-model-catalog/${issue.kind}`,
    target: issue.pathname,
    severity: issue.kind === "superseded-source" ? "info" : "warning",
    category: historical ? "historical" : "fix-now",
    message: shortenHomePath(issue.message),
    fixHint,
    docsUrl: "https://docs.openclaw.ai/cli/doctor/running#auth-migration-recovery",
  };
}

function resolveMigrationAgentDirs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: readonly string[];
}): string[] {
  let agentDirs = params.agentDirs;
  const env = params.env ?? process.env;
  if (!agentDirs) {
    const agentIds = listAgentIds(params.cfg);
    agentDirs =
      agentIds.length > 0
        ? agentIds.map((agentId) => resolveAgentDir(params.cfg, agentId, env))
        : [resolveDefaultAgentDir(params.cfg, env)];
  }
  return [...new Set(agentDirs)].toSorted((left, right) => left.localeCompare(right));
}

/** Imports released sidecars and repairs persisted SQLite catalogs only with Doctor authority. */
export async function maybeMigrateLegacyPluginModelCatalogs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: readonly string[];
  prompter: DoctorPrompter;
  runtime: RuntimeEnv;
  note?: typeof note;
  reportFindings?: (findings: readonly HealthFinding[], warnings?: readonly string[]) => void;
}): Promise<{
  detected: number;
  migrated: number;
  repaired: number;
  warnings: string[];
  findings: readonly HealthFinding[];
}> {
  const warnings: string[] = [];
  const findings: HealthFinding[] = [];
  const report = (reported: readonly HealthFinding[], rawWarnings?: readonly string[]) => {
    findings.push(...reported);
    params.reportFindings?.(reported, rawWarnings);
  };
  const agents: Array<{
    agentDir: string;
    migrations: ReturnType<typeof inspectLegacyPluginModelCatalogs>["catalogs"];
    warnings: string[];
    inspectionFindings: readonly HealthFinding[];
    repairablePluginIds: string[];
  }> = [];
  for (const agentDir of resolveMigrationAgentDirs(params)) {
    const inspected = inspectLegacyPluginModelCatalogs(agentDir);
    const agentWarnings = inspected.warnings.map((warning) => shortenHomePath(warning));
    const migrations = inspected.catalogs;
    const repairablePluginIds = loadPersistedPluginModelCatalogsReadOnly(agentDir)
      .filter(
        ({ contents }) => repairPluginModelCatalogTransportMetadata(contents).removedModelCount > 0,
      )
      .map(({ pluginId }) => pluginId);
    agents.push({
      agentDir,
      migrations,
      warnings: agentWarnings,
      inspectionFindings: inspected.issues.map(catalogMigrationFinding),
      repairablePluginIds,
    });
    warnings.push(...agentWarnings);
    params.reportFindings?.([], agentWarnings);
  }
  const migrations = agents.flatMap((agent) => agent.migrations);
  const detected =
    migrations.length +
    agents.reduce((count, agent) => count + agent.repairablePluginIds.length, 0);
  for (const warning of warnings) {
    params.runtime.error(warning);
  }

  const emitNote = params.note ?? note;
  if (detected > 0) {
    const details =
      migrations.length > 0
        ? [
            "Legacy generated provider catalogs contain model and credential state.",
            ...migrations.map((migration) => `- ${shortenHomePath(migration.pathname)}`),
          ]
        : [];
    for (const agent of agents) {
      for (const pluginId of agent.repairablePluginIds) {
        details.push(
          `Generated catalog ${pluginId} in ${shortenHomePath(agent.agentDir)} contains model rows without transport API metadata.`,
        );
      }
    }
    details.push("Run openclaw doctor --fix to verify and repair these catalogs.");
    emitNote(details.join("\n"), "Plugin model catalogs");
  }
  const shouldRepair =
    params.prompter.shouldRepair ||
    (detected > 0 &&
      (await params.prompter.confirmAutoFix({
        message: "Repair generated provider model catalogs now?",
        initialValue: true,
      })));
  if (!shouldRepair) {
    report(
      agents.flatMap((agent) => agent.inspectionFindings),
      [],
    );
    if (detected > 0) {
      report([
        {
          checkId: "core/doctor/plugin-model-catalog/repair-pending",
          severity: "warning",
          category: "fix-now",
          message: `${detected} generated provider catalog repair${detected === 1 ? "" : "s"} remain pending.`,
          fixHint:
            "Run openclaw doctor --fix to verify legacy catalog imports and repair model transport metadata. Keep the original catalogs and recovery copies until verification completes.",
          docsUrl: "https://docs.openclaw.ai/cli/doctor/running#auth-migration-recovery",
        },
      ]);
    }
    return { detected, migrated: 0, repaired: 0, warnings, findings };
  }

  let migrated = 0;
  const repairs: Array<{ pluginId: string; removedModelCount: number }> = [];
  for (const agent of agents) {
    // Fix also retires verified orphaned migration recovery rows when no sidecar remains.
    let result: ReturnType<typeof migrateLegacyPluginModelCatalogs>;
    try {
      result = migrateLegacyPluginModelCatalogs({
        agentDir: agent.agentDir,
        ...(agent.migrations.length > 0
          ? {
              expectedContents: new Map(
                agent.migrations.map((migration) => [migration.pluginId, migration.contents]),
              ),
            }
          : {}),
      });
    } catch (error) {
      report([
        {
          checkId: "core/doctor/plugin-model-catalog/import-failed",
          target: agent.agentDir,
          severity: "warning",
          category: "fix-now",
          message: `Generated provider catalog migration could not complete: ${error instanceof Error ? error.message : String(error)}`,
          fixHint:
            "Keep the retained catalog sources and recovery copy. Resolve the reported changed source or database error, then rerun openclaw doctor --fix. Avoid running an older catalog writer during migration.",
          docsUrl: "https://docs.openclaw.ai/cli/doctor/running#auth-migration-recovery",
        },
      ]);
      throw error;
    }
    migrated += result.migrated;
    params.reportFindings?.([], result.warnings.map(shortenHomePath));
    report(
      result.issues
        .map(catalogMigrationFinding)
        .filter(
          (finding) =>
            !findings.some(
              (existing) =>
                existing.checkId === finding.checkId && existing.target === finding.target,
            ),
        ),
      [],
    );
    for (const warning of result.warnings) {
      const displayWarning = shortenHomePath(warning);
      if (warnings.includes(displayWarning)) {
        continue;
      }
      warnings.push(displayWarning);
      params.runtime.error(displayWarning);
    }
    if (result.warnings.length === 0) {
      // Migration can publish a malformed legacy payload. Re-read it before planning
      // repair; the storage owner still compares those bytes at the write boundary.
      repairs.push(
        ...repairPersistedPluginModelCatalogs({
          agentDir: agent.agentDir,
          catalogs: loadPersistedPluginModelCatalogsReadOnly(agent.agentDir),
        }),
      );
    }
  }

  if (migrated > 0) {
    emitNote(
      `Migrated and verified ${migrated} generated provider catalog${migrated === 1 ? "" : "s"} in agent SQLite.`,
      "Doctor changes",
    );
  }
  if (repairs.length > 0) {
    emitNote(
      repairs
        .map(
          ({ pluginId, removedModelCount }) =>
            `Repaired generated model catalog ${pluginId}: removed ${removedModelCount} model row(s) without transport API metadata.`,
        )
        .join("\n"),
      "Doctor changes",
    );
  }
  return { detected, migrated, repaired: repairs.length, warnings, findings };
}
