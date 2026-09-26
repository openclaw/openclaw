/** Doctor repair for broken session transcript branches and legacy OpenAI Codex metadata. */
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
import {
  repairAcpSessionMetaKeysForDoctor,
  type AcpSessionKeyRepairReport,
} from "../acp/runtime/session-meta-doctor.js";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import {
  normalizeLegacyOpenAICodexTranscriptMetadata,
  selectActivePath,
  hasBrokenPromptRewriteBranch,
  type TranscriptEntry,
} from "../config/sessions/legacy-transcript-repair.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { createLegacyStateMigrationStepReceipt } from "../infra/state-migrations.messages.js";
import { runPostSessionPluginDoctorStateRepairs } from "../infra/state-migrations.plugin-doctor.js";
import type {
  LegacyStateMigrationStepReceipt,
  MigrationMessages,
  PreparedPostSessionPluginMigration,
} from "../infra/state-migrations.types.js";
import {
  repairCanonicalSessionKeys,
  type CanonicalSessionKeyRepairReport,
} from "./doctor-session-canonical-keys.js";
import {
  repairCanonicalSessionDeliveryStates,
  repairCanonicalSessionResolvedSkills,
  type SessionDeliveryStateRepairReport,
} from "./doctor-session-delivery-state.js";
import { repairLegacySessionExecPolicy } from "./doctor-session-exec-policy.js";
import {
  repairReservedIncognitoSessionKeys,
  type ReservedIncognitoKeyRepairReport,
} from "./doctor-session-incognito-key-repair.js";
import { listExistingAgentDatabaseTargets } from "./doctor-session-sqlite-readers.js";
import { isInformationalMissingSessionIndex } from "./doctor-session-sqlite-types.js";
import { formatSessionSqliteMigrationWarnings } from "./doctor-session-sqlite-warnings.js";
import {
  repairLegacySessionTitles,
  type SessionTitleRepairReport,
} from "./doctor-session-title-repair.js";
import { repairLegacySessionWorktreeWorkspaces } from "./doctor-session-worktree-workspace.js";
import {
  DoctorSqliteMaintenanceLockUnavailableError,
  withDoctorSqliteMaintenanceLock,
  type DoctorSqliteMaintenanceAuthority,
} from "./doctor-sqlite-maintenance-lock.js";

const SESSION_TRANSCRIPTS_CHECK_ID = "core/doctor/session-transcripts";

type TranscriptRepairResult = {
  filePath: string;
  broken: boolean;
  repaired: boolean;
  originalEntries: number;
  activeEntries: number;
  legacyOpenAICodexEntries: number;
  backupPath?: string;
  reason?: string;
  deferred?: boolean;
};

type SessionTranscriptHealthIssue = TranscriptRepairResult;

function parseTranscriptEntries(raw: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries.push(parsed as TranscriptEntry);
      }
    } catch {
      return [];
    }
  }
  return entries;
}

/** Classifies one legacy transcript without changing its contents. */
async function inspectSessionTranscriptFile(params: {
  filePath: string;
}): Promise<TranscriptRepairResult> {
  const result: TranscriptRepairResult = {
    filePath: params.filePath,
    broken: false,
    repaired: false,
    originalEntries: 0,
    activeEntries: 0,
    legacyOpenAICodexEntries: 0,
  };
  try {
    if ((await fs.stat(params.filePath)).size > 1024 * 1024) {
      result.deferred = true;
      result.reason = "Detailed branch/provider classification deferred to offline staged import.";
      return result;
    }
    const raw = await fs.readFile(params.filePath, "utf-8");
    const entries = parseTranscriptEntries(raw);
    result.originalEntries = entries.length;
    result.legacyOpenAICodexEntries = normalizeLegacyOpenAICodexTranscriptMetadata(entries);
    const activePath = selectActivePath(entries);
    result.activeEntries = activePath?.entries.length ?? 0;
    const brokenBranch = activePath
      ? hasBrokenPromptRewriteBranch(entries, activePath.entries)
      : false;
    result.broken = brokenBranch || result.legacyOpenAICodexEntries > 0;
    if (!activePath) {
      result.reason = "no active branch";
    }
  } catch (err) {
    result.reason = String(err);
  }
  return result;
}

async function listSessionTranscriptFiles(sessionDirs: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const sessionsDir of sessionDirs) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path.join(sessionsDir, entry.name));
      }
    }
  }
  return files.toSorted((a, b) => a.localeCompare(b));
}

