import { isFailoverError } from "../agents/failover/error.js";
import { FAILOVER_REASONS } from "../agents/failover/signal.js";

const resultCodes = [
  "aborted",
  "yielded",
  "continuation_pending",
  "timeout",
  "failure_signal",
  "terminal_tool_failure",
  "accepted_spawn",
  "runtime_mismatch",
  "command_exit",
  "context_overflow",
  "compaction_failure",
  "compaction_replay_refresh_required",
  "role_ordering",
  "image_size",
  "retry_limit",
  "incomplete_turn",
  "hook_block",
] as const;
export class SupervisedAgentResultError extends Error {
  constructor(
    readonly reason: (typeof resultCodes)[number],
    message: string,
  ) {
    super(message);
  }
}
const osCodes = [
  "ENOENT",
  "EACCES",
  "EPERM",
  "EROFS",
  "ENOSPC",
  "EDQUOT",
  "EMFILE",
  "ENFILE",
  "EPIPE",
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ERR_MODULE_NOT_FOUND",
] as const;
const nativeSignals = [
  "SIGABRT",
  "SIGALRM",
  "SIGBUS",
  "SIGFPE",
  "SIGHUP",
  "SIGILL",
  "SIGINT",
  "SIGKILL",
  "SIGPIPE",
  "SIGQUIT",
  "SIGSEGV",
  "SIGSYS",
  "SIGTERM",
  "SIGTRAP",
  "SIGUSR1",
  "SIGUSR2",
  "SIGXCPU",
  "SIGXFSZ",
  "SIGBREAK",
] as const;
const abortObservations = [
  "oom_and_crash_banners",
  "oom_banner",
  "crash_banner",
  "stderr_incomplete",
  "stderr_absent",
  "no_known_banner",
] as const;
const diagnostics = new Set([
  "supervised-runtime:cli:initialize",
  "supervised-runtime:cli:protocol",
  "supervised-runtime:cli:exit:other",
  "supervised-runtime:cli:signal:other",
  ...Array.from({ length: 256 }, (_, code) => `supervised-runtime:cli:exit:${code}`),
  ...nativeSignals.map((signal) => `supervised-runtime:cli:signal:${signal}`),
  ...abortObservations.map((observation) => `supervised-runtime:cli:signal:SIGABRT:${observation}`),
  "supervised-runtime:unknown:unclassified",
  ...FAILOVER_REASONS.map((reason) => `supervised-runtime:failover:${reason}`),
  ...osCodes.map((code) => `supervised-runtime:os:${code}`),
  ...resultCodes.map((reason) => `supervised-runtime:result:${reason}`),
]);

function processStderrObservation(detail: object): (typeof abortObservations)[number] | undefined {
  const observation = Object.getOwnPropertyDescriptor(detail, "processStderr")?.value;
  if (!observation || typeof observation !== "object") {
    return undefined;
  }
  const received = Object.getOwnPropertyDescriptor(observation, "received")?.value;
  const complete = Object.getOwnPropertyDescriptor(observation, "complete")?.value;
  const crash = Object.getOwnPropertyDescriptor(observation, "crashBanner")?.value;
  const oom = Object.getOwnPropertyDescriptor(observation, "outOfMemoryBanner")?.value;
  if (
    typeof received !== "boolean" ||
    typeof complete !== "boolean" ||
    typeof crash !== "boolean" ||
    typeof oom !== "boolean" ||
    (!received && (crash || oom))
  ) {
    return undefined;
  }
  // Observed banners are process-wide, not evidence of a turn's failure cause.
  if (oom) {
    return crash ? "oom_and_crash_banners" : "oom_banner";
  }
  if (crash) {
    return "crash_banner";
  }
  return !complete ? "stderr_incomplete" : received ? "no_known_banner" : "stderr_absent";
}

function cliTransportDiagnostic(error: object): string | undefined {
  const detail = Object.getOwnPropertyDescriptor(error, "diagnostic")?.value;
  if (!detail || typeof detail !== "object") {
    return undefined;
  }
  const kind = Object.getOwnPropertyDescriptor(detail, "kind")?.value;
  if (kind === "initialize" || kind === "protocol") {
    return `supervised-runtime:cli:${kind}`;
  }
  if (kind !== "exit") {
    return undefined;
  }
  const signal = Object.getOwnPropertyDescriptor(detail, "signal")?.value;
  if (typeof signal === "string") {
    const line = `supervised-runtime:cli:signal:${signal}`;
    const observation = signal === "SIGABRT" ? processStderrObservation(detail) : undefined;
    if (observation) {
      return `${line}:${observation}`;
    }
    return diagnostics.has(line) ? line : "supervised-runtime:cli:signal:other";
  }
  const code = Object.getOwnPropertyDescriptor(detail, "exitCode")?.value;
  return typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255
    ? `supervised-runtime:cli:exit:${code}`
    : "supervised-runtime:cli:exit:other";
}

/** Only closed classifications cross the subprocess pipe. Provider messages,
 * arbitrary codes, profile ids, model text and error objects never do. */
export function supervisedRuntimeFailureDiagnostic(error: unknown): string {
  const seen = new Set<object>();
  let current = error;
  for (let depth = 0; depth < 4; depth++) {
    if (!current || typeof current !== "object" || seen.has(current)) {
      break;
    }
    seen.add(current);
    try {
      // SDK and source may have distinct module identities. Validate only fixed
      // own-data metadata; this diagnostic is never a retry or authority signal.
      if (Object.getOwnPropertyDescriptor(current, "cliBackendTransportError")?.value === "v1") {
        const diagnostic = cliTransportDiagnostic(current);
        if (diagnostic) {
          return diagnostic;
        }
      }
      const diagnostic =
        current instanceof SupervisedAgentResultError
          ? `supervised-runtime:result:${current.reason}`
          : isFailoverError(current)
            ? `supervised-runtime:failover:${current.reason}`
            : `supervised-runtime:os:${Object.getOwnPropertyDescriptor(current, "code")?.value}`;
      if (diagnostics.has(diagnostic)) {
        return diagnostic;
      }
      current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
    } catch {
      // Unknown accessors/proxies are not a source of diagnostic text.
      break;
    }
  }
  return "supervised-runtime:unknown:unclassified";
}

/** Parse the closed control record, not arbitrary child output. */
export function readSupervisedRuntimeDiagnostic(output: string): string | undefined {
  return output.split("\n").find((line) => diagnostics.has(line));
}
