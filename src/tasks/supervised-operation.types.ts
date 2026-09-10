import { createHash } from "node:crypto";
import { z } from "zod";

const id = z.string().min(1).max(128);
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** A request selects an accepted host profile; it is not an executable grant. */
export const SupervisedOperationRequestSchema = z.strictObject({
  key: id,
  kind: z.enum(["command", "review", "publication", "ci"]),
  profile: id,
  input: z.record(z.string().min(1).max(128), z.string().max(8192)).default({}),
});
export type SupervisedOperationRequest = z.infer<typeof SupervisedOperationRequestSchema>;

export function encodeSupervisedOperationRequest(value: unknown): {
  request: SupervisedOperationRequest;
  json: string;
  hash: string;
} {
  const parsed = SupervisedOperationRequestSchema.parse(value);
  const request = {
    ...parsed,
    input: Object.fromEntries(
      Object.entries(parsed.input).toSorted((left, right) => {
        // Preserve default tuple string ordering used by persisted request/contract hashes.
        const a = String(left);
        const b = String(right);
        return a < b ? -1 : a > b ? 1 : 0;
      }),
    ),
  };
  const json = JSON.stringify(request);
  if (Buffer.byteLength(json) > 8192) {
    throw new Error("Operation request exceeds its 8-KiB budget");
  }
  return { request, json, hash: createHash("sha256").update(json).digest("hex") };
}

export const SupervisedOperationOutcomeSchema = z.strictObject({
  status: z.enum(["succeeded", "failed", "cancelled", "input_required"]),
  summary: z.string().min(1).max(4096),
  // Digests and bounded observations, not authority reconstructed from stdout.
  facts: z.record(z.string().min(1).max(128), z.string().max(8192)).default({}),
  artifacts: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(4096),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(32)
    .default([]),
});
export type SupervisedOperationOutcome = z.infer<typeof SupervisedOperationOutcomeSchema>;

const OperationSchema = z.strictObject({
  operationId: id,
  flowId: id,
  episode: z.number().int().positive(),
  // The admitting episode revision is monotonic even across clock rollback.
  admissionRevision: z.number().int().positive(),
  request: SupervisedOperationRequestSchema,
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  // The accepted profile itself is separately immutable and checked at enqueue.
  contractHash: z.string().regex(/^[a-f0-9]{64}$/),
  workspaceVersion: z.uuid().nullable().default(null),
  state: z.enum([
    "queued",
    "running",
    "reconciling",
    "succeeded",
    "failed",
    "cancelled",
    "input_required",
  ]),
  generation: z.number().int().nonnegative(),
  executionId: id.nullable(),
  dueAt: time,
  deadlineAt: time,
  createdAt: time,
  updatedAt: time,
  publication: z
    .strictObject({
      artifactId: z.uuid(),
      sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
      headCommit: z.string().regex(/^[a-f0-9]{40}$/),
      tree: z.string().regex(/^[a-f0-9]{40}$/),
      baseCommit: z.string().regex(/^[a-f0-9]{40}$/),
      preparedAt: time,
      pushReservedAt: time.nullable(),
      createReservedAt: time.nullable(),
      remoteHead: z
        .string()
        .regex(/^[a-f0-9]{40}$/)
        .nullable(),
      pullRequestUrl: z.string().url().max(2048).nullable(),
    })
    .nullable()
    .default(null),
  reconciliations: z
    .array(
      z.strictObject({
        generation: z.number().int().positive(),
        at: time,
        evidence: z.string().min(1).max(4096),
      }),
    )
    .max(8)
    .default([]),
  outcome: SupervisedOperationOutcomeSchema.nullable(),
});
export type SupervisedOperation = z.infer<typeof OperationSchema>;

const ExecutionSchema = z.strictObject({
  // Captured with the pre-spawn reservation; absent in historical records.
  launchHost: z
    .strictObject({ hostId: z.string().regex(/^[a-f0-9]{64}$/), bootId: z.uuid() })
    .optional(),
  executionId: id,
  operationId: id,
  generation: z.number().int().positive(),
  ownerId: id,
  leaseExpiresAt: time,
  startedAt: time,
  dispatchedAt: time.nullable(),
  finishedAt: time.nullable(),
  // Process identity is evidence for reconciliation, never a replacement for SQL ownership.
  process: z
    .strictObject({
      pid: z.number().int().positive(),
      startTime: z.number().nonnegative().finite(),
    })
    .nullable(),
  outcome: SupervisedOperationOutcomeSchema.nullable(),
  preparationError: z.string().min(1).max(2048).nullable().default(null),
});
export type SupervisedOperationExecution = z.infer<typeof ExecutionSchema>;

function boundedJson(value: unknown, limit: number): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > limit) {
    throw new Error("Operation record exceeds its serialized byte budget");
  }
  return json;
}

export function parseSupervisedOperation(value: unknown): SupervisedOperation {
  const operation = OperationSchema.parse(value);
  boundedJson(operation, 48 * 1024);
  if (encodeSupervisedOperationRequest(operation.request).hash !== operation.inputHash) {
    throw new Error("Operation request digest mismatch");
  }
  const terminal = !["queued", "running", "reconciling"].includes(operation.state);
  if (
    terminal !== Boolean(operation.outcome) ||
    (operation.outcome && operation.outcome.status !== operation.state)
  ) {
    throw new Error("Operation state and outcome disagree");
  }
  return operation;
}

export function parseSupervisedOperationExecution(value: unknown): SupervisedOperationExecution {
  const execution = ExecutionSchema.parse(value);
  boundedJson(execution, 40 * 1024);
  if ((execution.finishedAt !== null) !== (execution.outcome !== null)) {
    throw new Error("Execution receipt and completion time disagree");
  }
  return execution;
}

export function parseSupervisedOperationOutcome(value: unknown): SupervisedOperationOutcome {
  const outcome = SupervisedOperationOutcomeSchema.parse(value);
  boundedJson(outcome, 32 * 1024);
  return outcome;
}
