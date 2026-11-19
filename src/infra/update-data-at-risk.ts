import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { preflightOpenClawDatabaseSchemas } from "../state/openclaw-database-preflight.js";
import type {
  IncompatibleOpenClawDatabase,
  OpenClawDatabaseSchemaPreflight,
} from "../state/openclaw-database-preflight.types.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { VERSION } from "../version.js";
import { formatErrorMessage } from "./errors.js";
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

const LEFTOVER_SCAN_DEPTH = 6;
const LEFTOVER_SCAN_ENTRIES = 50_000;

/**
 * A database rollback moves each migrated database aside as `<db>.migrated-<run>` beside
 * its own file, shared and agent stores alike, before it restores the backup. Walk the
 * state directory for that run's leftovers; `undefined` when none, `null` when the walk
 * could not finish within its bounds.
 */
function findRollbackLeftover(stateDir: string, runId: string): string | null | undefined {
  const marker = `.migrated-${runId}`;
  let visited = 0;
  const walk = (directory: string, depth: number): string | null | undefined => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return depth === 0 ? null : undefined;
    }
    for (const entry of entries) {
      if ((visited += 1) > LEFTOVER_SCAN_ENTRIES) {
        return null;
      }
      const file = path.join(directory, entry.name);
      if (entry.name.includes(marker)) {
        return file;
      }
      if (entry.isDirectory() && depth < LEFTOVER_SCAN_DEPTH) {
        const found = walk(file, depth + 1);
        if (found !== undefined) {
          return found;
        }
      }
    }
    return undefined;
  };
  return walk(stateDir, 0);
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
  if (schemas.incompatible.length > 0) {
    return {
      status: "inconsistent",
      // Updating fixes newer state only when nothing else is unfinished.
      ...(pending.length === 0 ? { newerState: true as const } : {}),
      detail: listFindings(schemas.incompatible.map(describeAhead)),
      // The installed build cannot open newer state; a build that supports it can.
      nextAction: `run \`${formatCommand("openclaw update")}\` to a version that supports it, or restore the pre-update backup.`,
    };
  }
  if (pending.length > 0) {
    return {
      status: "inconsistent",
      detail: listFindings(
        pending.map(
          (database) =>
            `the ${database.kind} database${database.agentId ? ` for agent ${database.agentId}` : ""} ${database.path} is at schema ${database.foundVersion}; installed OpenClaw ${VERSION} needs ${database.supportedVersion}, so its migration did not finish`,
        ),
      ),
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
  marks?: readonly { runId: string; mark: string }[];
  signal?: AbortSignal;
}): Promise<UpdateStateVerification> {
  if (params.marks?.some(({ mark }) => mark === "active-mutation")) {
    // Doctor process custody owns this mark: schemas cannot show whether writers exited.
    return {
      status: "unverifiable",
      detail:
        "the mark records Doctor processes that may still be writing, which a state check cannot rule out",
      nextAction: `once those processes have stopped, run \`${params.formatCommand("openclaw update repair")}\` to settle their custody.`,
    };
  }
  const databasePath = path.resolve(resolveOpenClawStateSqlitePath(params.env));
  const stateDir = resolveStateDir(params.env);
  const leftovers = (params.marks ?? []).map(({ runId }) => ({
    runId,
    file: findRollbackLeftover(stateDir, runId),
  }));
  if (leftovers.some(({ file }) => file === null)) {
    return {
      status: "unverifiable",
      detail: `the state directory ${stateDir} could not be searched for database rollback leftovers`,
      nextAction: retryRepair(params.formatCommand),
    };
  }
  const leftover = leftovers.find(({ file }) => file);
  if (leftover) {
    return {
      status: "inconsistent",
      detail: `the database rollback of update ${leftover.runId} left ${leftover.file}, so the state may be only partly restored`,
      nextAction:
        "keep that file and the update's backup; an agent or a person must compare them before the Gateway starts.",
    };
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
  return verdict;
}
