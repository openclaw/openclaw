/** Filesystem lifecycle for a non-authoritative, sanitized update report body. */
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { writeTriageUpdateFailure } from "../commands/triage-update.js";
import { resolveStateDir } from "../config/paths.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { classifyUpdateOutcome } from "../shared/update-outcome.js";
import { writeTextAtomic } from "./json-files.js";
import { formatUpdateDoctorLintFinding } from "./update-doctor-lint.js";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";
import type { UpdateRunReport } from "./update-run-report.js";
import type { UpdateRunResult } from "./update-runner-types.js";

/** Terminal exports never write into state retained by an unresolved recovery owner. */
export async function writeUpdateRunReportArtifact(params: {
  result: UpdateRunResult;
  report: Pick<UpdateRunReport, "markdown">;
  env?: NodeJS.ProcessEnv;
  detached?: boolean;
}): Promise<string> {
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const id = (!params.detached && z.uuid().safeParse(params.result.runId).data) || randomUUID();
  const directory = params.detached ? os.tmpdir() : path.join(stateDir, "update-reports");
  const outputPath = path.join(directory, `${id}.md`);
  const failurePath =
    classifyUpdateOutcome(params.result) === "failed"
      ? await writeTriageUpdateFailure(
          { result: params.result },
          {
            env,
            outputPath: params.detached
              ? path.join(directory, `openclaw-update-failure-${id}.json`)
              : undefined,
          },
        )
      : undefined;
  const findings = params.result.steps.flatMap((step) => step.doctorLintFindings ?? []);
  const body = [
    params.report.markdown,
    `\n## Complete Doctor lint findings (${findings.length})\n`,
    ...findings.map((finding) => `- ${formatUpdateDoctorLintFinding(finding, env)}`),
    failurePath ? `\nComplete diagnostic JSON: ${path.relative(directory, failurePath)}` : "",
  ].join("\n");
  await writeTextAtomic(
    outputPath,
    redactSupportString(body, { env, stateDir }, { maxLength: Number.MAX_SAFE_INTEGER }),
    { mode: 0o600, dirMode: 0o700 },
  );
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
  const artifactKey = createHash("sha256")
    .update(`${reservationId}\0${previewDigest}`)
    .digest("hex");
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
  const reportDirExisted = await pathExists(reportDir);
  ensureCurrentAuthority();
  await fs.mkdir(reportDir, { mode: 0o700, recursive: true });
  saved.reportDirCreated = !reportDirExisted;
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
