// Shared root CLI failure formatting with debug stack gating and recovery hints.
import { isInvalidConfigError } from "../config/io.invalid-config.js";
import { isGatewayTransportError } from "../gateway/transport-error.js";
import { getRootOptionAwareCommandPath } from "../infra/cli-root-options.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { formatErrorMessage, formatUncaughtError } from "../infra/errors.js";
import {
  UpdateSchemaRefusalError,
  type UpdateSchemaRefusalDatabase,
} from "../state/openclaw-update-schema-refusal.js";
import { formatCliCommand } from "./command-format.js";
import type { CronCliJobMatch } from "./cron-cli/cron-cli-error.js";

type FormatCliFailureOptions = {
  title: string;
  error: unknown;
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  includeDoctorHint?: boolean;
};

type CliFailureDebugOptions = Pick<FormatCliFailureOptions, "argv" | "env">;

export type CliJsonFailure = {
  ok: false;
  runId?: string;
  origin?: "gateway";
  error: {
    type: "cli_error";
    message: string;
    code?: string;
    databases?: readonly UpdateSchemaRefusalDatabase[];
    updaterVersion?: string;
    targetVersion?: string;
    commands?: readonly string[];
    matches?: readonly CronCliJobMatch[];
  };
};

export type CliGatewayRunFailure = { runId: string; origin: "gateway" };

const gatewayRunFailures = new WeakMap<Error, CliGatewayRunFailure>();

/** Agent dispatch supplies observed Gateway IDs; error identity and human output stay intact. */
export function recordCliGatewayRunFailure(error: unknown, runId: string | undefined): void {
  if (error instanceof Error && runId) {
    gatewayRunFailures.set(error, { runId, origin: "gateway" });
  }
}

/** Human diagnostics (agent transport-loss hint) read back the run identity recorded at dispatch. */
export function readCliGatewayRunFailure(error: unknown): CliGatewayRunFailure | undefined {
  return error instanceof Error ? gatewayRunFailures.get(error) : undefined;
}

export class ExpectedCliError extends Error {
  readonly humanOutput: string;
  readonly humanOutputWritten: boolean;
  readonly machineOutput: string;
  readonly matches?: readonly CronCliJobMatch[];

  constructor(params: {
    message: string;
    humanOutput: string;
    humanOutputWritten?: boolean;
    machineOutput: string;
    matches?: readonly CronCliJobMatch[];
  }) {
    super(params.message);
    this.name = "ExpectedCliError";
    this.humanOutput = params.humanOutput;
    this.humanOutputWritten = params.humanOutputWritten ?? false;
    this.machineOutput = params.machineOutput;
    this.matches = params.matches;
  }
}

export function isGatewayCredentialsCliError(
  error: unknown,
): error is Error & { method: string; configPath: string } {
  // Keep the root failure renderer lean; importing gateway/call would pull the
  // transport and config stack into every CLI startup path.
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === "GatewayCredentialsRequiredError" &&
    "method" in error &&
    typeof error.method === "string" &&
    "configPath" in error &&
    typeof error.configPath === "string"
  );
}

// These producers already supply the operator remedy. Classify by name to keep
// their runtime modules out of the root CLI's cold startup path.
const EXPECTED_CLI_ERROR_NAMES = new Set([
  "GatewayExplicitAuthRequiredError",
  "AgentSelectionRequiredError",
  "ConfigReadOnlyError",
  "NixModeConfigMutationError",
  "LocalStateOwnerError",
]);

export function isExpectedCliError(error: unknown): error is Error {
  return (
    error instanceof ExpectedCliError ||
    isGatewayCredentialsCliError(error) ||
    (error instanceof Error && EXPECTED_CLI_ERROR_NAMES.has(error.name)) ||
    isGatewayTransportError(error)
  );
}

export function rethrowExpectedCliError(error: unknown): void {
  if (isExpectedCliError(error)) {
    throw error;
  }
}

function resolveExpectedCliOutput(error: Error) {
  return error instanceof ExpectedCliError
    ? error
    : {
        humanOutput: error.message,
        humanOutputWritten: false,
        machineOutput: error.message,
      };
}

/** Canonical machine-readable failure envelope for CLI-owned errors. */
export function formatCliJsonFailure(
  error: unknown,
  options: CliFailureDebugOptions = {},
): CliJsonFailure {
  const message = isExpectedCliError(error)
    ? formatErrorMessage(resolveExpectedCliOutput(error).machineOutput.trimEnd())
    : formatCliOperatorError(error, options);
  return {
    ok: false,
    ...readCliGatewayRunFailure(error),
    error: {
      type: "cli_error",
      message,
      ...(error instanceof ExpectedCliError && error.matches ? { matches: error.matches } : {}),
      ...(error instanceof UpdateSchemaRefusalError
        ? {
            code: error.code,
            databases: error.databases,
            updaterVersion: error.updaterVersion,
            targetVersion: error.targetVersion,
            commands: error.commands,
          }
        : {}),
    },
  };
}

