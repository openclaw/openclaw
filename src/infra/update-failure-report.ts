/** Consent-gated reporting through the shared GitHub issue transport. */
import { browserFallbackResult, reconcileGithubIssue, submitGithubIssue } from "./github-issue.js";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";

export { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
export type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";

export type UpdateFailureReportSubmitResult =
  | { message?: string; status: "created"; url: string; fallbackUrl?: undefined }
  | { fallbackUrl: string; message: string; status: "fallback"; url?: undefined }
  | {
      fallbackUrl?: undefined;
      message: string;
      status: "pending" | "retryable" | "stale";
      url?: undefined;
    };

/** Admits one reviewed request; the generic transport owns remote outcome reconciliation. */
export async function submitUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  previewDigest: string,
  options: {
    /** Browser-only callers never use the host account, including for lookups. */
    publicationMode?: "host" | "browser" | "reconcile";
    allowBrowserFallback?: boolean;
    hasCurrentAuthority?: () => boolean;
    validateCurrentAttempt?: () => boolean | Promise<boolean>;
  } = {},
): Promise<UpdateFailureReportSubmitResult> {
  if (previewDigest !== prepared.previewDigest) {
    throw new Error("The update report preview is stale. Review it again before submitting.");
  }
  if (options.validateCurrentAttempt && !(await options.validateCurrentAttempt())) {
    return { status: "stale", message: "This failed update attempt is stale or unavailable." };
  }
  if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
    throw new Error("Update report submission requires a current authenticated client.");
  }
  if (options.publicationMode === "reconcile") {
    const reconciled = await reconcileGithubIssue(prepared);
    return reconciled.status === "created"
      ? reconciled
      : {
          status: "pending",
          message:
            "The report's submission status could not be verified. No new issue was submitted.",
        };
  }
  const result =
    options.publicationMode === "browser"
      ? browserFallbackResult(prepared, "browser-requested")
      : await submitGithubIssue(prepared);
  if (result.status === "created") {
    return result;
  }
  if (result.status === "outcome-unknown") {
    return {
      status: "pending",
      message:
        "GitHub issue submission may have completed, but confirmation was unavailable. Do not submit this report again.",
    };
  }
  if (result.status === "fallback-unavailable" || options.allowBrowserFallback === false) {
    return {
      status: "retryable",
      message:
        result.status === "fallback-unavailable"
          ? "No issue was submitted. The sanitized report is too large for a browser handoff."
          : "GitHub submission is unavailable. No issue was submitted. Fix the problem, then choose Report update failure to retry.",
    };
  }
  return {
    fallbackUrl: result.url,
    status: "fallback",
    message:
      result.reason === "browser-requested"
        ? "Review and submit the prefilled issue using your own GitHub account in your browser. No issue has been submitted by the Gateway."
        : "GitHub submission is unavailable. Review and submit the prefilled issue in your browser.",
  };
}