export async function detectSessionTranscriptHealthIssues(params?: {
  sessionDirs?: string[];
}): Promise<SessionTranscriptHealthIssue[]> {
  let sessionDirs = params?.sessionDirs;
  try {
    sessionDirs ??= await resolveAgentSessionDirs(resolveStateDir(process.env));
  } catch {
    return [];
  }

  const files = await listSessionTranscriptFiles(sessionDirs);
  const issues: SessionTranscriptHealthIssue[] = [];
  for (const filePath of files) {
    const result = await inspectSessionTranscriptFile({ filePath });
    if (result.broken || result.deferred) {
      issues.push(result);
    }
  }
  return issues;
}

export function sessionTranscriptIssueToHealthFinding(
  issue: SessionTranscriptHealthIssue,
): HealthFinding {
  const metadata =
    issue.legacyOpenAICodexEntries > 0
      ? ` ${issue.legacyOpenAICodexEntries} legacy OpenAI Codex metadata entr${
          issue.legacyOpenAICodexEntries === 1 ? "y" : "ies"
        }`
      : "";
  return {
    checkId: SESSION_TRANSCRIPTS_CHECK_ID,
    severity: "info",
    message: issue.deferred
      ? issue.reason!
      : `Session transcript has legacy branch or provider metadata that can be cleaned up.${metadata}`,
    path: issue.filePath,
    fixHint:
      "Run `openclaw doctor --fix` to repair legacy transcripts during their staged import into SQLite.",
  };
}

export function sessionTranscriptIssueToRepairEffect(
  issue: SessionTranscriptHealthIssue,
): HealthRepairEffect {
  return {
    kind: "file",
    action: "would-rewrite-session-transcript",
    target: issue.filePath,
    dryRunSafe: false,
  };
}

/** Reports or repairs session state through the canonical SQLite migration owner. */
export async function noteSessionTranscriptHealth(params?: {
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair?: boolean;
  postSessionPluginMigration?: PreparedPostSessionPluginMigration;
  postSessionPluginMigrationPlanBound?: boolean;
  onStepReceipt?: (receipt: LegacyStateMigrationStepReceipt) => void;
  onWarnings?: (warnings: readonly string[]) => void;
}): Promise<LegacyStateMigrationStepReceipt | undefined> {
  return await noteSessionSqliteMigrationHealth({
    cfg: params?.cfg,
    env: params?.env ?? process.env,
    shouldRepair: params?.shouldRepair === true,
    ...(params?.postSessionPluginMigration
      ? { postSessionPluginMigration: params.postSessionPluginMigration }
      : {}),
    ...(params?.postSessionPluginMigrationPlanBound
      ? { postSessionPluginMigrationPlanBound: true }
      : {}),
    ...(params?.onStepReceipt ? { onStepReceipt: params.onStepReceipt } : {}),
    ...(params?.onWarnings ? { onWarnings: params.onWarnings } : {}),
  });
}

