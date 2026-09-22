import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { z } from "zod";
import type { SpawnResult } from "../process/exec.js";
import { NodeWorkerWorkspaceTransferInputSchema } from "./node-workspace-transfer-protocol.js";
import { hasExactOwnKeys, workerProtocolObject } from "./protocol-record.js";
import {
  isWorkspaceInspectionCommand,
  WORKSPACE_INSPECTION_COMMAND,
  WORKSPACE_INSPECTION_MAX_BYTES,
} from "./workspace-inspection-protocol.js";

const IDENTIFIER_MAX_CHARS = 256;
const GATEWAY_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
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
const SeedInput = z.union([
  workerProtocolObject({ action: z.literal("apply"), key: SeedKey }),
  workerProtocolObject({
    action: z.literal("store"),
    key: SeedKey,
    maxAgeMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  }),
]);
const identifier = (label: string, maxChars = IDENTIFIER_MAX_CHARS) =>
  z.custom<string>(
    (value) =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxChars &&
      value.trim() === value &&
      !value.includes("\0"),
    { error: `INVALID_REQUEST: ${label} must be a bounded non-empty identifier` },
  );
const WorkspaceInput = workerProtocolObject({
  gatewayNamespace: identifier("gatewayNamespace").refine(
    (value) => typeof value === "string" && GATEWAY_NAMESPACE_PATTERN.test(value),
    { error: "INVALID_REQUEST: gatewayNamespace must be a safe bounded path component" },
  ),
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
});
export type NodeWorkerWorkspaceSeedInput = z.infer<typeof SeedInput>;
export type NodeWorkerWorkspaceExecInput = z.infer<typeof WorkspaceInput>;

export type NodeWorkerWorkspaceExecResult = SpawnResult & { workspaceDir: string };

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
  const inspection = isWorkspaceInspectionCommand(input.argv);
  if (
    input.argv[0] === NODE_WORKSPACE_DRAIN_COMMAND &&
    (input.argv.length !== 1 ||
      input.input !== undefined ||
      input.transfer !== undefined ||
      input.seed !== undefined ||
      input.resetWorkspace !== undefined)
  ) {
    throw new Error("INVALID_REQUEST: workspace drain owns its operation");
  }
  if (
    input.argv[0] === WORKSPACE_INSPECTION_COMMAND &&
    (!inspection ||
      input.transfer !== undefined ||
      input.seed !== undefined ||
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

function isBoundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function isAbsoluteHostPath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function parseNodeWorkerWorkspaceExecResult(
  value: unknown,
  argv: readonly string[] = [],
): NodeWorkerWorkspaceExecResult | null {
  if (
    !isRecord(value) ||
    !hasExactOwnKeys(
      value,
      ["workspaceDir", "stdout", "stderr", "code", "signal", "killed", "termination"],
      [
        "stdoutTruncatedBytes",
        "stderrTruncatedBytes",
        "noOutputTimedOut",
        "outputLimitExceeded",
        "outputErrorStream",
      ],
    ) ||
    typeof value.workspaceDir !== "string" ||
    !isAbsoluteHostPath(value.workspaceDir) ||
    value.workspaceDir.length > 4_096 ||
    !isBoundedText(
      value.stdout,
      isWorkspaceInspectionCommand(argv) ? WORKSPACE_INSPECTION_MAX_BYTES : OUTPUT_MAX_BYTES,
    ) ||
    !isBoundedText(value.stderr, STDERR_MAX_BYTES) ||
    (value.code !== null &&
      (!Number.isSafeInteger(value.code) || typeof value.code !== "number")) ||
    (value.signal !== null &&
      (typeof value.signal !== "string" ||
        value.signal.length === 0 ||
        value.signal.length > 32)) ||
    typeof value.killed !== "boolean" ||
    (value.termination !== "exit" &&
      value.termination !== "timeout" &&
      value.termination !== "no-output-timeout" &&
      value.termination !== "signal")
  ) {
    return null;
  }
  for (const key of ["stdoutTruncatedBytes", "stderrTruncatedBytes"] as const) {
    const count = value[key];
    if (
      count !== undefined &&
      (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    ) {
      return null;
    }
  }
  if (
    (value.noOutputTimedOut !== undefined && typeof value.noOutputTimedOut !== "boolean") ||
    (value.outputLimitExceeded !== undefined && typeof value.outputLimitExceeded !== "boolean") ||
    (value.outputErrorStream !== undefined &&
      value.outputErrorStream !== "stdout" &&
      value.outputErrorStream !== "stderr")
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
