/** Filesystem lifecycle for a non-authoritative, sanitized update report body. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  sanitizeTriageUpdateFailure,
  type TriageUpdateFailure,
} from "../commands/triage-update.js";
import { resolveStateDir } from "../config/paths.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { classifyUpdateOutcome } from "../shared/update-outcome.js";
import { sha256Hex } from "./crypto-digest.js";
import { formatErrorMessage } from "./errors.js";
import { withFileLock } from "./file-lock.js";
import { writeTextAtomic } from "./json-files.js";
import { formatUpdateDoctorLintFinding } from "./update-doctor-lint.js";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";
import type { UpdateRunRecord } from "./update-run-record.js";
import {
  isUpdateRunReportInProgress,
  renderUpdateRunReport,
  type UpdateRunReport,
} from "./update-run-report.js";
import type { UpdateRunResult } from "./update-runner-types.js";

const DOCTOR_LINT_REPORT_SECTION = "\n## Complete Doctor lint findings (";

async function withUpdateReportWrite<T>(outputPath: string, write: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  return withFileLock(
    outputPath,
    {
      retries: { retries: 200, factor: 1, minTimeout: 25, maxTimeout: 25, randomize: false },
      stale: 30_000,
      staleRecovery: "remove-if-definitely-stale",
    },
    write,
  );
}

/** The recovery writer can finish a run after its CLI exits without publishing a report. */
export async function refreshUpdateRunReportArtifact(
  run: UpdateRunRecord,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<void> {
  if (run.status === "running") {
    return;
  }
  const env = options.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const id = z.uuid().parse(run.runId);
  const outputPath = path.join(stateDir, "update-reports", `${id}.md`);
  await withUpdateReportWrite(outputPath, async () => {
    const previous = await fs.readFile(outputPath, "utf8").catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) {
        return "";
      }
      throw error;
    });
    // A child can commit the terminal ledger before its report is published.
    // Repair missing/pending projections, but retain terminal or user-authored bytes.
    if (previous && !isUpdateRunReportInProgress(previous)) {
      return;
    }
    // Complete inventories and diagnostic links are not bounded ledger fields.
    // Preserve the artifact writer's appendix while refreshing only its summary.
    const appendixStart = previous.indexOf(DOCTOR_LINT_REPORT_SECTION);
    const appendix = appendixStart < 0 ? "" : `\n${previous.slice(appendixStart)}`;
    const report = renderUpdateRunReport(run, { mode: run.target.kind });
    await writeTextAtomic(
      outputPath,
      redactSupportString(
        `${report.markdown}${appendix}`,
        { env, stateDir },
        { maxLength: Number.MAX_SAFE_INTEGER },
      ),
      { mode: 0o600, dirMode: 0o700 },
    );
  });
}

function updateDiagnosticArtifactName(kind: "lint" | "failure", id: string = randomUUID()): string {
  // Shipped support redactors must not mistake a numeric UUID tail for an account ID.
  return `openclaw-update-${kind}-${id.replaceAll("-", "_")}.json`;
}

/** Complete sanitized inventories are named artifacts, never restored-runtime input. */
async function writeUpdateFailureLintArtifact(
  inventory: TriageUpdateFailure,
  directory: string,
): Promise<string> {
  const outputPath = path.join(directory, updateDiagnosticArtifactName("lint"));
  await writeTextAtomic(outputPath, `${JSON.stringify(inventory)}\n`, {
    mode: 0o600,
    dirMode: 0o700,
  });
  return outputPath;
}

