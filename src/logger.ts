// Provides root logger helpers and themed terminal output.
import { theme } from "../packages/terminal-core/src/theme.js";
import { isVerbose } from "./global-state.js";
import { attachDiagnosticLogSemantics } from "./logging/diagnostic-log-internal.js";
import type { DiagnosticLogSemantics } from "./logging/diagnostic-log-internal.js";
import { getLogger } from "./logging/logger.js";
import { createSubsystemLogger } from "./logging/subsystem.js";
import { defaultRuntime, type RuntimeEnv } from "./runtime.js";

const subsystemPrefixRe = /^([a-z][a-z0-9-]{1,20}):\s+(.*)$/i;

function splitSubsystem(message: string) {
  const match = message.match(subsystemPrefixRe);
  if (!match) {
    return null;
  }
  const [, subsystem, rest] = match;
  return { subsystem, rest };
}

type LogMethod = "info" | "warn" | "error";
type RuntimeMethod = "log" | "error";

function logWithSubsystem(params: {
  message: string;
  runtime: RuntimeEnv;
  runtimeMethod: RuntimeMethod;
  runtimeFormatter: (value: string) => string;
  loggerMethod: LogMethod;
  subsystemMethod: LogMethod;
  semantics: DiagnosticLogSemantics;
}) {
  const parsed = params.runtime === defaultRuntime ? splitSubsystem(params.message) : null;
  if (parsed) {
    createSubsystemLogger(parsed.subsystem)[params.subsystemMethod](
      parsed.rest,
      undefined,
      params.semantics,
    );
    return;
  }
  params.runtime[params.runtimeMethod](params.runtimeFormatter(params.message));
  getLogger()[params.loggerMethod](
    attachDiagnosticLogSemantics({}, params.semantics),
    params.message,
  );
}

const info = theme.info;
const warn = theme.warn;
const success = theme.success;
const danger = theme.error;

export function logInfo(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem({
    message,
    runtime,
    runtimeMethod: "log",
    runtimeFormatter: info,
    loggerMethod: "info",
    subsystemMethod: "info",
    semantics: {
      event: "cli.output.info",
      category: "cli.output",
      outcome: "success",
      reason: "operator_output",
    },
  });
}

export function logWarn(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem({
    message,
    runtime,
    runtimeMethod: "log",
    runtimeFormatter: warn,
    loggerMethod: "warn",
    subsystemMethod: "warn",
    semantics: {
      event: "cli.output",
      category: "cli.output",
      outcome: "warning",
      reason: "operator_output",
    },
  });
}

export function logSuccess(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem({
    message,
    runtime,
    runtimeMethod: "log",
    runtimeFormatter: success,
    loggerMethod: "info",
    subsystemMethod: "info",
    semantics: {
      event: "cli.output",
      category: "cli.output",
      outcome: "success",
      reason: "operator_output",
    },
  });
}

export function logError(message: string, runtime: RuntimeEnv = defaultRuntime) {
  logWithSubsystem({
    message,
    runtime,
    runtimeMethod: "error",
    runtimeFormatter: danger,
    loggerMethod: "error",
    subsystemMethod: "error",
    semantics: {
      event: "cli.output",
      category: "cli.output",
      outcome: "failure",
      reason: "operator_output",
    },
  });
}

export function logDebug(message: string) {
  // Always emit to file logger (level-filtered); console only when verbose.
  getLogger().debug(
    attachDiagnosticLogSemantics(
      {},
      {
        event: "cli.debug",
        category: "cli",
        outcome: "success",
        reason: "debug",
      },
    ),
    message,
  );
  if (isVerbose()) {
    console.log(theme.muted(message));
  }
}
