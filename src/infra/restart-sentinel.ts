import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatCliCommand } from "../cli/command-format.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import {
  executeOpenClawStateWorker,
  runOpenClawStateWorkerOperation,
} from "../state/openclaw-state-worker-store.js";
import { resolveRuntimeServiceCommit, resolveRuntimeServiceVersion } from "../version.js";
import { formatErrorMessage } from "./errors.js";
import { resolveOpenClawPackageRoot } from "./openclaw-root.js";
import type {
  RestartSentinel,
  RestartSentinelPayload,
  RestartSentinelRowState,
} from "./restart-sentinel-store.js";
import type { RestartSentinelWorkerOperations } from "./restart-sentinel.worker-contract.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import {
  beginStaleUpdateFailureReportReceiptCleanupRowSync,
  beginUpdateFailureReportReceiptCleanupRowSync,
  claimUpdateFailureReportArtifactSweepRowSync,
  completeUpdateFailureReportReceiptCleanupRowSync,
  finalizeUpdateFailureReportReceiptRowSync,
  hasUpdateFailureReportArtifactSweepLeaseRowSync,
  markUpdateFailureReportReceiptPreparedRowSync,
  markUpdateFailureReportReceiptPendingRowSync,
  readUpdateFailureReportReceiptRowSync,
  releaseUpdateFailureReportArtifactSweepRowSync,
  refreshUpdateFailureReportReceiptPreparationRowSync,
  reserveUpdateFailureReportReceiptRowSync,
  type UpdateFailureReportReceipt,
} from "./update-failure-report-receipt-store.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";

export type {
  RestartSentinelContinuation,
  RestartSentinelPayload,
} from "./restart-sentinel-store.js";
export type { UpdateFailureReportReceipt } from "./update-failure-report-receipt-store.js";

export type VerifiedGitUpdateReceipt = {
  root: string;
  sha: string;
  upstreamRef?: string;
  installedAtMs: number;
};

const sentinelLog = createSubsystemLogger("restart-sentinel");

export function formatDoctorNonInteractiveHint(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
  return `Recommended follow-up: run ${formatCliCommand(
    "openclaw doctor --non-interactive",
    env,
  )} in a terminal or approvals-capable OpenClaw surface.`;
}

async function runRestartSentinelOperation<Key extends keyof RestartSentinelWorkerOperations>(
  command: { type: Key; input: RestartSentinelWorkerOperations[Key]["input"] },
  context: OpenClawStateWorkerContext,
  assertProducerCurrent?: () => void,
): Promise<RestartSentinelWorkerOperations[Key]["output"]> {
  const captured = structuredClone(command);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    assertProducerCurrent?.();
  };
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) => scope.execute(captured),
    {
      assertCurrent,
      createAdmission: createSqliteWorkerWriteAdmission(assertCurrent, [
        context.admission.databasePath,
      ]),
    },
  );
  context.admission.assertCurrent();
  return result;
}

export async function writeRestartSentinel(
  payload: RestartSentinelPayload,
  env: NodeJS.ProcessEnv = process.env,
  assertProducerCurrent?: () => void,
): Promise<RestartSentinel> {
  return runRestartSentinelOperation(
    { type: "restartSentinel.write", input: payload },
    captureOpenClawStateWorkerContext({ env }),
    assertProducerCurrent,
  );
}

export function reserveUpdateFailureReportReceipt(
  attemptId: string,
  reservationId: string,
  previewDigest: string,
  env: NodeJS.ProcessEnv = process.env,
): { receipt: UpdateFailureReportReceipt | null; reserved: boolean } {
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      reserveUpdateFailureReportReceiptRowSync(db, attemptId, reservationId, previewDigest),
    { env },
    { operationLabel: "update-failure-report.reserve" },
  );
}

export function beginUpdateFailureReportReceiptCleanup(
  attemptId: string,
  reservationId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => beginUpdateFailureReportReceiptCleanupRowSync(db, attemptId, reservationId),
    { env },
    { operationLabel: "update-failure-report.begin-cleanup" },
  );
}

