/** Doctor repair for broken session transcript branches and legacy OpenAI Codex metadata. */
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { note } from "../../packages/terminal-core/src/note.js";
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
  });
}

async function noteSessionSqliteMigrationHealth(params: {
  cfg?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  postSessionPluginMigration?: PreparedPostSessionPluginMigration;
  postSessionPluginMigrationPlanBound?: boolean;
  onStepReceipt?: (receipt: LegacyStateMigrationStepReceipt) => void;
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
    // Canonical-key ties compare complete entry JSON, so select their winner before stripping it.
    resolvedSkillsReport = repairCanonicalSessionResolvedSkills(repairParams);
    // Import may create the first durable SQLite row for a colliding legacy key.
    reservedKeyReport = repairReservedIncognitoSessionKeys(repairParams);
    deliveryReport = repairCanonicalSessionDeliveryStates(repairParams);
    repairLegacySessionExecPolicy(repairParams);
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
  const lines = [
    `- Legacy entries: ${report.totals.legacyEntries}; SQLite entries: ${report.totals.sqliteEntries}.`,
    `- Transcript events: imported=${report.totals.importedTranscriptEvents}; validated=${report.totals.validatedTranscriptEvents}.`,
  ];
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
  if (report.totals.issues > 0) {
    lines.push(
      `- Found ${report.totals.issues} session SQLite issue(s). Inspect with "${formatCliCommand("openclaw doctor --session-sqlite dry-run --session-sqlite-all-agents", params.env)}".`,
    );
  }
  if (!params.shouldRepair) {
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
