import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatCliCommand } from "../cli/command-format.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
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
import { isSqliteLockError } from "./sqlite-error-diagnostics.js";
import type { SqliteWorkerOperationAdmission } from "./sqlite-worker-operation-admission.js";
import { createSqliteWorkerWriteAdmission } from "./sqlite-worker-store.js";
import {
  decodeUpdateFailureReportMutation,
  decodeUpdateFailureReportReservation,
  type UpdateFailureReportReceipt,
} from "./update-failure-report-receipt.js";
import { resolveUpdateInstallRoot } from "./update-install-root.js";

export type {
  RestartSentinelContinuation,
  RestartSentinelPayload,
} from "./restart-sentinel-store.js";
export type { UpdateFailureReportReceipt } from "./update-failure-report-receipt.js";

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
  decodeCommit?: (value: unknown) => RestartSentinelWorkerOperations[Key]["output"] | undefined,
): Promise<RestartSentinelWorkerOperations[Key]["output"]> {
  const captured = structuredClone(command);
  const assertCurrent = () => {
    context.admission.assertCurrent();
    assertProducerCurrent?.();
  };
  for (let attempt = 0; ; attempt += 1) {
    let admission: SqliteWorkerOperationAdmission | undefined;
    let transactionRequested = false;
    const createAdmission = createSqliteWorkerWriteAdmission(() => {
      transactionRequested = true;
      assertCurrent();
    }, [context.admission.databasePath]);
    try {
      const result = await runOpenClawStateWorkerOperation(
        context,
        (scope) => scope.execute(captured),
        {
          assertCurrent,
          createAdmission: (operation) => {
            const retained = createAdmission(operation);
            admission = retained.admission;
            return retained;
          },
        },
      );
      context.admission.assertCurrent();
      return result;
    } catch (error) {
      context.admission.assertCurrent();
      // The admission belongs to this command; committed facts survive a lost ordinary reply.
      const facts = admission?.committed?.facts;
      if (decodeCommit && isRecord(facts) && facts.kind === "update-report-result") {
        const result = decodeCommit(facts.value);
        if (result !== undefined) {
          return result;
        }
      }
      // Before the worker requests transaction authority, its domain mutation has not run.
      if (decodeCommit && attempt === 0 && !transactionRequested && isSqliteLockError(error)) {
        continue;
      }
      throw error;
    }
  }
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
  context = captureOpenClawStateWorkerContext({ env }),
): Promise<{ receipt: UpdateFailureReportReceipt | null; reserved: boolean }> {
  return runRestartSentinelOperation(
    { type: "restartSentinel.reserve", input: { attemptId, reservationId, previewDigest } },
    context,
    undefined,
    decodeUpdateFailureReportReservation,
  );
}

export function beginUpdateFailureReportReceiptCleanup(
  attemptId: string,
  reservationId: string,
  env: NodeJS.ProcessEnv = process.env,
  context = captureOpenClawStateWorkerContext({ env }),
): Promise<boolean> {
  return runRestartSentinelOperation(
    { type: "restartSentinel.beginCleanup", input: { attemptId, reservationId } },
    context,
    undefined,
    decodeUpdateFailureReportMutation,
  );
}

export function beginStaleUpdateFailureReportReceiptCleanup(
  attemptId: string,
  reservationId: string,
  env: NodeJS.ProcessEnv = process.env,
  context = captureOpenClawStateWorkerContext({ env }),
): Promise<boolean> {
  return runRestartSentinelOperation(
    { type: "restartSentinel.beginStaleCleanup", input: { attemptId, reservationId } },
    context,
    undefined,
    decodeUpdateFailureReportMutation,
  );
}

export function completeUpdateFailureReportReceiptCleanup(
  attemptId: string,
  reservationId: string,
  env: NodeJS.ProcessEnv = process.env,
  context = captureOpenClawStateWorkerContext({ env }),
): Promise<boolean> {
  return runRestartSentinelOperation(
    { type: "restartSentinel.completeCleanup", input: { attemptId, reservationId } },
    context,
    undefined,
    decodeUpdateFailureReportMutation,
  );
}

export function claimUpdateFailureReportArtifactSweep(
  attemptId: string,
  expectedReservationId: string,
  sweepOwnerId: string,
  sweepGeneration: string,
  env: NodeJS.ProcessEnv = process.env,
  context = captureOpenClawStateWorkerContext({ env }),
): Promise<boolean> {
  return runRestartSentinelOperation(
    {
      type: "restartSentinel.claimSweep",
      input: { attemptId, expectedReservationId, sweepOwnerId, sweepGeneration },
    },
    context,
    undefined,
    decodeUpdateFailureReportMutation,
  );
}

