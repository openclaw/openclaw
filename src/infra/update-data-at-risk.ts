import path from "node:path";
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
  if (schemas.incompatible.length > 0) {
    return {
      status: "inconsistent",
      newerState: true,
      detail: schemas.incompatible.map(describeAhead).join("; "),
      // The installed build cannot open newer state; a build that supports it can.
      nextAction: `run \`${formatCommand("openclaw update")}\` to a version that supports it, or restore the pre-update backup.`,
    };
  }
  const pending = schemas.pendingMigrations ?? [];
  if (pending.length > 0) {
    return {
      status: "inconsistent",
      detail: pending
        .map(
          (database) =>
            `the ${database.kind} database${database.agentId ? ` for agent ${database.agentId}` : ""} ${database.path} is at schema ${database.foundVersion}; installed OpenClaw ${VERSION} needs ${database.supportedVersion}, so its migration did not finish`,
        )
        .join("; "),
      nextAction: `run \`${formatCommand("openclaw doctor --fix")}\` to finish the migration.`,
    };
  }
  if (schemas.indeterminate.length > 0) {
    return {
      status: "unverifiable",
      detail: schemas.indeterminate
        .map(
          (database) =>
            `${database.kind} database ${database.path} could not be read: ${database.reason}`,
        )
        .join("; "),
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
  signal?: AbortSignal;
}): Promise<UpdateStateVerification> {
  const databasePath = path.resolve(resolveOpenClawStateSqlitePath(params.env));
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