export async function writeTriageUpdateFailure(
  failure: TriageUpdateFailure,
  options: { env?: NodeJS.ProcessEnv; outputPath?: string } = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const outputPath =
    options.outputPath ??
    path.join(stateDir, "logs", "support", updateDiagnosticArtifactName("failure"));
  const inventory = sanitizeTriageUpdateFailure(failure, { env, stateDir }, "inventory");
  if ("result" in inventory && inventory.result.steps.some((step) => step.doctorLintFindings)) {
    const detail = await writeUpdateFailureLintArtifact(inventory, path.dirname(outputPath)).then(
      (inventoryPath) => `Complete Doctor lint inventory: ${inventoryPath}`,
      (error: unknown) =>
        `Complete Doctor lint inventory unavailable: ${formatErrorMessage(error)}`,
    );
    // The released reader strips new fields and successful steps. Its error text retains
    // this diagnostic link even after a later plugin failure or another CLI handoff.
    inventory.error = `${inventory.error ?? inventory.result.reason ?? "Update failed"}. ${detail}`;
  }
  const sanitized = sanitizeTriageUpdateFailure(inventory, { env, stateDir }, "artifact");
  const body = `${JSON.stringify(sanitized)}\n`;
  // The managed helper's private handoff keeps the latest complete outcome after cleanup.
  await writeTextAtomic(outputPath, body, { mode: 0o600, dirMode: 0o700 });
  return outputPath;
}

/** Terminal exports never write into state retained by an unresolved recovery owner. */
export async function writeUpdateRunReportArtifact(params: {
  result: UpdateRunResult;
  report:
    | Pick<UpdateRunReport, "markdown">
    | ((run?: UpdateRunRecord) => Pick<UpdateRunReport, "markdown">);
  readRun?: () => UpdateRunRecord | undefined;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
}): Promise<string> {
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const id = (!params.detached && z.uuid().safeParse(params.result.runId).data) || randomUUID();
  // Atomic writes enforce their parent mode; never apply private report permissions
  // to the shared temporary root. Returned reports remain available to the operator.
  const directory = params.detached
    ? await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-report-"))
    : path.join(stateDir, "update-reports");
  const outputPath = path.join(directory, `${id}.md`);
  const write = async () => {
    const run = params.readRun?.();
    const report = typeof params.report === "function" ? params.report(run) : params.report;
    if (params.readRun && !run) {
      const previous = await fs.readFile(outputPath, "utf8").catch((error: unknown) => {
        if (hasErrorCode(error, "ENOENT")) {
          return "";
        }
        throw error;
      });
      // An old reader can lose schema admission after the helper settles.
      // Its fallback result cannot replace already-published terminal details.
      if (previous && !isUpdateRunReportInProgress(previous)) {
        return outputPath;
      }
    }
    const failurePath =
      classifyUpdateOutcome(params.result) === "failed"
        ? await writeTriageUpdateFailure(
            { result: params.result },
            {
              env,
              outputPath: params.detached
                ? path.join(directory, updateDiagnosticArtifactName("failure", id))
                : undefined,
            },
          )
        : undefined;
    const findings = params.result.steps.flatMap((step) => step.doctorLintFindings ?? []);
    const body = [
      report.markdown,
      `${DOCTOR_LINT_REPORT_SECTION}${findings.length})\n`,
      ...findings.map((finding) => `- ${formatUpdateDoctorLintFinding(finding, env)}`),
      failurePath ? `\nBounded diagnostic JSON: ${path.relative(directory, failurePath)}` : "",
    ].join("\n");
    await writeTextAtomic(
      outputPath,
      redactSupportString(body, { env, stateDir }, { maxLength: Number.MAX_SAFE_INTEGER }),
      { mode: 0o600, dirMode: 0o700 },
    );
    return outputPath;
  };
  if (params.detached) {
    return write();
  }
  await withUpdateReportWrite(outputPath, write);
  // Reconcile after release, including async rename and unlock. A helper that
  // exhausted its lock wait has already settled the ledger; one settling after
  // this read can acquire the released lock and finish the projection itself.
  const settled = params.readRun?.();
  if (settled) {
    await refreshUpdateRunReportArtifact(settled, { env });
  }
  return outputPath;
}

export type SavedUpdateFailureReport = {
  reportCreated: boolean;
  reportDirCreated: boolean;
  stagedReportCreated: boolean;
};

