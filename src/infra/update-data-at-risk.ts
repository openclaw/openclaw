import fs from "node:fs";
import path from "node:path";
import { readRegisteredAgentDatabases } from "../state/openclaw-agent-db-registry-listing.js";
import { preflightOpenClawDatabaseSchemas } from "../state/openclaw-database-preflight.js";
import type {
  IncompatibleOpenClawDatabase,
  OpenClawDatabaseSchemaPreflight,
} from "../state/openclaw-database-preflight.types.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { VERSION } from "../version.js";
import { formatErrorMessage } from "./errors.js";
import type { RecordedDataAtRisk } from "./update-run-data-at-risk.js";
import {
  assertUpdateRecoveryAdmission,
  assertUpdateRecoveryDirectoryAdmission,
  InterruptedStateRestoreError,
} from "./update-run-recovery-admission.js";
import { UpdateRecoveryRequiredError } from "./update-run-recovery-schema.js";

const UPDATE_INTERRUPTED_RESTORE_DOCS_URL =
  "https://docs.openclaw.ai/cli/update/repair-and-recovery#interrupted-state-restore";

/**
 * Owns the answer to "is the state on disk consistent with the installed version?" for
 * a recorded data-at-risk mark. `update-run-data-at-risk.ts` owns the mark and receipt.
 */
export type UpdateStateVerification =
  | { status: "consistent"; detail: string }
  | {
      status: "inconsistent" | "unverifiable";
      detail: string;
      /** One sentence naming the command that makes progress from this state. */
      nextAction: string;
      /** State is newer than the installed build: an update to a build that supports it is the fix. */
      newerState?: true;
      /** Doctor's maintenance settles it: an unfinished migration or writers it waits out. */
      finishable?: true;
    };

function retryRepair(formatCommand: (command: string) => string): string {
  return `retry \`${formatCommand("openclaw update repair")}\` once that reason is cleared.`;
}

/** Name the first database and count the rest, so a finding stays readable in one warning. */
function listFindings(findings: readonly string[]): string {
  return findings.length > 1
    ? `${findings[0]} (and ${findings.length - 1} more)`
    : (findings[0] ?? "");
}

/**
 * A database rollback moves each migrated database aside as `<db>.migrated-<run>` beside
 * its own file before it restores the backup. Check beside the shared database and every
 * registered agent database, wherever it lives; `null` when the registry cannot be read.
 */
function findRollbackLeftover(databasePaths: readonly string[], runId: string): string | undefined {
  for (const databasePath of databasePaths) {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const leftover = `${databasePath}.migrated-${runId}${suffix}`;
      if (fs.existsSync(leftover)) {
        return leftover;
      }
    }
  }
  return undefined;
}

function readAgentDatabasePaths(env: NodeJS.ProcessEnv): string[] | undefined {
  try {
    return readRegisteredAgentDatabases(
      { env, includeIncompatibleSchemaVersions: true },
      false,
    ).map((entry) => entry.path);
  } catch {
    return undefined;
  }
}

function leftoverFinding(leftover: { runId: string; file: string }): UpdateStateVerification {
  return {
    status: "inconsistent",
    detail: `the database rollback of update ${leftover.runId} left ${leftover.file}, so the state may be only partly restored`,
    nextAction:
      "keep that file and the update's backup; an agent or a person must compare them before the Gateway starts.",
  };
}

function describeBehind(database: {
  kind: string;
  agentId?: string;
  path: string;
  foundVersion: number;
  supportedVersion: number;
}): string {
  return `the ${database.kind} database${database.agentId ? ` for agent ${database.agentId}` : ""} ${database.path} is at schema ${database.foundVersion}; installed OpenClaw ${VERSION} needs ${database.supportedVersion}, so its migration did not finish`;
}

function describeAhead(database: IncompatibleOpenClawDatabase): string {
  const agent = database.agentId ? ` for agent ${database.agentId}` : "";
  const writer = database.writerAppVersion
    ? ` (written by OpenClaw ${database.writerAppVersion})`
    : "";
  return `the ${database.kind} database${agent} ${database.path} is at schema ${database.foundVersion}${writer}, newer than ${database.supportedVersion} supported by installed OpenClaw ${VERSION}`;
}

function classify(
  schemas: OpenClawDatabaseSchemaPreflight,
  formatCommand: (command: string) => string,
): UpdateStateVerification {
  const pending = schemas.pendingMigrations ?? [];
  if (schemas.incompatible.length > 0 && pending.length > 0) {
    // Neither an update nor Doctor can finish while one store is ahead and another behind.
    return {
      status: "inconsistent",
      detail: `${listFindings(schemas.incompatible.map(describeAhead))}; and ${listFindings(pending.map(describeBehind))}`,
      nextAction: "restore the pre-update backup, which an agent can choose with you.",
    };
  }
  if (schemas.incompatible.length > 0) {
    return {
      status: "inconsistent",
      newerState: true,
      detail: listFindings(schemas.incompatible.map(describeAhead)),
      // The installed build cannot open newer state; a build that supports it can.
      nextAction: `run \`${formatCommand("openclaw update")}\` to a version that supports it, or restore the pre-update backup.`,
    };
  }
  if (pending.length > 0) {
    return {
      status: "inconsistent",
      finishable: true,
      detail: listFindings(pending.map(describeBehind)),
      nextAction: `run \`${formatCommand("openclaw doctor --fix")}\` to finish the migration.`,
    };
  }
  if (schemas.indeterminate.length > 0) {
    return {
      status: "unverifiable",
      detail: listFindings(
        schemas.indeterminate.map(
          (database) =>
            `${database.kind} database ${database.path} could not be read: ${database.reason}`,
        ),
      ),
      nextAction: retryRepair(formatCommand),
    };
  }
  return {
    status: "consistent",
    detail: `state schemas match installed OpenClaw ${VERSION} and no migration or restore is unfinished`,
  };
}