export function releaseUpdateFailureReportArtifactSweep(
  attemptId: string,
  expectedReservationId: string,
  sweepOwnerId: string,
  sweepGeneration: string,
  env: NodeJS.ProcessEnv = process.env,
  context = captureOpenClawStateWorkerContext({ env }),
): Promise<boolean> {
  return runRestartSentinelOperation(
    {
      type: "restartSentinel.releaseSweep",
      input: { attemptId, expectedReservationId, sweepOwnerId, sweepGeneration },
    },
    context,
    undefined,
    decodeUpdateFailureReportMutation,
  );
}

export function refreshUpdateFailureReportReceiptPreparation(
  attemptId: string,
  reservationId: string,
  env: NodeJS.ProcessEnv = process.env,
  context = captureOpenClawStateWorkerContext({ env }),
): Promise<boolean> {
  return runRestartSentinelOperation(
    { type: "restartSentinel.refreshPreparation", input: { attemptId, reservationId } },
    context,
    undefined,
    decodeUpdateFailureReportMutation,
  );
}

export function finalizeUpdateFailureReportReceipt(
  attemptId: string,
  receipt: UpdateFailureReportReceipt,
  env: NodeJS.ProcessEnv = process.env,
  context = captureOpenClawStateWorkerContext({ env }),
): Promise<boolean> {
  return runRestartSentinelOperation(
    { type: "restartSentinel.finalizeReceipt", input: { attemptId, receipt } },
    context,
    undefined,
    decodeUpdateFailureReportMutation,
  );
}

export function markUpdateFailureReportReceiptPending(
  attemptId: string,
  reservationId: string,
  previewDigest: string,
  env: NodeJS.ProcessEnv = process.env,
  context = captureOpenClawStateWorkerContext({ env }),
  assertProducerCurrent?: () => void,
): Promise<boolean> {
  return runRestartSentinelOperation(
    { type: "restartSentinel.markPending", input: { attemptId, reservationId, previewDigest } },
    context,
    assertProducerCurrent,
    decodeUpdateFailureReportMutation,
  );
}

export function markUpdateFailureReportReceiptPrepared(
  attemptId: string,
  reservationId: string,
  previewDigest: string,
  env: NodeJS.ProcessEnv = process.env,
  context = captureOpenClawStateWorkerContext({ env }),
): Promise<boolean> {
  return runRestartSentinelOperation(
    { type: "restartSentinel.markPrepared", input: { attemptId, reservationId, previewDigest } },
    context,
    undefined,
    decodeUpdateFailureReportMutation,
  );
}

export async function readUpdateFailureReportReceipt(
  attemptId: string,
  env: NodeJS.ProcessEnv = process.env,
  context = captureOpenClawStateWorkerContext({ env }),
): Promise<UpdateFailureReportReceipt | null> {
  const reply = await executeExistingOpenClawStateRead(
    { env: context.environment, path: context.admission.databasePath },
    { type: "restartSentinel.reportReceipt", input: attemptId },
    { context, current: true },
  );
  context.admission.assertCurrent();
  if (reply && !reply.ok) {
    throw new Error(reply.message);
  }
  return reply?.ok && reply.type === "restartSentinel.reportReceipt" ? reply.receipt : null;
}

export async function hasUpdateFailureReportArtifactSweepLease(
  attemptId: string,
  expectedReservationId: string,
  sweepOwnerId: string,
  sweepGeneration: string,
  env: NodeJS.ProcessEnv = process.env,
  context = captureOpenClawStateWorkerContext({ env }),
): Promise<boolean> {
  const receipt = await readUpdateFailureReportReceipt(attemptId, env, context);
  return (
    receipt?.artifactSweep === "pending" &&
    receipt.reservationId === expectedReservationId &&
    receipt.sweepOwnerId === sweepOwnerId &&
    receipt.sweepGeneration === sweepGeneration
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
  const snapshot = await readCurrentRestartSentinel(() => context, false);
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
  resolveContext: () => OpenClawStateWorkerContext,
  existingOnly: boolean,
  action: "read" | "check" = "read",
): Promise<RestartSentinel | null> {
  try {
    const reply = await readSentinelState(
      "restartSentinel.current",
      resolveContext(),
      existingOnly,
    );
    return currentSentinel(
      reply?.ok && reply.type === "restartSentinel.current" ? reply.state : undefined,
    );
  } catch (err) {
    sentinelLog.warn(`Failed to ${action} restart sentinel: ${formatErrorMessage(err)}`);
    return null;
  }
}

export function readRestartSentinel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  return readCurrentRestartSentinel(() => captureOpenClawStateWorkerContext({ env }), false);
}

/** Read the restart sentinel without creating or mutating shared state. */
export function readRestartSentinelReadOnly(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestartSentinel | null> {
  return readCurrentRestartSentinel(() => captureOpenClawStateWorkerContext({ env }), true);
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
  return (
    (await readCurrentRestartSentinel(
      () => captureOpenClawStateWorkerContext({ env }),
      false,
      "check",
    )) !== null
  );
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
