import fs from "node:fs/promises";
import { z } from "zod";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isValidAgentId, normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { preflightOpenClawAgentDatabasePath } from "../state/openclaw-agent-schema-inspection.js";
import type { OpenClawAgentSchemaPreflightResult } from "../state/openclaw-database-preflight.types.js";
import { resolveUserPath } from "../utils.js";
import { backupSqliteCreateCommand, backupSqliteRestoreCommand } from "./backup-sqlite.js";

const agentIdSchema = z
  .string()
  .refine(
    (value) => isValidAgentId(value) && normalizeAgentId(value) === value,
    "Agent ID must be canonical",
  );
const operationFields = { id: z.string().min(1).max(256), agentId: agentIdSchema };
const pathname = z.string().trim().min(1);
const operationSchema = z.discriminatedUnion("operation", [
  z.object({ ...operationFields, operation: z.literal("create"), repository: pathname }).strict(),
  z
    .object({
      ...operationFields,
      operation: z.literal("restore"),
      snapshot: pathname,
      target: pathname,
    })
    .strict(),
  z.object({ ...operationFields, operation: z.literal("preflight"), path: pathname }).strict(),
]);
const requestSchema = z
  .object({
    schema: z.literal("openclaw.sqlite-batch.v1"),
    operations: z.array(operationSchema).min(1).max(1_000),
  })
  .strict()
  .refine(
    (request) =>
      new Set(request.operations.map((operation) => operation.id)).size ===
      request.operations.length,
    "Batch operation IDs must be unique",
  );

type SqliteBatchOperation = z.infer<typeof operationSchema>;
type SqliteBatchRequest = z.infer<typeof requestSchema>;
type CompletedOperation = { id: string; status: "completed" } & (
  | { operation: "create"; result: Awaited<ReturnType<typeof backupSqliteCreateCommand>> }
  | { operation: "restore"; result: Awaited<ReturnType<typeof backupSqliteRestoreCommand>> }
  | { operation: "preflight"; result: OpenClawAgentSchemaPreflightResult }
);
type SqliteBatchOutcome =
  | CompletedOperation
  | {
      id: string;
      operation: SqliteBatchOperation["operation"];
      status: "failed" | "skipped";
      error: {
        code:
          | "create-failed"
          | "restore-failed"
          | "preflight-failed"
          | "preflight-refused"
          | "prior-operation-failed";
        message: string;
      };
      result?: OpenClawAgentSchemaPreflightResult;
    };
export type SqliteBatchResult = {
  schema: "openclaw.sqlite-batch-result.v1";
  ok: boolean;
  outcomes: SqliteBatchOutcome[];
};

async function readRequest(requestPath: string): Promise<SqliteBatchRequest> {
  const handle = await fs.open(
    resolveUserPath(requestPath),
    fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
  );
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error("SQLite batch request must be a regular JSON file.");
    }
    const bytes = await readFileDescriptorBounded(handle.fd, 1024 * 1024);
    return requestSchema.parse(JSON.parse(bytes.toString("utf8")));
  } finally {
    await handle.close();
  }
}

async function runOperation(
  runtime: RuntimeEnv,
  operation: SqliteBatchOperation,
): Promise<SqliteBatchOutcome> {
  const { id, agentId } = operation;
  try {
    if (operation.operation === "create") {
      const result = await backupSqliteCreateCommand(runtime, {
        agent: agentId,
        repository: operation.repository,
      });
      return { id, operation: "create", status: "completed", result };
    }
    if (operation.operation === "restore") {
      const result = await backupSqliteRestoreCommand(runtime, operation.snapshot, {
        target: operation.target,
        expectedIdentity: { role: "agent", agentId },
      });
      return { id, operation: "restore", status: "completed", result };
    }
    const result = await preflightOpenClawAgentDatabasePath(
      resolveUserPath(operation.path),
      agentId,
    );
    return result.status === "exact"
      ? { id, operation: "preflight", status: "completed", result }
      : {
          id,
          operation: "preflight",
          status: "failed",
          result,
          error: {
            code: "preflight-refused",
            message: result.reason ?? `Agent schema preflight returned ${result.status}`,
          },
        };
  } catch (error) {
    return {
      id,
      operation: operation.operation,
      status: "failed",
      error: {
        code: `${operation.operation}-failed`,
        message: formatErrorMessage(error),
      },
    };
  }
}

export async function backupSqliteBatchCommand(
  runtime: RuntimeEnv,
  requestPath: string,
  options: { json?: boolean },
): Promise<SqliteBatchResult> {
  const request = await readRequest(requestPath);
  const outcomes: SqliteBatchOutcome[] = [];
  const operationRuntime: RuntimeEnv = { ...runtime, log: () => undefined };
  let failedOperation: string | undefined;
  for (const operation of request.operations) {
    if (failedOperation !== undefined) {
      outcomes.push({
        id: operation.id,
        operation: operation.operation,
        status: "skipped",
        error: {
          code: "prior-operation-failed",
          message: `Skipped after failed operation ${failedOperation}`,
        },
      });
      continue;
    }
    const outcome = await runOperation(operationRuntime, operation);
    outcomes.push(outcome);
    if (outcome.status === "failed") {
      failedOperation = operation.id;
    }
  }
  const report: SqliteBatchResult = {
    schema: "openclaw.sqlite-batch-result.v1",
    ok: failedOperation === undefined,
    outcomes,
  };
  if (options.json) {
    writeRuntimeJson(runtime, report);
  } else {
    for (const outcome of outcomes) {
      runtime.log(
        `${outcome.id}: ${outcome.operation} ${outcome.status}${outcome.status === "completed" ? "" : ` — ${outcome.error.message}`}`,
      );
    }
  }
  if (!report.ok) {
    runtime.exit(1);
  }
  return report;
}
