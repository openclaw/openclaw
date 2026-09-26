import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import type { SpawnResult } from "../process/exec.js";
import { NodeWorkerWorkspaceTransferInputSchema } from "./node-workspace-transfer-protocol.js";
import {
  WorkerGatewayNamespace,
  workerProtocolIdentifier as identifier,
  workerProtocolObject,
} from "./protocol-record.js";
import {
  isWorkspaceInspectionCommand,
  WORKSPACE_INSPECTION_COMMAND,
  WORKSPACE_INSPECTION_MAX_BYTES,
} from "./workspace-inspection-protocol.js";

const REQUEST_MAX_BYTES = 256 * 1024;
export const NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES = 128 * 1024;
const OUTPUT_MAX_BYTES = 64 * 1024;
const STDERR_MAX_BYTES = 16 * 1024;
const ARGV_MAX_ITEMS = 128;
// Workspace scripts are shipped through this private command and remain bounded by
// REQUEST_MAX_BYTES; the canonical manifest script is larger than an ordinary argv item.
const ARG_MAX_BYTES = 128 * 1024;
const TIMEOUT_MAX_MS = 10 * 60 * 1000;
export const NODE_WORKSPACE_DRAIN_COMMAND = "openclaw-internal-workspace-drain";

const SeedKey = z.string().regex(/^[a-f0-9]{64}$/u);
const WorkspaceProcessId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
const WorkspaceProcess = workerProtocolObject({
  action: z.enum(["start", "status", "stop"]),
  processId: WorkspaceProcessId,
});
export type NodeWorkerWorkspaceProcessInput = z.infer<typeof WorkspaceProcess>;
type NodeWorkerWorkspaceProcessResult = {
  processId: string;
  state: "running" | "exited";
};
const SeedInput = z.union([
  workerProtocolObject({ action: z.literal("apply"), key: SeedKey }),
  workerProtocolObject({
    action: z.literal("store"),
    key: SeedKey,
    maxAgeMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
]);
const WorkspaceInput = workerProtocolObject({
  gatewayNamespace: WorkerGatewayNamespace,
  environmentId: identifier("environmentId"),
  sessionId: identifier("sessionId"),
  sessionKey: identifier("sessionKey", 1_024).optional(),
  preparationKey: z
    .custom<string>((value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value), {
      error: "INVALID_REQUEST: preparationKey must be a SHA-256 hex digest",
    })
    .optional(),
  generation: z.custom<number>(
    (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    { error: "INVALID_REQUEST: generation must be a non-negative safe integer" },
  ),
  argv: z
    .custom<string[]>(
      (value) =>
        Array.isArray(value) &&
        value.length > 0 &&
        value.length <= ARGV_MAX_ITEMS &&
        value.every(
          (arg) =>
            typeof arg === "string" &&
            arg.length > 0 &&
            !arg.includes("\0") &&
            Buffer.byteLength(arg, "utf8") <= ARG_MAX_BYTES,
        ),
      { error: "INVALID_REQUEST: argv must be a bounded non-empty string array" },
    )
    .transform((argv) => [...argv]),
  input: z
    .string({ error: "INVALID_REQUEST: workspace command input exceeds its bound" })
    .optional(),
  timeoutMs: z
    .custom<number>(
      (value) =>
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 1 &&
        value <= TIMEOUT_MAX_MS,
      { error: "INVALID_REQUEST: workspace command timeout is invalid" },
    )
    .optional(),
  resetWorkspace: z
    .boolean({ error: "INVALID_REQUEST: resetWorkspace must be a boolean" })
    .optional(),
  transfer: NodeWorkerWorkspaceTransferInputSchema.optional(),
  seed: SeedInput.optional(),
  process: WorkspaceProcess.optional(),
});
export type NodeWorkerWorkspaceSeedInput = z.infer<typeof SeedInput>;
export type NodeWorkerWorkspaceExecInput = z.infer<typeof WorkspaceInput>;

export type NodeWorkerWorkspaceExecResult = SpawnResult & {
  workspaceDir: string;
  process?: NodeWorkerWorkspaceProcessResult;
};

function parseJson(raw?: string | null): unknown {
  if (!raw || Buffer.byteLength(raw, "utf8") > WORKSPACE_INSPECTION_MAX_BYTES * 2) {
    throw new Error("INVALID_REQUEST: invalid node worker workspace request");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error("INVALID_REQUEST: malformed node worker workspace request");
  }
}

export function parseNodeWorkerWorkspaceExecInput(
  raw?: string | null,
): NodeWorkerWorkspaceExecInput {
  const value = parseJson(raw);
  const parsed = WorkspaceInput.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue?.path[0] === "transfer") {
      throw new Error("INVALID_REQUEST: workspace transfer is invalid");
    }
    if (issue?.path[0] === "process") {
      throw new Error("INVALID_REQUEST: workspace process operation is invalid");
    }
    if (issue?.path[0] === "seed") {
      const validKey =
        isRecord(value) && isRecord(value.seed) && SeedKey.safeParse(value.seed.key).success;
      throw new Error(
        validKey
          ? "INVALID_REQUEST: workspace seed action or maxAgeMs is invalid"
          : "INVALID_REQUEST: workspace seed key must be a SHA-256 hex digest",
      );
    }
    throw new Error(
      issue?.path.length ? issue.message : "INVALID_REQUEST: invalid node worker workspace request",
    );
  }
  const input = parsed.data;
  if (input.process && (input.seed || input.transfer || input.resetWorkspace !== undefined)) {
    throw new Error("INVALID_REQUEST: workspace process owns its operation");
  }
  if (
    input.process &&
    input.process.action !== "start" &&
    (input.argv.length !== 1 ||
      input.argv[0] !== "openclaw-internal-workspace-process" ||
      input.input !== undefined)
  ) {
    throw new Error("INVALID_REQUEST: workspace process control accepts no command");
  }
  const inspection = isWorkspaceInspectionCommand(input.argv);
  if (
    input.argv[0] === NODE_WORKSPACE_DRAIN_COMMAND &&
    (input.argv.length !== 1 ||
      input.input !== undefined ||
      input.transfer !== undefined ||
      input.seed !== undefined ||
      input.process !== undefined ||
      input.resetWorkspace !== undefined)
  ) {
    throw new Error("INVALID_REQUEST: workspace drain owns its operation");
  }
  if (
    input.argv[0] === WORKSPACE_INSPECTION_COMMAND &&
    (!inspection ||
      input.transfer !== undefined ||
      input.seed !== undefined ||
      input.process !== undefined ||
      input.resetWorkspace !== undefined)
  ) {
    throw new Error("INVALID_REQUEST: workspace inspection owns its operation");
  }
  if (!inspection && Buffer.byteLength(raw ?? "", "utf8") > REQUEST_MAX_BYTES) {
    throw new Error("INVALID_REQUEST: workspace command request exceeds its bound");
  }
  if (
    input.input !== undefined &&
    Buffer.byteLength(input.input, "utf8") >
      (inspection ? WORKSPACE_INSPECTION_MAX_BYTES : NODE_WORKER_WORKSPACE_STDIN_MAX_BYTES)
  ) {
    throw new Error("INVALID_REQUEST: workspace command input exceeds its bound");
  }
  if (
    input.seed !== undefined &&
    (input.transfer !== undefined || input.resetWorkspace !== undefined)
  ) {
    throw new Error(
      "INVALID_REQUEST: workspace seed cannot combine with transfer or resetWorkspace",
    );
  }
  return input;
}

const TruncatedBytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional();
const WorkspaceResult = workerProtocolObject({
  workspaceDir: z
    .string()
    .max(4_096)
    .refine((value) => path.posix.isAbsolute(value) || path.win32.isAbsolute(value)),
  stdout: z.string(),
  stderr: z.string().refine((value) => Buffer.byteLength(value, "utf8") <= STDERR_MAX_BYTES),
  code: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).nullable(),
  signal: z.string().min(1).max(32).nullable(),
  killed: z.boolean(),
  termination: z.enum(["exit", "timeout", "no-output-timeout", "signal"]),
  stdoutTruncatedBytes: TruncatedBytes,
  stderrTruncatedBytes: TruncatedBytes,
  noOutputTimedOut: z.boolean().optional(),
  outputLimitExceeded: z.boolean().optional(),
  outputErrorStream: z.enum(["stdout", "stderr"]).optional(),
  process: workerProtocolObject({
    processId: WorkspaceProcessId,
    state: z.enum(["running", "exited"]),
  }).optional(),
});

