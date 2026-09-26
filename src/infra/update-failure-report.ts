/** Privacy-bounded, consent-gated reporting for one terminal update failure. */
import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../config/paths.js";
import {
  browserFallbackResult,
  submitGithubIssue,
  type GithubIssueSubmitHooks,
  type GithubIssueSubmitResult,
  type GithubIssueReconcileHooks,
  type GithubIssueReconcileResult,
  reconcileGithubIssue,
  type PreparedGithubIssue,
} from "./github-issue.js";
import {
  beginStaleUpdateFailureReportReceiptCleanup,
  beginUpdateFailureReportReceiptCleanup,
  completeUpdateFailureReportReceiptCleanup,
  finalizeUpdateFailureReportReceipt,
  markUpdateFailureReportReceiptPrepared,
  markUpdateFailureReportReceiptPending,
  readUpdateFailureReportReceipt,
  refreshUpdateFailureReportReceiptPreparation,
  reserveUpdateFailureReportReceipt,
  type UpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import {
  cleanRetiredUpdateFailureReportArtifacts,
  type UpdateFailureReportSweepHooks,
  type UpdateFailureReportSweepReceipt,
} from "./update-failure-report-artifact-sweep.js";
import {
  bindSavedReportArtifact,
  discardSavedUpdateFailureReport,
  discardSavedUpdateFailureReportBestEffort,
  publishPreparedUpdateFailureReport,
  savePreparedUpdateFailureReport,
  type SavedUpdateFailureReport,
} from "./update-failure-report-artifact.js";
import {
  assertUpdateReportPreCreateState,
  retryUpdateReportStateWrite,
  retryUpdateReportStateWriteAfterNoStart,
  UpdateReportPreCreateGuardError,
} from "./update-failure-report-precreate.js";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";

export { prepareUpdateFailureReport } from "./update-failure-report-prepare.js";
export type {
  PreparedUpdateFailureReport,
  UpdateFailureReportInput,
} from "./update-failure-report-prepare.js";

export type UpdateFailureReportSubmitResult =
  | { message?: string; savedReportPath: string; status: "created"; url: string }
  | {
      fallbackUrl: string;
      message: string;
      savedReportPath: string;
      status: "fallback";
    }
  | {
      fallbackUrl?: string;
      message: string;
      savedReportPath: string;
      status: "duplicate";
      url?: string;
    }
  | {
      fallbackUrl?: undefined;
      message: string;
      savedReportPath: string;
      status: "pending";
      url?: undefined;
    }
  | {
      fallbackUrl?: undefined;
      message: string;
      savedReportPath: string;
      status: "retryable";
      url?: undefined;
    }
  | {
      fallbackUrl?: undefined;
      message: string;
      savedReportPath: string;
      status: "stale";
      url?: undefined;
    };

function resultFromExistingReceipt(
  receipt: UpdateFailureReportReceipt | null,
  prepared: PreparedUpdateFailureReport,
  savedReportPath = receipt
    ? bindSavedReportArtifact(prepared, receipt.reservationId, receipt.previewDigest)
        .savedReportPath
    : prepared.savedReportPath,
): UpdateFailureReportSubmitResult {
  if (receipt?.status === "pending") {
    return {
      message: "This update attempt already has a report submission in progress.",
      savedReportPath,
      status: "pending",
    };
  }
  if (receipt?.status === "preparing") {
    return {
      message: "This update attempt already has a report preparation in progress.",
      savedReportPath,
      status: "retryable",
    };
  }
  if (receipt?.status === "prepared") {
    return {
      message: "This update attempt already has a report publication in progress.",
      savedReportPath,
      status: "retryable",
    };
  }
  if (receipt?.status === "retryable") {
    return {
      message: "No GitHub issue submission was started. This report can be retried.",
      savedReportPath,
      status: "retryable",
    };
  }
  const previewMatches = receipt?.previewDigest === prepared.previewDigest;
  const matchingFallbackUrl =
    previewMatches && receipt?.status === "fallback" && receipt.fallbackUrl === prepared.url
      ? receipt.fallbackUrl
      : undefined;
  return {
    status: "duplicate",
    savedReportPath,
    ...(previewMatches && receipt?.url ? { url: receipt.url } : {}),
    ...(matchingFallbackUrl ? { fallbackUrl: matchingFallbackUrl } : {}),
    message:
      receipt && !previewMatches
        ? "This update attempt has a report result for a different reviewed preview."
        : receipt?.status === "fallback" && !matchingFallbackUrl
          ? "This update attempt has a report handoff for a different reviewed preview."
          : receipt
            ? "This update attempt was already reported."
            : "This update attempt already has a report reservation.",
  };
}

function receiptMatchesBestEffort(
  readReceipt: () => UpdateFailureReportReceipt | null,
  expected: UpdateFailureReportReceipt,
): boolean {
  try {
    const receipt = readReceipt();
    return (
      receipt?.reservationId === expected.reservationId &&
      receipt.status === expected.status &&
      receipt.previewDigest === expected.previewDigest &&
      receipt.cleanup === expected.cleanup &&
      receipt.url === expected.url &&
      receipt.fallbackUrl === expected.fallbackUrl
    );
  } catch {
    return false;
  }
}

async function cleanOwnedReportArtifact(
  prepared: PreparedUpdateFailureReport,
  receipt: UpdateFailureReportSweepReceipt,
  stateEnv: NodeJS.ProcessEnv,
  sweepHooks?: UpdateFailureReportSweepHooks,
): Promise<boolean> {
  if (
    receipt.artifactSweep &&
    !(await cleanRetiredUpdateFailureReportArtifacts(
      prepared,
      receipt,
      stateEnv,
      false,
      sweepHooks,
    ))
  ) {
    return false;
  }
  const ownedPrepared = bindSavedReportArtifact(
    prepared,
    receipt.reservationId,
    receipt.previewDigest,
  );
  try {
    await discardSavedUpdateFailureReport(
      ownedPrepared,
      { reportCreated: false, reportDirCreated: false, stagedReportCreated: false },
      true,
    );
  } catch {
    return false;
  }
  return retryUpdateReportStateWrite(() =>
    completeUpdateFailureReportReceiptCleanup(prepared.attemptId, receipt.reservationId, stateEnv),
  );
}

/** Consumes one reviewed preview and invokes the shared GitHub issue creator at most once. */
export async function submitUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  previewDigest: string,
  options: {
    createIssue?: (
      issue: PreparedGithubIssue,
      hooks: GithubIssueSubmitHooks,
    ) => GithubIssueSubmitResult | Promise<GithubIssueSubmitResult>;
    env?: NodeJS.ProcessEnv;
    /** Browser-only callers must never use the host account, even for reconciliation. */
    publicationMode?: "host" | "browser" | "reconcile";
    /** Interactive CLI retries stay in the terminal instead of publishing a browser handoff. */
    allowBrowserFallback?: boolean;
    artifactSweepHooks?: UpdateFailureReportSweepHooks;
    finalizeReceipt?: typeof finalizeUpdateFailureReportReceipt;
    hasCurrentAuthority?: () => boolean;
    markPending?: typeof markUpdateFailureReportReceiptPending;
    readReceipt?: typeof readUpdateFailureReportReceipt;
    reconcileIssue?: (
      issue: PreparedGithubIssue,
      hooks: GithubIssueReconcileHooks,
    ) => Promise<GithubIssueReconcileResult>;
    refreshPreparation?: typeof refreshUpdateFailureReportReceiptPreparation;
    stateDir?: string;
    validateCurrentAttempt?: () => boolean | Promise<boolean>;
  } = {},
): Promise<UpdateFailureReportSubmitResult> {
  if (previewDigest !== prepared.previewDigest) {
    throw new Error("The update report preview is stale. Review it again before submitting.");
  }
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const stateEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
  if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
    throw new Error("Update report submission requires a current authenticated client.");
  }
  const finalizeReceipt = options.finalizeReceipt ?? finalizeUpdateFailureReportReceipt;
  const readReceipt = options.readReceipt ?? readUpdateFailureReportReceipt;
  const recordCreatedIssue = async (url: string, reservationId: string) => {
    const receipt: UpdateFailureReportReceipt = {
      cleanup: "pending",
      previewDigest: prepared.previewDigest,
      reservationId,
      status: "created",
      url,
    };
    const finalized = retryUpdateReportStateWrite(() =>
      finalizeReceipt(prepared.attemptId, receipt, stateEnv),
    );
    if (
      !finalized &&
      !receiptMatchesBestEffort(() => readReceipt(prepared.attemptId, stateEnv), receipt)
    ) {
      return undefined;
    }
    await cleanOwnedReportArtifact(prepared, receipt, stateEnv, options.artifactSweepHooks);
    return receipt;
  };
  const persistKnownNoStartReceipt = async (
    receipt: UpdateFailureReportReceipt,
  ): Promise<boolean> =>
    await retryUpdateReportStateWriteAfterNoStart(() => {
      try {
        if (finalizeReceipt(prepared.attemptId, receipt, stateEnv)) {
          return true;
        }
      } catch {
        // A lost acknowledgement is resolved by the authoritative read below.
      }
      return receiptMatchesBestEffort(() => readReceipt(prepared.attemptId, stateEnv), receipt);
    });
  let existingReceipt = readReceipt(prepared.attemptId, stateEnv);
  if (existingReceipt?.cleanup === "pending") {
    await cleanOwnedReportArtifact(prepared, existingReceipt, stateEnv, options.artifactSweepHooks);
    existingReceipt = readReceipt(prepared.attemptId, stateEnv);
  }
  if (
    existingReceipt?.status === "pending" &&
    options.publicationMode !== "browser" &&
    existingReceipt.previewDigest === prepared.previewDigest
  ) {
    const ensureCurrentAuthority = () => {
      if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
        throw new Error("Update report reconciliation requires a current authenticated client.");
      }
    };
    const reconcileIssue =
      options.reconcileIssue ??
      ((issue: PreparedGithubIssue, hooks: GithubIssueReconcileHooks) =>
        reconcileGithubIssue(issue, undefined, hooks));
    let reconciled: GithubIssueReconcileResult;
    try {
      reconciled = await reconcileIssue(prepared, {
        beforeIssueLookup: ensureCurrentAuthority,
      });
      ensureCurrentAuthority();
    } catch {
      reconciled = { status: "unavailable" };
    }
    if (reconciled.status === "created") {
      existingReceipt =
        (await recordCreatedIssue(reconciled.url, existingReceipt.reservationId)) ??
        existingReceipt;
    }
  }
  if (
    existingReceipt?.artifactSweep &&
    existingReceipt.cleanup === undefined &&
    existingReceipt.status !== "preparing" &&
    existingReceipt.status !== "prepared" &&
    existingReceipt.status !== "retryable"
  ) {
    await cleanRetiredUpdateFailureReportArtifacts(
      prepared,
      existingReceipt,
      stateEnv,
      true,
      options.artifactSweepHooks,
    );
  }
  // A status check cannot become a new publication if its receipt disappears.
  if (!existingReceipt && options.publicationMode === "reconcile") {
    return {
      message: "The report's submission status could not be verified. No new issue was submitted.",
      savedReportPath: prepared.savedReportPath,
      status: "pending",
    };
  }
  if (
    existingReceipt &&
    (options.publicationMode === "reconcile" ||
      (existingReceipt.status !== "preparing" &&
        existingReceipt.status !== "prepared" &&
        existingReceipt.status !== "retryable"))
  ) {
    if (existingReceipt.status === "created") {
      await discardSavedUpdateFailureReportBestEffort(
        bindSavedReportArtifact(
          prepared,
          existingReceipt.reservationId,
          existingReceipt.previewDigest,
        ),
        { reportCreated: false, reportDirCreated: false, stagedReportCreated: false },
        true,
      );
    }
    return resultFromExistingReceipt(existingReceipt, prepared);
  }
  if (options.validateCurrentAttempt && !(await options.validateCurrentAttempt())) {
    return {
      message: "This failed update attempt is stale or unavailable.",
      savedReportPath: prepared.savedReportPath,
      status: "stale",
    };
  }
  if (existingReceipt?.status === "preparing" || existingReceipt?.status === "prepared") {
    const preparingReceipt = existingReceipt;
    const cleanupRecorded = retryUpdateReportStateWrite(() =>
      beginStaleUpdateFailureReportReceiptCleanup(
        prepared.attemptId,
        preparingReceipt.reservationId,
        stateEnv,
      ),
    );
    if (cleanupRecorded) {
      await cleanOwnedReportArtifact(
        prepared,
        preparingReceipt,
        stateEnv,
        options.artifactSweepHooks,
      );
    }
    existingReceipt = readReceipt(prepared.attemptId, stateEnv);
  }
  if (existingReceipt?.status === "retryable" && existingReceipt.replacementReady !== true) {
    const retryableReceipt = existingReceipt;
    const cleanupRecorded = retryUpdateReportStateWrite(() =>
      beginUpdateFailureReportReceiptCleanup(
        prepared.attemptId,
        retryableReceipt.reservationId,
        stateEnv,
      ),
    );
    if (cleanupRecorded) {
      await cleanOwnedReportArtifact(
        prepared,
        retryableReceipt,
        stateEnv,
        options.artifactSweepHooks,
      );
    }
  }
  if (existingReceipt?.status === "retryable" && existingReceipt.replacementReady === true) {
    if (
      !(await cleanRetiredUpdateFailureReportArtifacts(
        prepared,
        existingReceipt,
        stateEnv,
        false,
        options.artifactSweepHooks,
      ))
    ) {
      const currentReceipt = readReceipt(prepared.attemptId, stateEnv);
      return resultFromExistingReceipt(currentReceipt, prepared);
    }
  }

  const reservationId = randomUUID();
  const reservation = reserveUpdateFailureReportReceipt(
    prepared.attemptId,
    reservationId,
    prepared.previewDigest,
    stateEnv,
  );
  if (!reservation.reserved) {
    if (reservation.receipt?.status === "created") {
      await discardSavedUpdateFailureReportBestEffort(
        bindSavedReportArtifact(
          prepared,
          reservation.receipt.reservationId,
          reservation.receipt.previewDigest,
        ),
        { reportCreated: false, reportDirCreated: false, stagedReportCreated: false },
        true,
      );
    }
    return resultFromExistingReceipt(reservation.receipt, prepared);
  }

  const ownedPrepared = bindSavedReportArtifact(prepared, reservationId);
  const saved: SavedUpdateFailureReport = {
    reportCreated: false,
    reportDirCreated: false,
    stagedReportCreated: false,
  };
  const cleanupOwnedPreparation = async (): Promise<boolean> => {
    const cleanupRecorded = retryUpdateReportStateWrite(() =>
      beginUpdateFailureReportReceiptCleanup(prepared.attemptId, reservationId, stateEnv),
    );
    return cleanupRecorded
      ? await cleanOwnedReportArtifact(
          prepared,
          { previewDigest: prepared.previewDigest, reservationId },
          stateEnv,
          options.artifactSweepHooks,
        )
      : false;
  };
  try {
    await savePreparedUpdateFailureReport(ownedPrepared, saved, options.hasCurrentAuthority);
    if (options.validateCurrentAttempt && !(await options.validateCurrentAttempt())) {
      if (!(await cleanupOwnedPreparation())) {
        return resultFromExistingReceipt(
          readReceipt(prepared.attemptId, stateEnv),
          prepared,
          ownedPrepared.savedReportPath,
        );
      }
      return {
        message: "This failed update attempt is stale or unavailable.",
        savedReportPath: ownedPrepared.savedReportPath,
        status: "stale",
      };
    }
    if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
      throw new Error("Update report submission requires a current authenticated client.");
    }
    const publicationReserved = retryUpdateReportStateWrite(() =>
      markUpdateFailureReportReceiptPrepared(
        prepared.attemptId,
        reservationId,
        prepared.previewDigest,
        stateEnv,
      ),
    );
    if (!publicationReserved) {
      await discardSavedUpdateFailureReportBestEffort(ownedPrepared, saved, true);
      return resultFromExistingReceipt(
        readReceipt(prepared.attemptId, stateEnv),
        prepared,
        ownedPrepared.savedReportPath,
      );
    }
    await publishPreparedUpdateFailureReport(ownedPrepared, saved);
  } catch (error) {
    try {
      await cleanupOwnedPreparation();
    } catch {
      // The original preparation or authority failure remains actionable; a successor keeps custody.
    }
    throw error;
  }

  const assertCurrentPreCreateState = () => assertUpdateReportPreCreateState(options);
  const afterAuthPreflight = assertCurrentPreCreateState;
  let publicationAdmitted = false;
  const beforeIssueCreate = async () => {
    await assertCurrentPreCreateState();
    // Transport invokes this after its last await, immediately before starting the child.
    return (): undefined => {
      if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
        throw new UpdateReportPreCreateGuardError(
          "Update report submission requires a current authenticated client.",
          "authority",
        );
      }
      const markPending = options.markPending ?? markUpdateFailureReportReceiptPending;
      if (!markPending(prepared.attemptId, reservationId, prepared.previewDigest, stateEnv)) {
        throw new UpdateReportPreCreateGuardError(
          "Update report preparation is no longer owned by this request.",
          "reservation",
        );
      }
      publicationAdmitted = true;
    };
  };
  const createIssue =
    options.createIssue ??
    ((issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) =>
      submitGithubIssue(issue, undefined, hooks));
  let created: GithubIssueSubmitResult;
  try {
    // Publication yields; fence host authentication as well as issue creation.
    if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
      throw new UpdateReportPreCreateGuardError(
        "Update report submission requires a current authenticated client.",
        "authority",
      );
    }
    if (options.publicationMode === "browser") {
      await assertCurrentPreCreateState();
      created = browserFallbackResult(prepared, "browser-requested");
    } else {
      try {
        created = await createIssue(prepared, {
          afterAuthPreflight,
          beforeIssueCreate,
          beforeIssueLookup: () => {
            if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
              throw new Error(
                "Update report reconciliation requires a current authenticated client.",
              );
            }
          },
        });
      } catch (error) {
        if (!publicationAdmitted || error instanceof UpdateReportPreCreateGuardError) {
          throw error;
        }
        // Admission precedes the child start; a thrown response cannot make retry safe.
        created = { reason: "creation-outcome-unknown", status: "outcome-unknown" };
      }
    }
  } catch (error) {
    if (!(error instanceof UpdateReportPreCreateGuardError)) {
      throw error;
    }
    if (error.reason === "reservation") {
      await discardSavedUpdateFailureReportBestEffort(ownedPrepared, saved, true);
      return resultFromExistingReceipt(
        readReceipt(prepared.attemptId, stateEnv),
        prepared,
        ownedPrepared.savedReportPath,
      );
    }
    if (!(await cleanupOwnedPreparation())) {
      return resultFromExistingReceipt(
        readReceipt(prepared.attemptId, stateEnv),
        prepared,
        ownedPrepared.savedReportPath,
      );
    }
    if (error.reason === "stale") {
      return {
        message: error.message,
        savedReportPath: ownedPrepared.savedReportPath,
        status: "stale",
      };
    }
    throw error;
  }
  if (created.status === "created") {
    const terminalRecorded = await recordCreatedIssue(created.url, reservationId);
    return {
      ...(!terminalRecorded
        ? {
            message:
              "GitHub issue was created, but its canonical receipt is still pending. Do not submit this report again.",
          }
        : {}),
      savedReportPath: ownedPrepared.savedReportPath,
      status: "created",
      url: created.url,
    };
  }
  if (created.status === "outcome-unknown") {
    return {
      message:
        "GitHub issue submission may have completed, but confirmation was unavailable. Do not submit this report again.",
      savedReportPath: ownedPrepared.savedReportPath,
      status: "pending",
    };
  }
  if (
    created.status === "fallback-unavailable" ||
    (created.status === "browser-fallback" && options.allowBrowserFallback === false)
  ) {
    const receipt: UpdateFailureReportReceipt = {
      previewDigest: prepared.previewDigest,
      reservationId,
      status: "retryable",
    };
    if (!(await persistKnownNoStartReceipt(receipt))) {
      return {
        message:
          "GitHub issue creation did not start, but retry state could not be saved. Do not retry this report yet.",
        savedReportPath: ownedPrepared.savedReportPath,
        status: "pending",
      };
    }
    const reason = created.status === "fallback-unavailable" ? created.cause : created.reason;
    const unavailable =
      reason === "authentication-unavailable"
        ? "GitHub authentication is unavailable."
        : "GitHub submission is unavailable.";
    return {
      message:
        options.allowBrowserFallback === false
          ? `${unavailable} No issue was submitted. Fix the problem, then choose Report update failure to retry.\nSaved sanitized report: ${ownedPrepared.savedReportPath}`
          : "The sanitized report was saved, but it is too large for a browser handoff.",
      savedReportPath: ownedPrepared.savedReportPath,
      status: "retryable",
    };
  }
  const message =
    created.reason === "browser-requested"
      ? "Review and submit the prefilled issue using your own GitHub account in your browser. No issue has been submitted by the Gateway."
      : created.reason === "authentication-unavailable"
        ? "GitHub authentication is unavailable. Review and submit the prefilled issue in your browser."
        : "GitHub submission is unavailable. Review and submit the prefilled issue in your browser.";
  const preparationRefreshed = retryUpdateReportStateWrite(() =>
    (options.refreshPreparation ?? refreshUpdateFailureReportReceiptPreparation)(
      prepared.attemptId,
      reservationId,
      stateEnv,
    ),
  );
  if (!preparationRefreshed) {
    let replacement: UpdateFailureReportReceipt | null = null;
    try {
      replacement = readReceipt(prepared.attemptId, stateEnv);
    } catch {
      // Without an authoritative owner, a browser link must not be published or persisted.
    }
    return resultFromExistingReceipt(
      replacement,
      prepared,
      replacement ? undefined : ownedPrepared.savedReportPath,
    );
  }
  const receipt: UpdateFailureReportReceipt = {
    fallbackUrl: created.url,
    previewDigest: prepared.previewDigest,
    reservationId,
    status: "fallback",
  };
  if (!(await persistKnownNoStartReceipt(receipt))) {
    return {
      message:
        "The browser report handoff could not be saved safely. No issue submission was started; retry this action later.",
      savedReportPath: ownedPrepared.savedReportPath,
      status: "retryable",
    };
  }
  // Persistence may wait on contention. Retain its receipt, but never expose a
  // handoff for an attempt or authority that retired during those waits.
  try {
    await assertCurrentPreCreateState();
  } catch (error) {
    if (error instanceof UpdateReportPreCreateGuardError && error.reason === "stale") {
      return {
        message: error.message,
        savedReportPath: ownedPrepared.savedReportPath,
        status: "stale",
      };
    }
    throw error;
  }
  return {
    fallbackUrl: created.url,
    message,
    savedReportPath: ownedPrepared.savedReportPath,
    status: "fallback",
  };
}