function hasDebugArg(argv: string[] | undefined): boolean {
  for (const arg of argv ?? []) {
    // Arguments after the terminator belong to the child, not root stack-trace policy.
    if (arg === "--") {
      return false;
    }
    if (arg === "--debug" || arg === "--verbose") {
      return true;
    }
  }
  return false;
}

function shouldShowDebugDetails(
  argv: string[] | undefined = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return hasDebugArg(argv) || isTruthyEnvValue(env.OPENCLAW_DEBUG);
}

export function formatCliOperatorError(
  error: unknown,
  options: CliFailureDebugOptions = {},
): string {
  const includeCause = shouldShowDebugDetails(options.argv, options.env);
  const value =
    !includeCause && error instanceof Error ? error.message || error.name || "Error" : error;
  return formatErrorMessage(value);
}

function pushPrefixed(out: string[], value: string): void {
  for (const line of value.split("\n")) {
    if (line.trim().length > 0) {
      out.push(`[openclaw] ${line}`);
    }
  }
}

export function formatCliFailureLines(options: FormatCliFailureOptions): string[] {
  const env = options.env ?? process.env;
  const argv = options.argv ?? process.argv;
  const showDebugDetails = shouldShowDebugDetails(options.argv, env);
  // Admission and argument failures can precede the updater marker.
  const isUpdateCommand = getRootOptionAwareCommandPath(argv, 1)[0] === "update";
  // Update subprocesses use both marker values and retain captured reasons for recovery.
  const showUpdateDiagnostics = ["0", "1"].includes(env.OPENCLAW_UPDATE_IN_PROGRESS ?? "");
  if (
    isGatewayTransportError(options.error) &&
    !showDebugDetails &&
    !showUpdateDiagnostics &&
    !isUpdateCommand
  ) {
    const error = options.error;
    return [
      error.kind === "timeout"
        ? "OpenClaw took too long to respond."
        : error.requestDispatched
          ? "Lost the connection to OpenClaw."
          : "Couldn't connect to OpenClaw.",
      ...(error.requestDispatched
        ? ["Your request may have completed. Check its result before trying again."]
        : []),
      `Check the Control UI or run \`${formatCliCommand("openclaw gateway status", options.env)}\` in your terminal.`,
    ];
  }
  if (isExpectedCliError(options.error)) {
    const output = resolveExpectedCliOutput(options.error);
    return output.humanOutputWritten ? [] : output.humanOutput.trimEnd().split("\n");
  }

  // Default output stays terse; causes and stack traces require explicit debug intent.
  const stateBusy = collectNestedErrorCandidates(options.error).some(
    (error) => error instanceof Error && error.name === "GatewayStateOwnerContentionError",
  );
  if (!showDebugDetails && !showUpdateDiagnostics) {
    if (
      options.error instanceof UpdateSchemaRefusalError ||
      (options.error instanceof Error &&
        (options.error.name === "DoctorUnreadableStateDatabaseError" ||
          options.error.name === "OpenClawDatabaseSchemaPreflightError"))
    ) {
      // Doctor cannot repair these refusals; their producers own the required recovery steps.
      const lines = ["[openclaw] OpenClaw needs a manual recovery step."];
      lines.push(
        `[openclaw] Reason: ${formatCliOperatorError(options.error, { argv: options.argv, env })}`,
      );
      return lines;
    }
    // Config validation owns actionable file/field details; some startup paths have not printed them.
    const showReason = isInvalidConfigError(options.error)
      ? !options.error.diagnosticEmitted
      : isUpdateCommand;
    return [
      `[openclaw] ${options.title}`,
      ...(showReason
        ? [
            `[openclaw] Reason: ${formatCliOperatorError(options.error, { argv: options.argv, env })}`,
          ]
        : []),
      stateBusy
        ? "[openclaw] Another OpenClaw process is using your data. Wait for it to finish before trying again."
        : options.includeDoctorHint === false
          ? `[openclaw] For details, open Settings → Logs in the Control UI or run \`${formatCliCommand("openclaw logs --follow", env)}\`.`
          : `[openclaw] For help, run \`${formatCliCommand("openclaw doctor", env)}\`.`,
    ];
  }
  const lines = [
    `[openclaw] ${options.title}`,
    `[openclaw] Reason: ${formatCliOperatorError(options.error, {
      argv: options.argv,
      env,
    })}`,
  ];

  if (showDebugDetails) {
    lines.push("[openclaw] Stack:");
    pushPrefixed(lines, formatUncaughtError(options.error));
  }

  // Doctor needs the same state owner; inspect wrappers without loading the SQLite runtime.
  if (options.includeDoctorHint !== false && !stateBusy) {
    lines.push(`[openclaw] Try: ${formatCliCommand("openclaw doctor", env)}`);
  }
  lines.push(`[openclaw] Help: ${formatCliCommand("openclaw --help", env)}`);
  return lines;
}