export function beginStaleUpdateFailureReportReceiptCleanup(
  attemptId: string,
  reservationId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => beginStaleUpdateFailureReportReceiptCleanupRowSync(db, attemptId, reservationId),
    { env },
    { operationLabel: "update-failure-report.begin-stale-cleanup" },
  );
}

export function completeUpdateFailureReportReceiptCleanup(
  attemptId: string,
  reservationId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => completeUpdateFailureReportReceiptCleanupRowSync(db, attemptId, reservationId),
    { env },
    { operationLabel: "update-failure-report.complete-cleanup" },
  );
}

export function claimUpdateFailureReportArtifactSweep(
  attemptId: string,
  expectedReservationId: string,
  sweepOwnerId: string,
  sweepGeneration: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      claimUpdateFailureReportArtifactSweepRowSync(
        db,
        attemptId,
        expectedReservationId,
        sweepOwnerId,
        sweepGeneration,
      ),
    { env },
    { operationLabel: "update-failure-report.claim-artifact-sweep" },
  );
}

export function hasUpdateFailureReportArtifactSweepLease(
  attemptId: string,
  expectedReservationId: string,
  sweepOwnerId: string,
  sweepGeneration: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) =>
        hasUpdateFailureReportArtifactSweepLeaseRowSync(
          db,
          attemptId,
          expectedReservationId,
          sweepOwnerId,
          sweepGeneration,
        ),
      { env },
    ) ?? false
  );
}

export function releaseUpdateFailureReportArtifactSweep(
  attemptId: string,
  expectedReservationId: string,
  sweepOwnerId: string,
  sweepGeneration: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      releaseUpdateFailureReportArtifactSweepRowSync(
        db,
        attemptId,
        expectedReservationId,
        sweepOwnerId,
        sweepGeneration,
      ),
    { env },
    { operationLabel: "update-failure-report.release-artifact-sweep" },
  );
}

export function readUpdateFailureReportReceipt(
  attemptId: string,
  env: NodeJS.ProcessEnv = process.env,
): UpdateFailureReportReceipt | null {
  return (
    withExistingOpenClawStateDatabaseReadOnly(
      ({ db }) => readUpdateFailureReportReceiptRowSync(db, attemptId),
      { env },
    ) ?? null
  );
}

export function refreshUpdateFailureReportReceiptPreparation(
  attemptId: string,
  reservationId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => refreshUpdateFailureReportReceiptPreparationRowSync(db, attemptId, reservationId),
    { env },
    { operationLabel: "update-failure-report.refresh-preparation" },
  );
}

export function finalizeUpdateFailureReportReceipt(
  attemptId: string,
  receipt: UpdateFailureReportReceipt,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) => finalizeUpdateFailureReportReceiptRowSync(db, attemptId, receipt),
    { env },
    { operationLabel: "update-failure-report.finalize" },
  );
}

export function markUpdateFailureReportReceiptPending(
  attemptId: string,
  reservationId: string,
  previewDigest: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      markUpdateFailureReportReceiptPendingRowSync(db, attemptId, reservationId, previewDigest),
    { env },
    { operationLabel: "update-failure-report.mark-pending" },
  );
}

export function markUpdateFailureReportReceiptPrepared(
  attemptId: string,
  reservationId: string,
  previewDigest: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return runOpenClawStateWriteTransaction(
    ({ db }) =>
      markUpdateFailureReportReceiptPreparedRowSync(db, attemptId, reservationId, previewDigest),
    { env },
    { operationLabel: "update-failure-report.mark-prepared" },
  );
}

/** Publish an outcome only while its producer and the captured notification are unchanged. */
export async function writeRestartSentinelIfUnchanged(params: {
  payload: RestartSentinelPayload;
  expectedRevision: number | null;
  isCurrent: () => boolean;
}): Promise<RestartSentinel | null> {
  const retired = new Error("Restart sentinel producer retired");
  try {
    return await runRestartSentinelOperation(
      {
        type: "restartSentinel.writeIfUnchanged",
        input: { payload: params.payload, expectedRevision: params.expectedRevision },
      },
      captureOpenClawStateWorkerContext(),
      () => {
        if (!params.isCurrent()) {
          throw retired;
        }
      },
    );
  } catch (error) {
    if (error === retired) {
      return null;
    }
    throw error;
  }
}

