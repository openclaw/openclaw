/** Privacy-bounded, consent-gated reporting for one terminal update failure. */
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  createGithubIssueAsync,
  type GithubIssueCreateAsyncHooks,
  type GithubIssueCreateResult,
  type SanitizedGithubIssue,
} from "./github-issue.js";
import {
  finalizeUpdateFailureReportReceipt,
  markUpdateFailureReportReceiptPending,
  readUpdateFailureReportReceipt,
  refreshUpdateFailureReportReceiptPreparation,
  releaseUpdateFailureReportReceiptWithCleanup,
  reserveUpdateFailureReportReceipt,
  type UpdateFailureReportReceipt,
} from "./restart-sentinel.js";
import {
  assertUpdateReportPreCreateState,
  retryUpdateReportStateWrite,
  UpdateReportPreCreateGuardError,
} from "./update-failure-report-precreate.js";
import {
  sanitizeReportField,
  type PreparedUpdateFailureReport,
} from "./update-failure-report-prepare.js";
import {
  discardUpdateFailureReportRecoveryBestEffort,
  readUpdateFailureReportRecovery,
  tryMatchUpdateFailureReportRecovery,
  writeUpdateFailureReportRecovery,
  type UpdateFailureReportRecovery,
} from "./update-failure-report-recovery.js";

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

type SavedUpdateFailureReport = {
  reportCreated: boolean;
  reportDirCreated: boolean;
};

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function discardSavedUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  saved: SavedUpdateFailureReport,
  removeExistingReport = false,
): Promise<void> {
  if (saved.reportCreated || removeExistingReport) {
    await fs.rm(prepared.savedReportPath, { force: true });
  }
  if (saved.reportDirCreated || removeExistingReport) {
    await fs.rmdir(path.dirname(prepared.savedReportPath)).catch((error: unknown) => {
      if (!hasErrorCode(error, "ENOENT", "ENOTEMPTY")) {
        throw error;
      }
    });
  }
}

async function discardSavedUpdateFailureReportBestEffort(
  prepared: PreparedUpdateFailureReport,
  saved: SavedUpdateFailureReport,
  removeExistingReport = false,
): Promise<void> {
  await discardSavedUpdateFailureReport(prepared, saved, removeExistingReport).catch(() => {});
}

function discardSavedUpdateFailureReportSync(prepared: PreparedUpdateFailureReport): void {
  fsSync.rmSync(prepared.savedReportPath, { force: true });
  try {
    fsSync.rmdirSync(path.dirname(prepared.savedReportPath));
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT", "ENOTEMPTY")) {
      throw error;
    }
  }
}

