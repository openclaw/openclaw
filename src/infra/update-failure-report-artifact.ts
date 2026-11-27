/** Filesystem lifecycle for a non-authoritative, sanitized update report body. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { replaceFileAtomic } from "@openclaw/fs-safe/atomic";
import {
  sanitizeTriageUpdateFailure,
  type TriageUpdateFailure,
} from "../commands/triage-update.js";
import { resolveStateDir } from "../config/paths.js";
import { sha256Hex } from "./crypto-digest.js";
import { ignoreMissingPath } from "./errno.js";
import { formatErrorMessage } from "./errors.js";
import type { PreparedUpdateFailureReport } from "./update-failure-report-prepare.js";

async function readSavedUpdateReport(filePath: string): Promise<string | undefined> {
  return fs.readFile(filePath, "utf8").catch(ignoreMissingPath);
}

async function writeReportText(
  filePath: string,
  content: string,
  assertCurrent?: () => void,
): Promise<void> {
  // Unlike beforeRename, this synchronous dependency guard covers each new
  // mutation after an await, including rename retries and copy fallback.
  await replaceFileAtomic({
    allowDrvfsRenameRecovery: true,
    filePath,
    content,
    mode: 0o600,
    dirMode: 0o700,
    copyFallbackOnPermissionError: true,
    syncTempFile: true,
    syncParentDir: true,
    assertBeforeMutation: assertCurrent,
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
  assertCurrent?: () => void,
): Promise<string> {
  const outputPath = path.join(directory, updateDiagnosticArtifactName("lint"));
  await writeReportText(outputPath, `${JSON.stringify(inventory)}\n`, assertCurrent);
  return outputPath;
}

export async function writeTriageUpdateFailure(
  failure: TriageUpdateFailure,
  options: { env?: NodeJS.ProcessEnv; outputPath?: string; assertCurrent?: () => void } = {},
): Promise<string> {
  options.assertCurrent?.();
  const env = options.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const outputPath =
    options.outputPath ??
    path.join(stateDir, "logs", "support", updateDiagnosticArtifactName("failure"));
  const inventory = sanitizeTriageUpdateFailure(failure, { env, stateDir }, "inventory");
  let detail: string | undefined;
  if ("result" in inventory && inventory.result.steps.some((step) => step.doctorLintFindings)) {
    detail = await writeUpdateFailureLintArtifact(
      inventory,
      path.dirname(outputPath),
      options.assertCurrent,
    ).then(
      (inventoryPath) => `Complete Doctor lint inventory: ${inventoryPath}`,
      (error: unknown) =>
        `Complete Doctor lint inventory unavailable: ${formatErrorMessage(error)}`,
    );
  }
  options.assertCurrent?.();
  const sanitized = sanitizeTriageUpdateFailure(inventory, { env, stateDir }, "artifact", detail);
  const body = `${JSON.stringify(sanitized)}\n`;
  // The managed helper's private handoff keeps the latest complete outcome after cleanup.
  await writeReportText(outputPath, body, options.assertCurrent);
  return outputPath;
}

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
): Promise<void> {
  // Remove the rename source first. After receipt ownership is revoked, this
  // ordering prevents a paused publisher from moving staged content back into
  // the final report path between cleanup operations.
  await fs.rm(stagedReportPath(prepared), { force: true });
  await fs.rm(prepared.savedReportPath, { force: true });
  await fs.rmdir(path.dirname(prepared.savedReportPath)).catch((error: unknown) => {
    if (!hasErrorCode(error, "ENOENT", "ENOTEMPTY")) {
      throw error;
    }
  });
}

export async function discardSavedUpdateFailureReportBestEffort(
  prepared: PreparedUpdateFailureReport,
): Promise<void> {
  await discardSavedUpdateFailureReport(prepared).catch(() => {
    // Optional artifact cleanup must not replace the report submission result.
  });
}

/** Captures attempt artifacts once; cleanup protects the current receipt after enumeration. */
export async function listRetiredUpdateFailureReportArtifacts(
  prepared: PreparedUpdateFailureReport,
): Promise<string[]> {
  const base = path.parse(prepared.savedReportPath);
  const entries = await fs
    .readdir(base.dir)
    .catch((error: unknown) => ignoreMissingPath(error) ?? []);
  return entries
    .filter((entry) => isAttemptArtifactName(base, entry))
    .map((entry) => path.join(base.dir, entry));
}

/** Deletes only a previously captured set; this function never performs a fresh scan. */
export async function removeRetiredUpdateFailureReportArtifacts(
  artifactPaths: readonly string[],
): Promise<void> {
  for (const artifactPath of artifactPaths) {
    await fs.rm(artifactPath, { force: true }).catch(() => {
      // A later sweep can remove these non-authoritative retired artifacts.
    });
  }
}

/** Writes reviewed content to a non-public staging name under live client authority. */
export async function savePreparedUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
  hasCurrentAuthority?: () => boolean,
): Promise<void> {
  const ensureCurrentAuthority = () => {
    if (hasCurrentAuthority && !hasCurrentAuthority()) {
      throw new Error("Update report persistence requires a current authenticated client.");
    }
  };
  const reportDir = path.dirname(prepared.savedReportPath);
  ensureCurrentAuthority();
  await fs.mkdir(reportDir, { mode: 0o700, recursive: true });
  ensureCurrentAuthority();
  let stagedReportCreated = false;
  try {
    await fs.writeFile(stagedReportPath(prepared), prepared.body, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    stagedReportCreated = true;
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
    const existing = await readSavedUpdateReport(stagedReportPath(prepared));
    if (existing !== undefined && existing !== prepared.body) {
      throw new Error("The saved update report does not match the reviewed preview.", {
        cause: error,
      });
    }
  }
  ensureCurrentAuthority();
  if (stagedReportCreated) {
    await fs.chmod(stagedReportPath(prepared), 0o600);
  }
  ensureCurrentAuthority();
}

/** Publishes staged content only after the caller acquired the durable receipt phase. */
export async function publishPreparedUpdateFailureReport(
  prepared: PreparedUpdateFailureReport,
): Promise<void> {
  await fs.rename(stagedReportPath(prepared), prepared.savedReportPath);
  await fs.chmod(prepared.savedReportPath, 0o600);
}