export async function readRestartSentinelSnapshot(env: NodeJS.ProcessEnv = process.env): Promise<{
  sentinel: RestartSentinel | null;
  revision: number | null;
}> {
  const reply = await readSentinelState(
    "restartSentinel.snapshot",
    captureOpenClawStateWorkerContext({ env }),
  );
  if (!reply?.ok || reply.type !== "restartSentinel.snapshot") {
    throw new Error("Restart sentinel snapshot unavailable");
  }
  return reply.snapshot;
}

export async function finalizeUpdateRestartSentinelRunningVersion(
  version = resolveRuntimeServiceVersion(process.env),
  env: NodeJS.ProcessEnv = process.env,
  commit = resolveRuntimeServiceCommit(),
  runningRoot?: string | null,
): Promise<RestartSentinel | null> {
  const context = captureOpenClawStateWorkerContext({ env });
  let snapshot: RestartSentinel | null;
  try {
    const reply = await readSentinelState("restartSentinel.current", context);
    snapshot = currentSentinel(
      reply?.ok && reply.type === "restartSentinel.current" ? reply.state : undefined,
    );
  } catch (err) {
    sentinelLog.warn(`Failed to read restart sentinel: ${formatErrorMessage(err)}`);
    return null;
  }
  if (!snapshot || snapshot.payload.kind !== "update") {
    return null;
  }
  const snapshotRoot = snapshot.payload.stats?.root;
  const expectedRoot = snapshotRoot === undefined ? null : resolveUpdateInstallRoot(snapshotRoot);
  const discoveredRoot = expectedRoot
    ? (runningRoot ??
      (await resolveOpenClawPackageRoot({
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
      })))
    : null;
  const actualRoot = discoveredRoot ? resolveUpdateInstallRoot(discoveredRoot) : null;

  return runRestartSentinelOperation(
    {
      type: "restartSentinel.finalize",
      input: { expectedRevision: snapshot.revision, version, commit, expectedRoot, actualRoot },
    },
    context,
  );
}

export async function markUpdateRestartSentinelFailure(
  reason: string,
  env: NodeJS.ProcessEnv = process.env,
  expectedOwner?: { runId?: string; handoffId?: string },
): Promise<RestartSentinel | null> {
  return runRestartSentinelOperation(
    { type: "restartSentinel.markFailure", input: { reason, expectedOwner } },
    captureOpenClawStateWorkerContext({ env }),
  );
}

export async function clearRestartSentinelIfRevision(
  expectedRevision: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return runRestartSentinelOperation(
    { type: "restartSentinel.clear", input: expectedRevision },
    captureOpenClawStateWorkerContext({ env }),
  );
}

async function readSentinelState(
  type: "restartSentinel.current" | "restartSentinel.snapshot" | "restartSentinel.installReceipt",
  context: OpenClawStateWorkerContext,
  existingOnly = false,
) {
  if (!existingOnly) {
    await executeOpenClawStateWorker(context, { type: "restartSentinel.admit", input: undefined });
  }
  const reply = await executeExistingOpenClawStateRead(
    { env: context.environment, path: context.admission.databasePath },
    { type, input: undefined },
    { context },
  );
  context.admission.assertCurrent();
  if (reply && !reply.ok) {
    throw new Error(reply.message);
  }
  return reply;
}

function currentSentinel(current: RestartSentinelRowState | undefined): RestartSentinel | null {
  if (current?.kind === "invalid") {
    sentinelLog.warn("Ignoring invalid typed restart sentinel row");
  }
  return current?.kind === "valid" ? current.sentinel : null;
}

async function readCurrentRestartSentinel(
  env: NodeJS.ProcessEnv,
  existingOnly: boolean,
): Promise<RestartSentinel | null> {
  try {
    const reply = await readSentinelState(
      "restartSentinel.current",
      captureOpenClawStateWorkerContext({ env }),
      existingOnly,
    );
    return currentSentinel(
      reply?.ok && reply.type === "restartSentinel.current" ? reply.state : undefined,
    );
  } catch (err) {
    sentinelLog.warn(`Failed to read restart sentinel: ${formatErrorMessage(err)}`);
    return null;
  }
}

