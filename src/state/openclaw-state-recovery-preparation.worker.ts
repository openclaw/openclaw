import { isDeepStrictEqual } from "node:util";
import { formatErrorMessage } from "../infra/errors.js";
import { openNodeSqliteDatabase, resolveImmutableSqliteFileUri } from "../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import { readSqliteUserVersion } from "../infra/sqlite-user-version.js";
import {
  STATE_RECOVERY_PREPARATION_CHILD_ARG,
  stateRecoveryPreparationRequestSchema,
  stateRecoveryPreparationResponseSchema,
} from "./openclaw-state-recovery-preparation-protocol.js";
import { prepareOpenClawStateRecoveryCopyInProcess } from "./openclaw-state-recovery-preparation.impl.js";
import { sanitizeOpenClawStateLeaseRows } from "./openclaw-state-snapshot-sanitizer.js";

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function readInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function run(): Promise<void> {
  let response;
  try {
    const request = stateRecoveryPreparationRequestSchema.parse(JSON.parse(await readInput()));
    const assertOwned = () => {
      if (process.ppid === 1) {
        throw new Error("Recovery preparation lost its parent process.");
      }
    };
    if (request.operation === "prepare-state") {
      const identity = await prepareOpenClawStateRecoveryCopyInProcess({
        ...request,
        assertOwned,
      });
      response = { ok: true as const, identity };
    } else if (request.operation === "sanitize-state") {
      assertOwned();
      const database = openNodeSqliteDatabase(request.targetPath);
      try {
        runSqliteImmediateTransactionSync(database, () => {
          assertOwned();
          sanitizeOpenClawStateLeaseRows(database);
          assertOwned();
        });
      } finally {
        database.close();
      }
      response = { ok: true as const };
    } else {
      assertOwned();
      const baseline = openNodeSqliteDatabase(resolveImmutableSqliteFileUri(request.baselinePath), {
        readOnly: true,
      });
      const candidate = openNodeSqliteDatabase(
        resolveImmutableSqliteFileUri(request.candidatePath),
        { readOnly: true },
      );
      try {
        const version = readSqliteUserVersion(candidate);
        const identitySql =
          "SELECT role,agent_id,schema_version FROM schema_meta WHERE meta_key='primary'";
        // SAFETY: the fixed projection is validated field-by-field below before use.
        const baselineIdentity = baseline.prepare(identitySql).get() as
          | { role?: unknown; agent_id?: unknown; schema_version?: unknown }
          | undefined;
        // SAFETY: the fixed projection is validated against the admitted baseline below.
        const candidateIdentity = candidate.prepare(identitySql).get() as
          | { role?: unknown; agent_id?: unknown; schema_version?: unknown }
          | undefined;
        const schema =
          "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name";
        if (
          version < 1 ||
          version > request.supportedVersion ||
          version !== readSqliteUserVersion(baseline) ||
          baselineIdentity?.role !== "agent" ||
          baselineIdentity.agent_id !== request.agentId ||
          baselineIdentity.schema_version !== version ||
          candidateIdentity?.role !== baselineIdentity.role ||
          candidateIdentity.agent_id !== baselineIdentity.agent_id ||
          candidateIdentity.schema_version !== baselineIdentity.schema_version ||
          !isDeepStrictEqual(candidate.prepare(schema).all(), baseline.prepare(schema).all())
        ) {
          throw new Error("Only unchanged supported agent representations can be prepared.");
        }
      } finally {
        try {
          candidate.close();
        } finally {
          baseline.close();
        }
      }
      assertOwned();
      response = { ok: true as const };
    }
  } catch (error) {
    response = {
      ok: false as const,
      error: formatErrorMessage(error),
      ...(errorCode(error) ? { code: errorCode(error) } : {}),
    };
  }
  process.stdout.write(
    `${JSON.stringify(stateRecoveryPreparationResponseSchema.parse(response))}\n`,
  );
}

if (process.argv[2] === STATE_RECOVERY_PREPARATION_CHILD_ARG) {
  void run().catch(() => {
    process.exitCode = 1;
  });
}