export function bindSavedReportArtifact(
  prepared: PreparedUpdateFailureReport,
  reservationId: string,
  previewDigest = prepared.previewDigest,
): PreparedUpdateFailureReport {
  const parsed = path.parse(prepared.savedReportPath);
  const artifactKey = sha256Hex(`${reservationId}\0${previewDigest}`);
  return {
    ...prepared,
    savedReportPath: path.join(parsed.dir, `${parsed.name}.${artifactKey}${parsed.ext}`),
  };
}

function hasErrorCode(error: unknown, ...codes: string[]): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    codes.includes(error.code)
  );
}

function stagedReportPath(prepared: PreparedUpdateFailureReport): string {
  return `${prepared.savedReportPath}.pending`;
}

function isAttemptArtifactName(base: path.ParsedPath, entry: string): boolean {
  if (!entry.startsWith(`${base.name}.`)) {
    return false;
  }
  const withoutStageSuffix = entry.endsWith(".pending") ? entry.slice(0, -8) : entry;
  if (!withoutStageSuffix.endsWith(base.ext)) {
    return false;
  }
  const artifactKey = withoutStageSuffix.slice(
    base.name.length + 1,
    withoutStageSuffix.length - base.ext.length,
  );
  return /^[a-f0-9]{64}$/u.test(artifactKey);
}

export async function discardSavedUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  saved: SavedUpdateFailureReport,
  removeExistingReport = false,
): Promise<void> {
  // Remove the rename source first. After receipt ownership is revoked, this
  // ordering prevents a paused publisher from moving staged content back into
  // the final report path between cleanup operations.
  if (saved.stagedReportCreated || removeExistingReport) {
    await fs.rm(stagedReportPath(prepared), { force: true });
  }
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

export async function discardSavedUpdateFailureReportBestEffort(
  prepared: PreparedUpdateFailureReport,
  saved: SavedUpdateFailureReport,
  removeExistingReport = false,
): Promise<void> {
  await discardSavedUpdateFailureReport(prepared, saved, removeExistingReport).catch(() => {});
}

/** Captures the immutable retired-artifact set for one fenced sweep generation. */
export async function listRetiredUpdateFailureReportArtifacts(
  prepared: PreparedUpdateFailureReport,
  keep?: PreparedUpdateFailureReport,
): Promise<string[]> {
  const base = path.parse(prepared.savedReportPath);
  const keepPaths = new Set(keep ? [keep.savedReportPath, stagedReportPath(keep)] : []);
  const entries = await fs.readdir(base.dir).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  });
  return entries
    .filter((entry) => isAttemptArtifactName(base, entry))
    .map((entry) => path.join(base.dir, entry))
    .filter((artifactPath) => !keepPaths.has(artifactPath));
}

/** Deletes only a previously captured set; this function never performs a fresh scan. */
export async function removeRetiredUpdateFailureReportArtifacts(
  artifactPaths: readonly string[],
): Promise<void> {
  for (const artifactPath of artifactPaths) {
    await fs.rm(artifactPath, { force: true }).catch(() => {});
  }
}

/** Writes reviewed content to a non-public staging name under live client authority. */
export async function savePreparedUpdateFailureReport(
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
  const created = await fs.mkdir(reportDir, { mode: 0o700, recursive: true });
  saved.reportDirCreated = created !== undefined;
  ensureCurrentAuthority();
  try {
    await fs.writeFile(stagedReportPath(prepared), prepared.body, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    saved.stagedReportCreated = true;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
    const existing = await fs
      .readFile(stagedReportPath(prepared), "utf8")
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
  if (saved.stagedReportCreated) {
    await fs.chmod(stagedReportPath(prepared), 0o600);
  }
  ensureCurrentAuthority();
}

/** Publishes staged content only after the caller acquired the durable receipt phase. */
export async function publishPreparedUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  saved: SavedUpdateFailureReport,
): Promise<void> {
  await fs.rename(stagedReportPath(prepared), prepared.savedReportPath);
  saved.stagedReportCreated = false;
  saved.reportCreated = true;
  await fs.chmod(prepared.savedReportPath, 0o600);
}