export function parseNodeWorkerWorkspaceExecResult(
  value: unknown,
  argv: readonly string[] = [],
): NodeWorkerWorkspaceExecResult | null {
  const parsed = WorkspaceResult.safeParse(value);
  if (
    !parsed.success ||
    Buffer.byteLength(parsed.data.stdout, "utf8") >
      (isWorkspaceInspectionCommand(argv) ? WORKSPACE_INSPECTION_MAX_BYTES : OUTPUT_MAX_BYTES)
  ) {
    return null;
  }
  return value as NodeWorkerWorkspaceExecResult;
}

export function projectNodeWorkerWorkspaceExecResult(
  workspaceDir: string,
  result: SpawnResult,
  argv: readonly string[] = [],
): NodeWorkerWorkspaceExecResult {
  const projected = {
    workspaceDir,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    signal: result.signal,
    killed: result.killed,
    termination: result.termination,
    ...(result.stdoutTruncatedBytes === undefined
      ? {}
      : { stdoutTruncatedBytes: result.stdoutTruncatedBytes }),
    ...(result.stderrTruncatedBytes === undefined
      ? {}
      : { stderrTruncatedBytes: result.stderrTruncatedBytes }),
    ...(result.noOutputTimedOut === undefined ? {} : { noOutputTimedOut: result.noOutputTimedOut }),
    ...(result.outputLimitExceeded === undefined
      ? {}
      : { outputLimitExceeded: result.outputLimitExceeded }),
    ...(result.outputErrorStream === undefined
      ? {}
      : { outputErrorStream: result.outputErrorStream }),
  };
  const parsed = parseNodeWorkerWorkspaceExecResult(projected, argv);
  if (!parsed) {
    throw new Error("node worker workspace result violated its bounded contract");
  }
  return parsed;
}

export const NODE_WORKER_WORKSPACE_STDOUT_MAX_BYTES = OUTPUT_MAX_BYTES;
export const NODE_WORKER_WORKSPACE_STDERR_MAX_BYTES = STDERR_MAX_BYTES;