/**
 * Is the state on disk consistent with the installed build? Read-only and safe beside a
 * live Gateway: recovery admission reads rows, and the runtime schema preflight reads
 * headers and schema shape in one native read transaction without copying a database.
 */
export async function verifyUpdateStateConsistency(params: {
  env: NodeJS.ProcessEnv;
  formatCommand: (command: string) => string;
  /** The recorded marks being checked; some name evidence a schema check cannot see. */
  marks?: readonly RecordedDataAtRisk[];
  /**
   * This run's Doctor maintenance has since held exclusive state and agent ownership, so
   * no writer the marked run left behind can still hold the state.
   */
  writersExcluded?: true;
  signal?: AbortSignal;
}): Promise<UpdateStateVerification> {
  const databasePath = path.resolve(resolveOpenClawStateSqlitePath(params.env));
  // A completed rollback keeps its displaced files on purpose; only other runs' count.
  const rollbackRuns = (params.marks ?? []).filter(({ databaseRestored }) => !databaseRestored);
  const findLeftover = (paths: readonly string[]) =>
    rollbackRuns
      .map(({ runId }) => ({ runId, file: findRollbackLeftover(paths, runId) }))
      .find((entry): entry is { runId: string; file: string } => entry.file !== undefined);
  // The shared database needs no registry; agent databases are checked after the schema
  // verdict, so an unreadable registry cannot hide a schema finding.
  const sharedLeftover = findLeftover([databasePath]);
  if (sharedLeftover) {
    return leftoverFinding(sharedLeftover);
  }
  try {
    await assertUpdateRecoveryDirectoryAdmission(databasePath);
  } catch (error) {
    params.signal?.throwIfAborted();
    if (!(error instanceof InterruptedStateRestoreError)) {
      return {
        status: "unverifiable",
        detail: `the state directory could not be inspected: ${formatErrorMessage(error)}`,
        nextAction: retryRepair(params.formatCommand),
      };
    }
    // Its message names the retained directory and the recovery page.
    return {
      status: "inconsistent",
      detail: `a state restore did not finish: ${formatErrorMessage(error)}`,
      nextAction: `keep that directory and follow ${UPDATE_INTERRUPTED_RESTORE_DOCS_URL}; no command finishes it safely.`,
    };
  }
  let schemas: OpenClawDatabaseSchemaPreflight;
  try {
    // Runtime purpose with source reads: one native read transaction in a child,
    // never a copy of a database a live Gateway may be writing.
    schemas = await preflightOpenClawDatabaseSchemas(
      {
        env: params.env,
        verifyCurrentSchemaShape: true,
        preserveSourceArtifacts: false,
        signal: params.signal,
      },
      "runtime",
    );
  } catch (error) {
    params.signal?.throwIfAborted();
    return {
      status: "unverifiable",
      detail: `the state databases could not be inspected: ${formatErrorMessage(error)}`,
      nextAction: retryRepair(params.formatCommand),
    };
  }
  const verdict = classify(schemas, params.formatCommand);
  // A finding that refuses outright reports first. One a caller may defer to Doctor or
  // continue past (an unfinished migration, newer state) must not hide a rollback leftover.
  const deferrable =
    verdict.status !== "consistent" && (verdict.finishable === true || verdict.newerState === true);
  if (verdict.status !== "consistent" && !deferrable) {
    return verdict;
  }
  if (rollbackRuns.length > 0) {
    const agentPaths = readAgentDatabasePaths(params.env);
    if (!agentPaths && verdict.status !== "consistent") {
      // The schema finding is the more useful answer; it still refuses resolution.
      return verdict;
    }
    if (!agentPaths) {
      return {
        status: "unverifiable",
        detail:
          "the agent database registry could not be read to check for database rollback leftovers",
        nextAction: retryRepair(params.formatCommand),
      };
    }
    const agentLeftover = findLeftover(agentPaths);
    if (agentLeftover) {
      return leftoverFinding(agentLeftover);
    }
  }
  if (verdict.status !== "consistent") {
    // A schema finding explains why recovery rows may be unreadable, so it reports first.
    return verdict;
  }
  try {
    await assertUpdateRecoveryAdmission({ env: params.env });
  } catch (error) {
    if (error instanceof UpdateRecoveryRequiredError) {
      return {
        status: "inconsistent",
        detail: `update ${error.record.runId} has unfinished state recovery`,
        nextAction: `run \`${params.formatCommand("openclaw update status")}\` for that recovery's next step.`,
      };
    }
    params.signal?.throwIfAborted();
    return {
      status: "unverifiable",
      detail: `update recovery records could not be read: ${formatErrorMessage(error)}`,
      nextAction: retryRepair(params.formatCommand),
    };
  }
  // Checked last, so evidence a state check can see is never hidden behind a deferral.
  if (!params.writersExcluded && params.marks?.some(({ mark }) => mark === "active-mutation")) {
    // Schemas cannot show whether writers exited; Doctor's ownership admission can.
    return {
      status: "unverifiable",
      detail:
        "the mark records Doctor processes that may still be writing, which a state check cannot rule out",
      nextAction: `run \`${params.formatCommand("openclaw update repair")}\`: its Doctor waits for those writers to release the state, then this check runs again.`,
      finishable: true,
    };
  }
  return verdict;
}