/** Persists one reviewed body while rechecking the caller's live authority around every write. */
async function savePreparedUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  saved: SavedUpdateFailureReport,
  hasCurrentAuthority?: () => boolean,
): Promise<void> {
  const ensureCurrentAuthority = () => {
    if (hasCurrentAuthority && !hasCurrentAuthority()) {
      throw new Error("Update report persistence requires a current authenticated client.");
    }
  };
  const reportDir = path.dirname(prepared.savedReportPath);
  ensureCurrentAuthority();
  const reportDirExisted = await pathExists(reportDir);
  ensureCurrentAuthority();
  await fs.mkdir(reportDir, { mode: 0o700, recursive: true });
  saved.reportDirCreated = !reportDirExisted;
  ensureCurrentAuthority();
  try {
    await fs.writeFile(prepared.savedReportPath, prepared.body, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    saved.reportCreated = true;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
    const existing = await fs
      .readFile(prepared.savedReportPath, "utf8")
      .catch((readError: unknown) => {
        if (hasErrorCode(readError, "ENOENT")) {
          return undefined;
        }
        throw readError;
      });
    if (existing !== undefined && existing !== prepared.body) {
      throw new Error("The saved update report does not match the reviewed preview.", {
        cause: error,
      });
    }
  }
  ensureCurrentAuthority();
  if (saved.reportCreated) {
    await fs.chmod(prepared.savedReportPath, 0o600);
  }
  ensureCurrentAuthority();
}

function resultFromExistingReceipt(
  receipt: UpdateFailureReportReceipt | null,
  savedReportPath: string,
  expectedFallbackUrl: string,
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
  if (receipt?.status === "retryable") {
    return {
      message: "No GitHub issue submission was started. This report can be retried.",
      savedReportPath,
      status: "retryable",
    };
  }
  const matchingFallbackUrl =
    receipt?.status === "fallback" && receipt.fallbackUrl === expectedFallbackUrl
      ? receipt.fallbackUrl
      : undefined;
  return {
    status: "duplicate",
    savedReportPath,
    ...(receipt?.url ? { url: receipt.url } : {}),
    ...(matchingFallbackUrl ? { fallbackUrl: matchingFallbackUrl } : {}),
    message:
      receipt?.status === "fallback" && !matchingFallbackUrl
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
      issue: SanitizedGithubIssue,
      hooks: GithubIssueCreateAsyncHooks,
    ) => GithubIssueCreateResult | Promise<GithubIssueCreateResult>;
    env?: NodeJS.ProcessEnv;
    finalizeReceipt?: typeof finalizeUpdateFailureReportReceipt;
    hasCurrentAuthority?: () => boolean;
    markPending?: typeof markUpdateFailureReportReceiptPending;
    readReceipt?: typeof readUpdateFailureReportReceipt;
    refreshPreparation?: typeof refreshUpdateFailureReportReceiptPreparation;
    stateDir?: string;
    validateCurrentAttempt?: () => boolean | Promise<boolean>;
    writeRecovery?: typeof writeUpdateFailureReportRecovery;
  } = {},
): Promise<UpdateFailureReportSubmitResult> {
  if (previewDigest !== prepared.previewDigest) {
    throw new Error("The update report preview is stale. Review it again before submitting.");
  }
  const env = options.env ?? process.env;
  const stateDir = options.stateDir ?? resolveStateDir(env);
  const context = { env, stateDir };
  const stateEnv = { ...env, OPENCLAW_STATE_DIR: stateDir };
  if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
    throw new Error("Update report submission requires a current authenticated client.");
  }
  const finalizeReceipt = options.finalizeReceipt ?? finalizeUpdateFailureReportReceipt;
  const readReceipt = options.readReceipt ?? readUpdateFailureReportReceipt;
  const recovered = await readUpdateFailureReportRecovery(prepared.savedReportPath);
  if (recovered) {
    if (recovered.status === "fallback" && recovered.fallbackUrl !== prepared.url) {
      throw new Error("Saved update report fallback does not match the reviewed report.");
    }
    let currentReceipt: UpdateFailureReportReceipt | null = null;
    let receiptReadSucceeded = false;
    try {
      currentReceipt = readReceipt(prepared.attemptId, stateEnv);
      receiptReadSucceeded = true;
    } catch {
      // A durable terminal record remains authoritative while the state database is unavailable.
    }
    if (currentReceipt && currentReceipt.reservationId !== recovered.reservationId) {
      await discardUpdateFailureReportRecoveryBestEffort(prepared.savedReportPath);
      return resultFromExistingReceipt(currentReceipt, prepared.savedReportPath, prepared.url);
    }
    const finalized = retryUpdateReportStateWrite(() =>
      finalizeReceipt(prepared.attemptId, recovered, stateEnv),
    );
    const recoveryMatched =
      finalized ||
      tryMatchUpdateFailureReportRecovery(recovered, () =>
        readReceipt(prepared.attemptId, stateEnv),
      );
    if (recoveryMatched) {
      await discardUpdateFailureReportRecoveryBestEffort(prepared.savedReportPath);
    } else {
      try {
        currentReceipt = readReceipt(prepared.attemptId, stateEnv);
        receiptReadSucceeded = true;
      } catch {
        // Keep the durable record private when current ownership cannot be rechecked.
      }
      if (currentReceipt && currentReceipt.reservationId !== recovered.reservationId) {
        await discardUpdateFailureReportRecoveryBestEffort(prepared.savedReportPath);
        return resultFromExistingReceipt(currentReceipt, prepared.savedReportPath, prepared.url);
      }
    }
    if (recovered.status === "retryable") {
      if (!recoveryMatched && receiptReadSucceeded && currentReceipt === null) {
        await discardUpdateFailureReportRecoveryBestEffort(prepared.savedReportPath);
      } else {
        return {
          message: "No GitHub issue submission was started. This report can be retried.",
          savedReportPath: prepared.savedReportPath,
          status: "retryable",
        };
      }
    } else if (recovered.status === "fallback") {
      if (!recoveryMatched) {
        const recoveryStillOwned = retryUpdateReportStateWrite(() =>
          (options.refreshPreparation ?? refreshUpdateFailureReportReceiptPreparation)(
            prepared.attemptId,
            recovered.reservationId,
            stateEnv,
          ),
        );
        if (!recoveryStillOwned) {
          let replacement: UpdateFailureReportReceipt | null = null;
          try {
            replacement = readReceipt(prepared.attemptId, stateEnv);
          } catch {
            // The fallback stays private unless its reservation can be fenced immediately.
          }
          if (replacement && replacement.reservationId !== recovered.reservationId) {
            await discardUpdateFailureReportRecoveryBestEffort(prepared.savedReportPath);
          }
          return resultFromExistingReceipt(replacement, prepared.savedReportPath, prepared.url);
        }
      }
      return {
        fallbackUrl: recovered.fallbackUrl,
        message: "A saved prefilled browser report is ready.",
        savedReportPath: prepared.savedReportPath,
        status: "fallback",
      };
    } else {
      await discardSavedUpdateFailureReportBestEffort(
        prepared,
        { reportCreated: false, reportDirCreated: false },
        true,
      );
      return {
        savedReportPath: prepared.savedReportPath,
        status: "created",
        url: recovered.url,
      };
    }
  }
  const existingReceipt = readReceipt(prepared.attemptId, stateEnv);
  if (
    existingReceipt &&
    existingReceipt.status !== "preparing" &&
    existingReceipt.status !== "retryable"
  ) {
    if (existingReceipt.status === "created") {
      await discardSavedUpdateFailureReportBestEffort(
        prepared,
        { reportCreated: false, reportDirCreated: false },
        true,
      );
    }
    return resultFromExistingReceipt(existingReceipt, prepared.savedReportPath, prepared.url);
  }
  if (options.validateCurrentAttempt && !(await options.validateCurrentAttempt())) {
    return {
      message: "This failed update attempt is stale or unavailable.",
      savedReportPath: prepared.savedReportPath,
      status: "stale",
    };
  }

  const reservationId = randomUUID();
  const reservation = reserveUpdateFailureReportReceipt(
    prepared.attemptId,
    reservationId,
    stateEnv,
  );
  if (!reservation.reserved) {
    if (reservation.receipt?.status === "created") {
      await discardSavedUpdateFailureReportBestEffort(
        prepared,
        { reportCreated: false, reportDirCreated: false },
        true,
      );
    }
    return resultFromExistingReceipt(reservation.receipt, prepared.savedReportPath, prepared.url);
  }

  const saved: SavedUpdateFailureReport = { reportCreated: false, reportDirCreated: false };
  const cleanupOwnedPreparation = (): boolean =>
    retryUpdateReportStateWrite(() =>
      releaseUpdateFailureReportReceiptWithCleanup(
        prepared.attemptId,
        reservationId,
        () => discardSavedUpdateFailureReportSync(prepared),
        stateEnv,
      ),
    );
  try {
    await savePreparedUpdateFailureReport(prepared, saved, options.hasCurrentAuthority);
    if (options.validateCurrentAttempt && !(await options.validateCurrentAttempt())) {
      if (!cleanupOwnedPreparation()) {
        return resultFromExistingReceipt(
          readReceipt(prepared.attemptId, stateEnv),
          prepared.savedReportPath,
          prepared.url,
        );
      }
      return {
        message: "This failed update attempt is stale or unavailable.",
        savedReportPath: prepared.savedReportPath,
        status: "stale",
      };
    }
    if (options.hasCurrentAuthority && !options.hasCurrentAuthority()) {
      throw new Error("Update report submission requires a current authenticated client.");
    }
  } catch (error) {
    try {
      cleanupOwnedPreparation();
    } catch {
      // The original preparation or authority failure remains actionable; a successor keeps custody.
    }
    throw error;
  }

  const assertCurrentPreCreateState = () => assertUpdateReportPreCreateState(options);
  const afterAuthPreflight = assertCurrentPreCreateState;
  const beforeIssueCreate = async () => {
    await assertCurrentPreCreateState();
    const markPending = options.markPending ?? markUpdateFailureReportReceiptPending;
    if (!markPending(prepared.attemptId, reservationId, stateEnv)) {
      throw new UpdateReportPreCreateGuardError(
        "Update report preparation is no longer owned by this request.",
        "reservation",
      );
    }
  };
  const createIssue =
    options.createIssue ??
    ((issue: SanitizedGithubIssue, hooks: GithubIssueCreateAsyncHooks) =>
      createGithubIssueAsync(issue, undefined, hooks));
  let created: GithubIssueCreateResult;
  try {
    created = await createIssue(prepared, { afterAuthPreflight, beforeIssueCreate });
  } catch (error) {
    if (!(error instanceof UpdateReportPreCreateGuardError)) {
      throw error;
    }
    if (error.reason === "reservation") {
      return resultFromExistingReceipt(
        readReceipt(prepared.attemptId, stateEnv),
        prepared.savedReportPath,
        prepared.url,
      );
    }
    if (!cleanupOwnedPreparation()) {
      return resultFromExistingReceipt(
        readReceipt(prepared.attemptId, stateEnv),
        prepared.savedReportPath,
        prepared.url,
      );
    }
    if (error.reason === "stale") {
      return {
        message: error.message,
        savedReportPath: prepared.savedReportPath,
        status: "stale",
      };
    }
    throw error;
  }
  if (created.ok) {
    const receipt: UpdateFailureReportRecovery = {
      reservationId,
      status: "created",
      url: created.url,
    };
    const finalized = retryUpdateReportStateWrite(() =>
      finalizeReceipt(prepared.attemptId, receipt, stateEnv),
    );
    if (finalized) {
      await discardUpdateFailureReportRecoveryBestEffort(prepared.savedReportPath);
      await discardSavedUpdateFailureReportBestEffort(prepared, saved, true);
    } else {
      const recoverySaved = await (options.writeRecovery ?? writeUpdateFailureReportRecovery)(
        prepared.savedReportPath,
        receipt,
      ).catch(() => false);
      if (recoverySaved) {
        await discardSavedUpdateFailureReportBestEffort(prepared, saved, true);
      } else {
        return {
          message:
            "GitHub issue was created, but its local receipt could not be saved. Do not submit this report again.",
          savedReportPath: prepared.savedReportPath,
          status: "created",
          url: created.url,
        };
      }
    }
    return { savedReportPath: prepared.savedReportPath, status: "created", url: created.url };
  }
  if (created.ambiguous) {
    return {
      message:
        "GitHub issue submission may have completed, but confirmation was unavailable. Do not submit this report again.",
      savedReportPath: prepared.savedReportPath,
      status: "pending",
    };
  }
  if (!("fallbackUrl" in created)) {
    const receipt: UpdateFailureReportRecovery = {
      reservationId,
      status: "retryable",
    };
    const retryableFinalized = retryUpdateReportStateWrite(() =>
      finalizeReceipt(prepared.attemptId, receipt, stateEnv),
    );
    const retryableRecovered =
      retryableFinalized ||
      (await (options.writeRecovery ?? writeUpdateFailureReportRecovery)(
        prepared.savedReportPath,
        receipt,
      ).catch(() => false));
    if (!retryableRecovered) {
      return {
        message:
          "GitHub issue creation did not start, but retry state could not be saved. Do not retry this report yet.",
        savedReportPath: prepared.savedReportPath,
        status: "pending",
      };
    }
    return {
      message: sanitizeReportField(created.message, context),
      savedReportPath: prepared.savedReportPath,
      status: "retryable",
    };
  }
  const message = sanitizeReportField(created.message, context);
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
    return resultFromExistingReceipt(replacement, prepared.savedReportPath, prepared.url);
  }
  const receipt: UpdateFailureReportRecovery = {
    fallbackUrl: created.fallbackUrl,
    reservationId,
    status: "fallback",
  };
  const fallbackFinalized = retryUpdateReportStateWrite(() =>
    finalizeReceipt(prepared.attemptId, receipt, stateEnv),
  );
  const fallbackRecovered =
    fallbackFinalized ||
    (await (options.writeRecovery ?? writeUpdateFailureReportRecovery)(
      prepared.savedReportPath,
      receipt,
    ).catch(() => false));
  if (!fallbackRecovered) {
    return {
      message:
        "The browser report handoff could not be saved safely. No issue submission was started; retry this action later.",
      savedReportPath: prepared.savedReportPath,
      status: "retryable",
    };
  }
  if (!fallbackFinalized) {
    const recoveryStillOwned = retryUpdateReportStateWrite(() =>
      (options.refreshPreparation ?? refreshUpdateFailureReportReceiptPreparation)(
        prepared.attemptId,
        reservationId,
        stateEnv,
      ),
    );
    if (!recoveryStillOwned) {
      await discardUpdateFailureReportRecoveryBestEffort(prepared.savedReportPath);
      let replacement: UpdateFailureReportReceipt | null = null;
      try {
        replacement = readReceipt(prepared.attemptId, stateEnv);
      } catch {
        // The recovery cannot be exposed without current receipt ownership.
      }
      return resultFromExistingReceipt(replacement, prepared.savedReportPath, prepared.url);
    }
  }
  return {
    fallbackUrl: created.fallbackUrl,
    message,
    savedReportPath: prepared.savedReportPath,
    status: "fallback",
  };
}
