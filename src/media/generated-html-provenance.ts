import { lstat } from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { logVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isNotFoundPathError } from "../infra/path-guards.js";
import type { SqliteWorkerCommand } from "../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "../infra/sqlite-worker-operation-admission.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../state/openclaw-state-worker-error.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type {
  GeneratedHtmlProvenanceOperations,
  GeneratedHtmlProvenanceReadOperations,
  GeneratedHtmlProvenanceRow,
} from "./generated-html-provenance.worker-contract.js";

export async function readGeneratedHtmlProvenance(
  context: OpenClawStateWorkerContext,
  command: SqliteWorkerCommand<GeneratedHtmlProvenanceReadOperations>,
) {
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    command,
    { context, current: true },
  );
  context.admission.assertCurrent();
  if (!reply) {
    return undefined;
  }
  if (!reply.ok) {
    const error = new Error(reply.message);
    retainOpenClawStateWorkerErrorPayload(error, reply.error);
    throw hydrateOpenClawStateWorkerError(error, { includeOrdinary: true });
  }
  if (reply.type !== command.type) {
    throw new Error("Unexpected generated HTML provenance reply");
  }
  return reply;
}

export async function writeGeneratedHtmlProvenance(
  context: OpenClawStateWorkerContext,
  command: SqliteWorkerCommand<GeneratedHtmlProvenanceOperations>,
): Promise<number> {
  const captured = structuredClone(command);
  let admission: SqliteWorkerOperationAdmission | undefined;
  try {
    return await runOpenClawStateWorkerOperation(context, (scope) => scope.execute(captured), {
      createAdmission: () => {
        admission = createSqliteWorkerOperationAdmission((_request, grant) => {
          context.admission.assertCurrent();
          grant();
        });
        return { admission, nativeLocations: [context.admission.databasePath] };
      },
    });
  } catch (error) {
    const receipt = admission?.committed ?? admission?.settlement?.committed;
    if (
      isRecord(receipt?.facts) &&
      receipt.facts.type === captured.type &&
      typeof receipt.facts.result === "number"
    ) {
      return receipt.facts.result;
    }
    // Unknown outcomes retain their original error and are never replayed.
    throw error;
  }
}

export async function pruneGeneratedHtmlProvenance(
  context: OpenClawStateWorkerContext,
): Promise<void> {
  const reply = await readGeneratedHtmlProvenance(context, {
    type: "generatedHtmlProvenance.list",
    input: undefined,
  });
  const rows = reply?.type === "generatedHtmlProvenance.list" ? reply.rows : [];
  const stale: GeneratedHtmlProvenanceRow[] = [];
  for (const row of rows) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(row.realpath);
    } catch (error) {
      if (isNotFoundPathError(error)) {
        stale.push(row);
      } else {
        logVerbose(
          `trusted-html prune kept uninspectable marker (${row.realpath}): ${formatErrorMessage(error)}`,
        );
      }
      continue;
    }
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      stale.push(row);
    }
  }
  if (stale.length === 0) {
    return;
  }
  const removed = await writeGeneratedHtmlProvenance(context, {
    type: "generatedHtmlProvenance.prune",
    input: stale,
  });
  logVerbose(`trusted-html prune removed ${removed} stale marker(s)`);
}
