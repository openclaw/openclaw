/** Privacy-bounded, consent-gated reporting for one terminal update failure. */
import { randomUUID } from "node:crypto";
import { resolveStateDir } from "../config/paths.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
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
} from "./update-failure-report-artifact.js";
import {
  assertUpdateReportPreCreateState,
  assertUpdateReportSubmissionAuthority,
  retryUpdateReportStateWrite,
  retryUpdateReportStateWriteAfterNoStart,
  UpdateReportPreCreateGuardError,
} from "./update-failure-report-precreate.js";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";
import { confirmUpdateFailureReportReceipt } from "./update-failure-report-receipt.js";

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
      status: "pending" | "retryable" | "stale";
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
  if (receipt && receipt.status !== "created" && receipt.status !== "fallback") {
    return {
      message: {
        pending: "This update attempt already has a report submission in progress.",
        preparing: "This update attempt already has a report preparation in progress.",
        prepared: "This update attempt already has a report publication in progress.",
        retryable: "No GitHub issue submission was started. This report can be retried.",
      }[receipt.status],
      savedReportPath,
      status: receipt.status === "pending" ? "pending" : "retryable",
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
    finalizeReceipt?: (
      ...args: Parameters<typeof finalizeUpdateFailureReportReceipt>
    ) => boolean | Promise<boolean>;
    hasCurrentAuthority?: () => boolean;
    markPending?: (
      ...args: Parameters<typeof markUpdateFailureReportReceiptPending>
    ) => boolean | Promise<boolean>;
    readReceipt?: (
      ...args: Parameters<typeof readUpdateFailureReportReceipt>
    ) => UpdateFailureReportReceipt | null | Promise<UpdateFailureReportReceipt | null>;
    reconcileIssue?: (
      issue: PreparedGithubIssue,
      hooks: GithubIssueReconcileHooks,
    ) => Promise<GithubIssueReconcileResult>;
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
  const context = captureOpenClawStateWorkerContext({ env: stateEnv });
  const ensureAuthority = (operation: "submission" | "reconciliation") => {
    if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
      throw new Error(`Update report ${operation} requires a current authenticated client.`);
    }
  };
  ensureAuthority("submission");
  const finalizeReceipt = options.finalizeReceipt ?? finalizeUpdateFailureReportReceipt;
  const readReceipt = options.readReceipt ?? readUpdateFailureReportReceipt;
  const ensureReconciliationAuthority = () => ensureAuthority("reconciliation");
  const cleanRetiredArtifacts = (receipt: UpdateFailureReportSweepReceipt, keepCurrent: boolean) =>
    cleanRetiredUpdateFailureReportArtifacts(
      prepared,
      receipt,
      stateEnv,
      keepCurrent,
      options.artifactSweepHooks,
      context,
    );
  const cleanOwnedArtifact = async (receipt: UpdateFailureReportSweepReceipt): Promise<boolean> => {
    if (receipt.artifactSweep && !(await cleanRetiredArtifacts(receipt, false))) {
      return false;
    }
    const ownedPrepared = bindSavedReportArtifact(
      prepared,
      receipt.reservationId,
      receipt.previewDigest,
    );
    try {
      context.admission.assertCurrent();
      await discardSavedUpdateFailureReport(ownedPrepared);
    } catch {
      return false;
    }
    return retryUpdateReportStateWrite(() =>
      completeUpdateFailureReportReceiptCleanup(
        prepared.attemptId,
        receipt.reservationId,
        stateEnv,
        context,
      ),
    );
  };
  const cleanPreparation = async (
    receipt: UpdateFailureReportSweepReceipt,
    beginCleanup = beginUpdateFailureReportReceiptCleanup,
  ): Promise<boolean> => {
    const cleanupRecorded = await retryUpdateReportStateWrite(() =>
      beginCleanup(prepared.attemptId, receipt.reservationId, stateEnv, context),
    );
    return cleanupRecorded ? cleanOwnedArtifact(receipt) : false;
  };
  const recordCreatedIssue = async (url: string, reservationId: string) => {
    const receipt: UpdateFailureReportReceipt = {
      cleanup: "pending",
      previewDigest: prepared.previewDigest,
      reservationId,
      status: "created",
      url,
    };
    const finalized = await retryUpdateReportStateWrite(() =>
      finalizeReceipt(prepared.attemptId, receipt, stateEnv, context),
    );
    if (
      !finalized &&
      !(await confirmUpdateFailureReportReceipt(
        () => readReceipt(prepared.attemptId, stateEnv, context),
        receipt,
      ))
    ) {
      return undefined;
    }
    await cleanOwnedArtifact(receipt);
    return receipt;
  };
  const persistKnownNoStartReceipt = async (
    receipt: UpdateFailureReportReceipt,
  ): Promise<boolean> =>
    await retryUpdateReportStateWriteAfterNoStart(async () => {
      try {
        if (await finalizeReceipt(prepared.attemptId, receipt, stateEnv, context)) {
          return true;
        }
      } catch (error) {
        if (
          await confirmUpdateFailureReportReceipt(
            () => readReceipt(prepared.attemptId, stateEnv, context),
            receipt,
          )
        ) {
          return true;
        }
        throw error;
      }
      return confirmUpdateFailureReportReceipt(
        () => readReceipt(prepared.attemptId, stateEnv, context),
        receipt,
      );
    });
  const existingResult = async (receipt: UpdateFailureReportReceipt | null) => {
    if (receipt?.status === "created") {
      await discardSavedUpdateFailureReportBestEffort(
        bindSavedReportArtifact(prepared, receipt.reservationId, receipt.previewDigest),
      );
    }
    return resultFromExistingReceipt(receipt, prepared);
  };
  let existingReceipt = await readReceipt(prepared.attemptId, stateEnv, context);
  if (existingReceipt?.cleanup === "pending") {
    await cleanOwnedArtifact(existingReceipt);
    existingReceipt = await readReceipt(prepared.attemptId, stateEnv, context);
  }
  if (
    existingReceipt?.status === "pending" &&
    options.publicationMode !== "browser" &&
    existingReceipt.previewDigest === prepared.previewDigest
  ) {
    const reconcileIssue =
      options.reconcileIssue ??
      ((issue: PreparedGithubIssue, hooks: GithubIssueReconcileHooks) =>
        reconcileGithubIssue(issue, undefined, hooks));
    let reconciled: GithubIssueReconcileResult;
    try {
      reconciled = await reconcileIssue(prepared, {
        beforeIssueLookup: ensureReconciliationAuthority,
      });
      ensureReconciliationAuthority();
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
    await cleanRetiredArtifacts(existingReceipt, true);
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
    return existingResult(existingReceipt);
  }
  if (options.validateCurrentAttempt && !(await options.validateCurrentAttempt())) {
    return {
      message: "This failed update attempt is stale or unavailable.",
      savedReportPath: prepared.savedReportPath,
      status: "stale",
    };
  }
  if (existingReceipt?.status === "preparing" || existingReceipt?.status === "prepared") {
    await cleanPreparation(existingReceipt, beginStaleUpdateFailureReportReceiptCleanup);
    existingReceipt = await readReceipt(prepared.attemptId, stateEnv, context);
  }
  if (existingReceipt?.status === "retryable" && existingReceipt.replacementReady !== true) {
    await cleanPreparation(existingReceipt);
  }
  if (existingReceipt?.status === "retryable" && existingReceipt.replacementReady === true) {
    if (!(await cleanRetiredArtifacts(existingReceipt, false))) {
      const currentReceipt = await readReceipt(prepared.attemptId, stateEnv, context);
      return resultFromExistingReceipt(currentReceipt, prepared);
    }
  }

  const reservationId = randomUUID();
  const reservation = await reserveUpdateFailureReportReceipt(
    prepared.attemptId,
    reservationId,
    prepared.previewDigest,
    stateEnv,
    context,
  );
  if (!reservation.reserved) {
    return existingResult(reservation.receipt);
  }

  const ownedPrepared = bindSavedReportArtifact(prepared, reservationId);
  const ownedResult = (status: "pending" | "retryable" | "stale", message: string) => ({
    message,
    savedReportPath: ownedPrepared.savedReportPath,
    status,
  });
  const currentResult = async () =>
    resultFromExistingReceipt(
      await readReceipt(prepared.attemptId, stateEnv, context),
      prepared,
      ownedPrepared.savedReportPath,
    );
  const cleanupOwnedPreparation = () =>
    cleanPreparation({ previewDigest: prepared.previewDigest, reservationId });
  try {
    await savePreparedUpdateFailureReport(ownedPrepared, options.hasCurrentAuthority);
    if (options.validateCurrentAttempt && !(await options.validateCurrentAttempt())) {
      if (!(await cleanupOwnedPreparation())) {
        return currentResult();
      }
      return ownedResult("stale", "This failed update attempt is stale or unavailable.");
    }
    ensureAuthority("submission");
    const publicationReserved = await retryUpdateReportStateWrite(() =>
      markUpdateFailureReportReceiptPrepared(
        prepared.attemptId,
        reservationId,
        prepared.previewDigest,
        stateEnv,
        context,
      ),
    );
    if (!publicationReserved) {
      await discardSavedUpdateFailureReportBestEffort(ownedPrepared);
      return currentResult();
    }
    context.admission.assertCurrent();
    ensureAuthority("submission");
    await publishPreparedUpdateFailureReport(ownedPrepared);
  } catch (error) {
    try {
      await cleanupOwnedPreparation();
    } catch {
      // The original preparation or authority failure remains actionable; a successor keeps custody.
    }
    throw error;
  }

  const assertCurrentPreCreateState = () => assertUpdateReportPreCreateState(options);
  let publicationAdmitted = false;
  const assertPublicationCurrent = () => {
    context.admission.assertCurrent();
    assertUpdateReportSubmissionAuthority(options);
  };
  const beforeIssueCreate = async () => {
    assertPublicationCurrent();
    const markPending = options.markPending ?? markUpdateFailureReportReceiptPending;
    let marked: boolean;
    try {
      marked = await markPending(
        prepared.attemptId,
        reservationId,
        prepared.previewDigest,
        stateEnv,
        context,
        assertPublicationCurrent,
      );
    } catch (error) {
      // If both worker replies were lost, the exact durable pending row still proves admission.
      let current: UpdateFailureReportReceipt | null;
      try {
        current = await readReceipt(prepared.attemptId, stateEnv, context);
      } catch {
        throw error;
      }
      if (
        current?.status !== "pending" ||
        current.reservationId !== reservationId ||
        current.previewDigest !== prepared.previewDigest
      ) {
        throw error;
      }
      marked = true;
    }
    if (!marked) {
      throw new UpdateReportPreCreateGuardError(
        "Update report preparation is no longer owned by this request.",
        "reservation",
      );
    }
    // Pending cannot be stolen by preparation cleanup; the transport still checks live authority.
    publicationAdmitted = true;
    await assertCurrentPreCreateState();
    return (): undefined => {
      assertPublicationCurrent();
    };
  };
  const createIssue =
    options.createIssue ??
    ((issue: PreparedGithubIssue, hooks: GithubIssueSubmitHooks) =>
      submitGithubIssue(issue, undefined, hooks));
  let created: GithubIssueSubmitResult;
  try {
    // Publication yields; fence host authentication as well as issue creation.
    assertUpdateReportSubmissionAuthority(options);
    if (options.publicationMode === "browser") {
      await assertCurrentPreCreateState();
      created = browserFallbackResult(prepared, "browser-requested");
    } else {
      try {
        created = await createIssue(prepared, {
          afterAuthPreflight: assertCurrentPreCreateState,
          beforeIssueCreate,
          beforeIssueLookup: ensureReconciliationAuthority,
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
      await discardSavedUpdateFailureReportBestEffort(ownedPrepared);
      return currentResult();
    }
    if (publicationAdmitted) {
      await persistKnownNoStartReceipt({
        previewDigest: prepared.previewDigest,
        reservationId,
        status: "retryable",
      });
    }
    if (!(await cleanupOwnedPreparation())) {
      return currentResult();
    }
    if (error.reason === "stale") {
      return ownedResult("stale", error.message);
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
    return ownedResult(
      "pending",
      "GitHub issue submission may have completed, but confirmation was unavailable. Do not submit this report again.",
    );
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
      return ownedResult(
        "pending",
        "GitHub issue creation did not start, but retry state could not be saved. Do not retry this report yet.",
      );
    }
    const reason = created.status === "fallback-unavailable" ? created.cause : created.reason;
    const unavailable =
      reason === "authentication-unavailable"
        ? "GitHub authentication is unavailable."
        : "GitHub submission is unavailable.";
    return ownedResult(
      "retryable",
      options.allowBrowserFallback === false
        ? `${unavailable} No issue was submitted. Fix the problem, then choose Report update failure to retry.\nSaved sanitized report: ${ownedPrepared.savedReportPath}`
        : "The sanitized report was saved, but it is too large for a browser handoff.",
    );
  }
  const message =
    created.reason === "browser-requested"
      ? "Review and submit the prefilled issue using your own GitHub account in your browser. No issue has been submitted by the Gateway."
      : created.reason === "authentication-unavailable"
        ? "GitHub authentication is unavailable. Review and submit the prefilled issue in your browser."
        : "GitHub submission is unavailable. Review and submit the prefilled issue in your browser.";
  const preparationRefreshed = await retryUpdateReportStateWrite(() =>
    refreshUpdateFailureReportReceiptPreparation(
      prepared.attemptId,
      reservationId,
      stateEnv,
      context,
    ),
  );
  if (!preparationRefreshed) {
    let replacement: UpdateFailureReportReceipt | null = null;
    try {
      replacement = await readReceipt(prepared.attemptId, stateEnv, context);
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
    return ownedResult(
      "retryable",
      "The browser report handoff could not be saved safely. No issue submission was started; retry this action later.",
    );
  }
  // Persistence may wait on contention. Retain its receipt, but never expose a
  // handoff for an attempt or authority that retired during those waits.
  try {
    await assertCurrentPreCreateState();
  } catch (error) {
    if (error instanceof UpdateReportPreCreateGuardError && error.reason === "stale") {
      return ownedResult("stale", error.message);
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