async function noteSessionSqliteMigrationHealth(params: {
  cfg?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  postSessionPluginMigration?: PreparedPostSessionPluginMigration;
  postSessionPluginMigrationPlanBound?: boolean;
  onStepReceipt?: (receipt: LegacyStateMigrationStepReceipt) => void;
  onWarnings?: (warnings: readonly string[]) => void;
}): Promise<LegacyStateMigrationStepReceipt | undefined> {
  // Public doctor owns the operator-facing SQLite import; the targeted
  // --session-sqlite subcommand remains the diagnostic/proof surface.
  const { runDoctorSessionSqlite } = await import("./doctor-session-sqlite.js");
  let reservedKeyReport: ReservedIncognitoKeyRepairReport = { found: 0, repaired: 0 };
  let deliveryReport: SessionDeliveryStateRepairReport = {
    found: 0,
    repaired: 0,
    scannedStores: 0,
  };
  let resolvedSkillsReport: SessionDeliveryStateRepairReport = {
    found: 0,
    repaired: 0,
    scannedStores: 0,
  };
  let canonicalKeyReport: CanonicalSessionKeyRepairReport = {
    archivedTranscriptDirectories: [],
    foundGroups: 0,
    repairBatches: 0,
    removedRows: 0,
    repairedGroups: 0,
    scannedStores: 0,
  };
  let worktreeWorkspaceReport = { found: 0, repaired: 0, scannedStores: 0 };
  let acpKeyReport: AcpSessionKeyRepairReport = {
    found: 0,
    repaired: 0,
    scannedRows: 0,
    warnings: [],
  };
  let titleReport: SessionTitleRepairReport = {
    found: 0,
    repaired: 0,
    scannedStores: 0,
    warnings: [],
  };
  let legacyMainSessionResult:
    | Awaited<
        ReturnType<
          typeof import("../config/sessions/legacy-main-session-migration.js").migrateLegacyMainSessionKeys
        >
      >
    | undefined;
  let postSessionPluginReceipt: LegacyStateMigrationStepReceipt | undefined;
  const recordPostSessionRefusal = (refusal: { code: string; message: string }) => {
    if (!params.postSessionPluginMigration || postSessionPluginReceipt) {
      return postSessionPluginReceipt;
    }
    postSessionPluginReceipt = createLegacyStateMigrationStepReceipt(
      { ...params.postSessionPluginMigration.step, refusal },
      { changes: [], warnings: [refusal.message] },
    );
    params.onStepReceipt?.(postSessionPluginReceipt);
    return postSessionPluginReceipt;
  };
  const runSessionSqlite = async (maintenanceAuthority?: DoctorSqliteMaintenanceAuthority) => {
    const report = await runDoctorSessionSqlite({
      allAgents: true,
      ...(params.cfg ? { cfg: params.cfg } : {}),
      env: params.env,
      mode: params.shouldRepair ? "import" : "dry-run",
    });
    const { migrateLegacyMainSessionKeys } =
      await import("../config/sessions/legacy-main-session-migration.js");
    legacyMainSessionResult = await migrateLegacyMainSessionKeys({
      cfg: params.cfg ?? {},
      env: params.env,
      mode: params.shouldRepair ? "doctor-fix" : "detect",
    });
    const repairParams = {
      apply: params.shouldRepair,
      cfg: params.cfg ?? {},
      env: params.env,
    };
    canonicalKeyReport = await repairCanonicalSessionKeys(repairParams);
    // Import and key repair can create stores; later row repairs share their settled inventory.
    const rowRepairParams = {
      ...repairParams,
      targets: listExistingAgentDatabaseTargets(repairParams.cfg, params.env),
    };
    // Canonical-key ties compare complete entry JSON, so select their winner before stripping it.
    resolvedSkillsReport = repairCanonicalSessionResolvedSkills(rowRepairParams);
    // Import may create the first durable SQLite row for a colliding legacy key.
    reservedKeyReport = await repairReservedIncognitoSessionKeys(rowRepairParams);
    deliveryReport = repairCanonicalSessionDeliveryStates(rowRepairParams);
    repairLegacySessionExecPolicy(rowRepairParams);
    acpKeyReport = await repairAcpSessionMetaKeysForDoctor({
      ...repairParams,
      authority: maintenanceAuthority,
    });
    titleReport = await repairLegacySessionTitles({
      ...rowRepairParams,
      authority: maintenanceAuthority,
    });
    worktreeWorkspaceReport = await repairLegacySessionWorktreeWorkspaces({
      ...rowRepairParams,
      // Workspace metadata participates in an unfinished legacy-main source claim.
      apply:
        params.shouldRepair && (!legacyMainSessionResult.armed || legacyMainSessionResult.complete),
    });
    if (params.postSessionPluginMigrationPlanBound && !params.postSessionPluginMigration) {
      return report;
    }
    if (params.postSessionPluginMigration?.step.requiredness === "not-required") {
      postSessionPluginReceipt = createLegacyStateMigrationStepReceipt(
        params.postSessionPluginMigration.step,
        { changes: [], warnings: [] },
      );
      params.onStepReceipt?.(postSessionPluginReceipt);
      return report;
    }
    if (!params.shouldRepair && params.postSessionPluginMigration) {
      recordPostSessionRefusal({
        code: "repair-not-authorized",
        message: "Post-session plugin repair was planned but Doctor repair was not authorized.",
      });
      return report;
    }
    let pluginRepair: MigrationMessages;
    let receiptStep = params.postSessionPluginMigration?.step;
    try {
      pluginRepair = await runPostSessionPluginDoctorStateRepairs({
        config: params.cfg ?? {},
        env: params.env,
        maintenanceAuthority,
        ...(maintenanceAuthority
          ? {
              beforeCompletion: async (
                completedPluginIds: readonly string[],
                assertCurrent: () => void,
              ) => {
                const { settleRetainedDoctorSessionSources } =
                  await import("./doctor-session-sqlite.js");
                await settleRetainedDoctorSessionSources(
                  report,
                  completedPluginIds,
                  maintenanceAuthority,
                  assertCurrent,
                );
              },
            }
          : {}),
        ...(params.postSessionPluginMigration
          ? { plannedActions: params.postSessionPluginMigration.plannedActions }
          : {}),
      });
    } catch (error) {
      const message = `Plugin session repair failed before the planned step completed: ${String(error)}`;
      pluginRepair = { changes: [], warnings: [message] };
      if (receiptStep) {
        receiptStep = { ...receiptStep, refusal: { code: "step-threw", message } };
      }
    }
    if (receiptStep) {
      postSessionPluginReceipt = createLegacyStateMigrationStepReceipt(receiptStep, pluginRepair);
      params.onStepReceipt?.(postSessionPluginReceipt);
    }
    const pluginMessages = [...pluginRepair.changes, ...pluginRepair.warnings];
    if (pluginMessages.length > 0) {
      note(pluginMessages.join("\n"), "Plugin session repair");
    }
    return report;
  };
  let report: Awaited<ReturnType<typeof runSessionSqlite>>;
  try {
    report = params.shouldRepair
      ? await withDoctorSqliteMaintenanceLock({
          env: params.env,
          operation: "session SQLite import",
          run: runSessionSqlite,
        })
      : await runSessionSqlite();
  } catch (error) {
    if (!(error instanceof DoctorSqliteMaintenanceLockUnavailableError)) {
      recordPostSessionRefusal({
        code: "blocked-by-session-repair-failure",
        message: `Post-session plugin repair was blocked because prerequisite session repair failed: ${String(error)}`,
      });
      throw error;
    }
    note(
      `- Skipped: Gateway or another SQLite maintenance command owns the state directory. Stop the Gateway, then run "${formatCliCommand("openclaw doctor --fix", params.env)}" for session-store maintenance.`,
      "Session SQLite",
    );
    recordPostSessionRefusal({
      code: "sqlite-maintenance-unavailable",
      message: "Session SQLite maintenance ownership was unavailable.",
    });
    return postSessionPluginReceipt;
  }
  if (worktreeWorkspaceReport.found > 0) {
    note(
      params.shouldRepair
        ? `- Repaired canonical workspace metadata for ${worktreeWorkspaceReport.repaired} of ${worktreeWorkspaceReport.found} managed-worktree session(s). Check project/worktree ownership for any remaining entries.`
        : `- Found ${worktreeWorkspaceReport.found} managed-worktree session(s) missing canonical workspace metadata. Run "openclaw doctor --fix" to repair them.`,
      "Session worktrees",
    );
  }
  if (acpKeyReport.found > 0 || acpKeyReport.warnings.length > 0) {
    note(
      [
        params.shouldRepair
          ? `- Repaired ${acpKeyReport.repaired} of ${acpKeyReport.found} legacy ACP metadata key(s).`
          : `- Found ${acpKeyReport.found} legacy ACP metadata key(s). Run "openclaw doctor --fix" to repair them.`,
        ...acpKeyReport.warnings,
      ].join("\n"),
      "ACP session keys",
    );
  }
  if (titleReport.found > 0 || titleReport.warnings.length > 0) {
    note(
      [
        params.shouldRepair
          ? `- Repaired ${titleReport.repaired} of ${titleReport.found} missing session title(s) without changing activity.`
          : `- Found ${titleReport.found} missing session title(s). Run "openclaw doctor --fix" to repair them.`,
        ...titleReport.warnings,
      ].join("\n"),
      "Session titles",
    );
  }
  if (reservedKeyReport.found > 0) {
    note(
      params.shouldRepair
        ? `- Renamed ${reservedKeyReport.repaired} durable session key(s) that collided with the reserved incognito namespace.`
        : `- Found ${reservedKeyReport.found} durable session key(s) that collide with the reserved incognito namespace. Run "openclaw doctor --fix" to rename them.`,
      "Session SQLite",
    );
  }
  if (canonicalKeyReport.foundGroups > 0) {
    note(
      params.shouldRepair
        ? `- Canonicalized ${canonicalKeyReport.repairedGroups} session-key group(s) in ${canonicalKeyReport.repairBatches} transaction batch(es), removed ${canonicalKeyReport.removedRows} duplicate or alias row(s), and preserved cross-store history in ${canonicalKeyReport.archivedTranscriptDirectories.length} archive director${canonicalKeyReport.archivedTranscriptDirectories.length === 1 ? "y" : "ies"}.`
        : `- Found ${canonicalKeyReport.foundGroups} non-canonical or duplicate session-key group(s). Run "openclaw doctor --fix" to preserve their history and canonicalize the rows.`,
      "Session SQLite",
    );
  }
  if (deliveryReport.found > 0) {
    note(
      params.shouldRepair
        ? `- Canonicalized delivery state for ${deliveryReport.repaired} durable session row(s).`
        : `- Found ${deliveryReport.found} durable session row(s) with legacy delivery fields. Run "openclaw doctor --fix" to canonicalize them.`,
      "Session SQLite",
    );
  }
  if (resolvedSkillsReport.found > 0) {
    note(
      params.shouldRepair
        ? `- Stripped the runtime-only skills catalog from ${resolvedSkillsReport.repaired} durable session row(s). Logical SQLite pages are freed; shrinking the on-disk database requires "openclaw doctor --session-sqlite compact --session-sqlite-all-agents".`
        : `- Found ${resolvedSkillsReport.found} durable session row(s) carrying a runtime-only skills catalog. Run "openclaw doctor --fix" to strip it.`,
      "Session SQLite",
    );
  }
  if (
    legacyMainSessionResult &&
    (legacyMainSessionResult.changes.length > 0 || legacyMainSessionResult.warnings.length > 0)
  ) {
    note(
      [
        ...legacyMainSessionResult.changes.map((change) => `- ${change}`),
        ...legacyMainSessionResult.warnings.map((warning) => `- ${warning}`),
      ].join("\n"),
      "Legacy main sessions",
    );
  }
  if (
    report.totals.legacyEntries === 0 &&
    report.totals.unreferencedJsonlFiles === 0 &&
    report.totals.issues === 0
  ) {
    return postSessionPluginReceipt;
  }
  const informationalIndexes = report.targets.filter(isInformationalMissingSessionIndex);
  const actionableTargets = report.targets.filter(
    (target) => !isInformationalMissingSessionIndex(target),
  );
  const actionableIssues = actionableTargets.reduce(
    (count, target) => count + target.issues.length,
    0,
  );
  const lines = [
    `- Legacy entries: ${report.totals.legacyEntries}; SQLite entries: ${report.totals.sqliteEntries}.`,
    `- Transcript events: imported=${report.totals.importedTranscriptEvents}; validated=${report.totals.validatedTranscriptEvents}.`,
  ];
  for (const target of informationalIndexes) {
    lines.push(...target.issues.map((issue) => `- ${issue.message}`));
  }
  if (report.totals.archivedTranscriptFiles > 0) {
    lines.push(
      `- Archived ${report.totals.archivedTranscriptFiles} legacy transcript artifact(s).`,
    );
  }
  if (report.totals.archivedUnreferencedJsonlFiles > 0) {
    lines.push(
      `- Archived ${report.totals.archivedUnreferencedJsonlFiles} unreferenced JSONL artifact(s).`,
    );
  }
  if (actionableIssues > 0) {
    const warnings = formatSessionSqliteMigrationWarnings(actionableTargets);
    const deferredHistory = actionableTargets.reduce(
      (count, target) =>
        count +
        target.issues.filter((issue) => issue.code === "historical_transcript_deferred").length,
      0,
    );
    if (deferredHistory > 0) {
      warnings.unshift(
        `Deferred ${deferredHistory} historical transcript claim(s); originals remain protected. Preserve the named files and migration manifests, resolve the reported conflicts, then rerun "${formatCliCommand("openclaw doctor --fix", params.env)}".`,
      );
    }
    params.onWarnings?.(warnings);
    lines.push(...warnings.map((warning) => `- ${warning}`));
    lines.push(
      `- Found ${actionableIssues} session SQLite issue(s). Inspect with "${formatCliCommand("openclaw doctor --session-sqlite dry-run --session-sqlite-all-agents", params.env)}".`,
    );
  }
  if (!params.shouldRepair && actionableTargets.length > 0) {
    lines.push(
      '- Run "openclaw doctor --fix" to migrate legacy session metadata/transcripts to SQLite.',
    );
  }
  if (params.shouldRepair && report.migrationRun && report.totals.archivedTranscriptFiles > 0) {
    lines.push(
      `- After verifying the upgrade, preview rollback retirement with "${formatCliCommand("openclaw update cleanup --dry-run", params.env)}" for state ${resolveStateDir(params.env)}. Keep the same OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH overrides.`,
    );
  }
  note(lines.join("\n"), "Session SQLite");
  return postSessionPluginReceipt;
}
