import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessage } from "../infra/errors.js";

type SystemAgentInferenceStage = "agent-turn" | "planner" | "conversation";

const INFERENCE_UNAVAILABLE_MESSAGE =
  "OpenClaw could not reach working inference. Run `openclaw onboard` on the machine running OpenClaw to reconnect — it live-tests the route before saving it. Then try again.";
const REQUEST_FAILED_MESSAGE = "OpenClaw could not complete this request. Try again.";
const ROUTE_INCOMPATIBLE_MESSAGE =
  "OpenClaw cannot use the configured inference route. Choose a compatible model or CLI backend, then start a new conversation.";
const INFERENCE_FAILURE_SUMMARY_MAX_CHARS = 300;

/** A known route incompatibility that retrying the same request cannot repair. */
export class SystemAgentInferenceRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemAgentInferenceRouteError";
  }
}

function inferenceUnavailableMessage(failures: readonly unknown[]): string {
  if (failures.length === 0) {
    return INFERENCE_UNAVAILABLE_MESSAGE;
  }
  const message =
    failures[0] instanceof SystemAgentInferenceRouteError
      ? ROUTE_INCOMPATIBLE_MESSAGE
      : REQUEST_FAILED_MESSAGE;
  const detail = formatErrorMessage(failures[0]).trim();
  if (!detail) {
    return message;
  }
  const summary =
    detail.length > INFERENCE_FAILURE_SUMMARY_MAX_CHARS
      ? `${truncateUtf16Safe(detail, INFERENCE_FAILURE_SUMMARY_MAX_CHARS - 1)}…`
      : detail;
  return `${message} Cause: ${summary}`;
}

/** Safe public error for an OpenClaw turn that could not complete with intelligence. */
export class SystemAgentInferenceUnavailableError extends Error {
  readonly code = "SYSTEM_AGENT_INFERENCE_UNAVAILABLE";

  constructor(
    readonly stage: SystemAgentInferenceStage,
    readonly failures: readonly unknown[] = [],
  ) {
    super(
      inferenceUnavailableMessage(failures),
      failures[0] === undefined ? undefined : { cause: failures[0] },
    );
    this.name = "SystemAgentInferenceUnavailableError";
  }
}

export function isSystemAgentInferenceUnavailableError(
  error: unknown,
): error is SystemAgentInferenceUnavailableError {
  return (
    error instanceof SystemAgentInferenceUnavailableError ||
    (error instanceof Error &&
      "code" in error &&
      error.code === "SYSTEM_AGENT_INFERENCE_UNAVAILABLE")
  );
}
