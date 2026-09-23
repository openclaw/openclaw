import { performance } from "node:perf_hooks";
import { isMainThread, threadId } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatErrorMessageWithCode } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("session-sqlite");
const SLOW_RECLAMATION_WORKER_MS = 1_000;

export function logSqliteReclamationWorkerOutcome(params: {
  startedAt: number;
  outcome: "resolved" | "rejected";
  failure?: unknown;
  kind: string;
  workerThreadId?: number;
  exitCode?: number;
  sessionId?: string;
}): void {
  const elapsedMs = Math.round(performance.now() - params.startedAt);
  if (params.outcome !== "rejected" && elapsedMs < SLOW_RECLAMATION_WORKER_MS) {
    return;
  }
  const failureText = (value: unknown) => {
    const text = formatErrorMessageWithCode(value);
    return truncateUtf16Safe(
      params.sessionId
        ? text.replaceAll(params.sessionId, redactIdentifier(params.sessionId))
        : text,
      2_048,
    );
  };
  log.warn(
    elapsedMs >= SLOW_RECLAMATION_WORKER_MS
      ? "slow SQLite reclamation Worker operation"
      : "SQLite reclamation Worker failed",
    {
      pid: process.pid,
      threadId,
      isMainThread,
      reclamationKind: params.kind,
      workerThreadId: params.workerThreadId,
      elapsedMs,
      outcome: params.outcome,
      exitCode: params.exitCode,
      ...(params.outcome === "rejected"
        ? {
            ...(params.sessionId ? { sessionIdHash: redactIdentifier(params.sessionId) } : {}),
            error: failureText(params.failure),
            errorFrame: failureText(
              toStringifiedError(params.failure)
                .stack?.split("\n")
                .find((line) => line.trimStart().startsWith("at "))
                ?.trim() ?? "",
            ),
          }
        : {}),
    },
  );
}
