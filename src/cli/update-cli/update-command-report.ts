/** Interactive, explicit consent flow for one final update failure report. */
import { isCancel } from "@clack/prompts";
import { confirm, select } from "../../commands/configure.shared.js";
import { resolveStateDir } from "../../config/paths.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  prepareUpdateFailureReport,
  submitUpdateFailureReport,
  type UpdateFailureReportSubmitResult,
  type PreparedUpdateFailureReport,
} from "../../infra/update-failure-report.js";
import { getUpdateRun } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { RuntimeEnv } from "../../runtime.js";

type UpdateFailureAction = "triage" | "report" | "status" | "browser" | "dismiss";

function renderSubmissionResult(
  result: UpdateFailureReportSubmitResult,
  browserRequested: boolean,
): string[] {
  if (result.status === "created") {
    return [`Created GitHub issue: ${result.url}`, ...(result.message ? [result.message] : [])];
  }
  if (result.status === "fallback") {
    return [
      browserRequested
        ? result.message
        : `GitHub issue creation was unavailable: ${result.message}`,
      ...(browserRequested ? [`Prefilled issue: ${result.fallbackUrl}`] : []),
      `Saved sanitized report: ${result.savedReportPath}`,
    ];
  }
  if (result.status === "retryable") {
    return [result.message];
  }
  return [
    result.message,
    ...(result.url ? [`Existing issue: ${result.url}`] : []),
    ...(browserRequested && result.fallbackUrl
      ? [`Existing prefilled issue: ${result.fallbackUrl}`]
      : []),
  ];
}

/** Offers report as a distinct interactive action; callers retain triage ownership. */
export async function runInteractiveUpdateFailureAction(params: {
  attemptId: string;
  env: NodeJS.ProcessEnv;
  error?: string;
  result?: UpdateRunResult;
  rollbackCompleted?: boolean;
  runtime: Pick<RuntimeEnv, "error" | "log">;
}): Promise<"triage" | "handled"> {
  let prepared: PreparedUpdateFailureReport | undefined;
  let browserAvailable = false;
  let reportPending = false;
  const stateDir = resolveStateDir(params.env);
  while (true) {
    const action = await select<UpdateFailureAction>({
      message: params.rollbackCompleted
        ? "Update failed, but rollback completed successfully. Choose the next action"
        : "Choose the next action for this failed update",
      ...(params.rollbackCompleted ? { initialValue: "dismiss" as const } : {}),
      options: [
        { value: "triage", label: "Diagnose update failure" },
        reportPending
          ? { value: "status", label: "Check report status" }
          : { value: "report", label: "Report update failure" },
        ...(browserAvailable ? [{ value: "browser" as const, label: "Report in browser" }] : []),
        { value: "dismiss", label: "Exit" },
      ],
    });
    if (isCancel(action) || action === "dismiss") {
      return "handled";
    }
    if (action === "triage") {
      return "triage";
    }
    try {
      const result: UpdateRunResult = params.result ?? {
        status: "error",
        mode: "unknown",
        steps: [],
        durationMs: 0,
      };
      if (!prepared) {
        let recordedRun: ReturnType<typeof getUpdateRun>;
        try {
          recordedRun = getUpdateRun(params.attemptId, { env: params.env });
        } catch {
          // A missing or locked ledger must not prevent reporting the direct failure.
        }
        prepared = await prepareUpdateFailureReport(
          {
            attemptId: params.attemptId,
            action: "cli",
            ...(params.error ? { error: params.error } : {}),
            result,
            recordedRun,
            ...(result.after?.upstreamRef ? { target: result.after.upstreamRef } : {}),
          },
          { env: params.env, stateDir },
        );
      }
      params.runtime.log("Sanitized update failure report preview:");
      params.runtime.log(prepared.body);
      const confirmed = await confirm({
        message:
          action === "browser"
            ? "Prepare a browser link to review and submit this report yourself?"
            : action === "status"
              ? "Check whether this report was submitted to openclaw/openclaw?"
              : "Submit this sanitized report to openclaw/openclaw now?",
        initialValue: false,
      });
      if (isCancel(confirmed) || !confirmed) {
        params.runtime.log("Update failure report cancelled.");
        return "handled";
      }
      // A lost upload response must not retain an earlier browser-retry choice.
      browserAvailable = false;
      const submitted = await submitUpdateFailureReport(prepared, prepared.previewDigest, {
        env: params.env,
        stateDir,
        ...(action === "browser"
          ? { publicationMode: "browser" as const }
          : action === "status"
            ? { publicationMode: "reconcile" as const }
            : { allowBrowserFallback: false }),
      });
      reportPending = submitted.status === "pending";
      browserAvailable =
        prepared.browserFallback.status === "available" &&
        (submitted.status === "retryable" ||
          submitted.status === "fallback" ||
          (submitted.status === "duplicate" && Boolean(submitted.fallbackUrl)));
      for (const line of renderSubmissionResult(submitted, action === "browser")) {
        params.runtime.log(line);
      }
      if (
        submitted.status === "created" ||
        (submitted.status === "duplicate" && submitted.url) ||
        (action === "browser" && submitted.fallbackUrl)
      ) {
        return "handled";
      }
    } catch (error) {
      params.runtime.error(`Update failure report failed: ${formatErrorMessage(error)}`);
    }
  }
}