export function readRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  return readCurrentRestartSentinel(env, false);
}

/** Read the restart sentinel without creating or mutating shared state. */
export function readRestartSentinelReadOnly(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  return readCurrentRestartSentinel(env, true);
}

async function readUpdateInstallReceiptPayload(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinelPayload | null> {
  try {
    const reply = await readSentinelState(
      "restartSentinel.installReceipt",
      captureOpenClawStateWorkerContext({ env }),
    );
    return reply?.ok && reply.type === "restartSentinel.installReceipt"
      ? (reply.sentinel?.payload ?? null)
      : null;
  } catch (err) {
    sentinelLog.warn(`Failed to read update install receipt: ${formatErrorMessage(err)}`);
    return null;
  }
}

export async function readVerifiedGitUpdateReceipt(
  env: NodeJS.ProcessEnv = process.env,
): Promise<VerifiedGitUpdateReceipt | null> {
  const payload = await readUpdateInstallReceiptPayload(env);
  // Receipt rows are only written after the running install verifies root and revision.
  // An error status records a post-install failure, not an untrusted install.
  if (payload?.kind !== "update" || payload.stats?.mode !== "git" || !payload.stats.after) {
    return null;
  }
  const root = payload.stats.root?.trim() ?? "";
  const sha = typeof payload.stats.after.sha === "string" ? payload.stats.after.sha.trim() : "";
  if (!root || !sha) {
    return null;
  }
  const upstreamRef =
    typeof payload.stats.after.upstreamRef === "string"
      ? payload.stats.after.upstreamRef.trim()
      : "";
  return {
    root,
    sha,
    ...(upstreamRef ? { upstreamRef } : {}),
    installedAtMs: payload.ts,
  };
}

export async function hasRestartSentinel(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  try {
    const reply = await readSentinelState(
      "restartSentinel.current",
      captureOpenClawStateWorkerContext({ env }),
    );
    return (
      currentSentinel(
        reply?.ok && reply.type === "restartSentinel.current" ? reply.state : undefined,
      ) !== null
    );
  } catch (err) {
    sentinelLog.warn(`Failed to check restart sentinel: ${formatErrorMessage(err)}`);
    return false;
  }
}

export function formatRestartSentinelMessage(payload: RestartSentinelPayload): string {
  const message = payload.message?.trim();
  if (message && (!payload.stats || payload.kind === "config-auto-recovery")) {
    return message;
  }
  const lines: string[] = [summarizeRestartSentinel(payload)];
  if (message) {
    lines.push(message);
  }
  const reason = payload.stats?.reason?.trim();
  if (reason && reason !== message) {
    lines.push(`Reason: ${reason}`);
  }
  if (payload.doctorHint?.trim()) {
    lines.push(payload.doctorHint.trim());
  }
  return lines.join("\n");
}

export function summarizeRestartSentinel(payload: RestartSentinelPayload): string {
  if (payload.kind === "config-auto-recovery") {
    return "Gateway auto-recovery";
  }
  if (
    (payload.kind === "config-apply" || payload.kind === "config-patch") &&
    payload.status === "ok" &&
    payload.stats?.requiresRestart === true
  ) {
    const mode = payload.stats?.mode ? ` (${payload.stats.mode})` : "";
    return `Gateway restart required${mode}`.trim();
  }
  const kind = payload.kind;
  const status = payload.status;
  const mode = payload.stats?.mode ? ` (${payload.stats.mode})` : "";
  const kindSegment = kind === "restart" ? "" : ` ${kind}`;
  return `Gateway restart${kindSegment} ${status}${mode}`.trim();
}

export function trimLogTail(input?: string | null, maxChars = 8000) {
  if (!input) {
    return null;
  }
  const text = input.trimEnd();
  if (text.length <= maxChars) {
    return text;
  }
  return `…${sliceUtf16Safe(text, text.length - maxChars)}`;
}
