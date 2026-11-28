import { isDeepStrictEqual } from "node:util";
import { sha256Base64Url } from "../../infra/crypto-digest.js";
import {
  applySessionEntryOperation,
  patchSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import { readSessionEntryReadOnlyInWorker } from "./session-entry-read-runtime.js";
import { captureSessionEntrySourceAssertion } from "./session-entry-source-authority.js";
import {
  isRestartResumeEntryOutOfScope,
  restartResumeMarkerMatchesRun,
  selectPendingRestartShellCalls,
  type PendingSessionShellCalls,
} from "./session-restart-resume-scope.js";
import type { InternalSessionEntry } from "./types.js";
type Target = { agentId: string; sessionKey: string; storePath: string; env?: NodeJS.ProcessEnv };
type Marker = NonNullable<InternalSessionEntry["resumeAfterRestart"]>;

/** Check whether restart recovery has custody of the interrupted reply. */
export async function hasSessionRestartResume(
  target: Target & { sessionId: string },
  runId: string | undefined,
): Promise<boolean> {
  const entry = await readSessionEntryReadOnlyInWorker({
    agentId: target.agentId,
    sessionKey: target.sessionKey,
    storePath: target.storePath,
    readConsistency: "latest",
    hydrateSkillPromptRefs: false,
  });
  const marker = entry?.resumeAfterRestart;
  return (
    entry?.sessionId === target.sessionId &&
    marker !== undefined &&
    !isRestartResumeEntryOutOfScope(entry) &&
    restartResumeMarkerMatchesRun(marker, runId)
  );
}

export async function acknowledgeRestartResumeMarker(
  target: Target,
  entry: InternalSessionEntry,
  marker: Marker,
  assertCurrent: () => void,
) {
  // A second shutdown can replace custody without rotating the chat or changing the original run.
  await patchSessionEntryCore(
    target,
    (current) =>
      current.sessionId === entry.sessionId &&
      current.lifecycleRevision === entry.lifecycleRevision &&
      isDeepStrictEqual(current.resumeAfterRestart, marker)
        ? { resumeAfterRestart: undefined }
        : null,
    { requireWriteSuccess: true, skipMaintenance: true, assertCommitAllowed: assertCurrent },
  );
}

type InterruptedShellTarget = {
  target: Target;
  entry: InternalSessionEntry;
  marker: Marker;
  assertCurrent: () => void;
};

/** The writer checks accepted terminal results before the Gateway continues the turn. */
export async function reconcileInterruptedShellCalls({
  target,
  entry,
  marker,
  assertCurrent,
}: InterruptedShellTarget) {
  const selected = selectPendingRestartShellCalls(entry, marker);
  if (!selected) {
    return undefined;
  }
  const checked = await applySessionEntryOperation(
    target,
    {
      kind: "shell-call",
      runId: selected.runId,
      expected: { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision },
    },
    {
      skipMaintenance: true,
      preserveActivity: true,
      requireWriteSuccess: true,
      assertCommitAllowed: assertCurrent,
    },
  );
  if (
    !checked ||
    checked.sessionId !== entry.sessionId ||
    checked.lifecycleRevision !== entry.lifecycleRevision ||
    !isDeepStrictEqual(checked.resumeAfterRestart, marker)
  ) {
    throw new Error("Session changed while checking interrupted shell results");
  }
  return checked;
}

export function resolveInterruptedShellNoticeRoute(
  pending: PendingSessionShellCalls,
  marker: Marker,
) {
  const route = pending.notice;
  return route &&
    (!marker.operatorSource || isDeepStrictEqual(route.operatorSource, marker.operatorSource))
    ? route
    : undefined;
}

export async function recordInterruptedShellNotice(
  params: InterruptedShellTarget & {
    text: string;
    deliver?: (
      route: NonNullable<PendingSessionShellCalls["notice"]>,
      idempotencyKey: string,
      check: () => void,
    ) => Promise<void>;
  },
): Promise<boolean> {
  const { target, entry, marker, assertCurrent } = params;
  const checked = await reconcileInterruptedShellCalls(params);
  if (!checked?.pendingShellCalls?.calls.length) {
    return false;
  }
  const pending = checked.pendingShellCalls;
  const { runId } = pending;
  const expected = { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision };
  const scope = sha256Base64Url(
    JSON.stringify([target.agentId, target.sessionKey, entry.sessionId, runId]),
  );
  const idempotencyKey = `main-session-restart-recovery:shell-uncertain:${scope}`;
  const prepared = await captureSessionEntrySourceAssertion({
    scope: target,
    expected: checked,
    fields: ["sessionId", "lifecycleRevision", "resumeAfterRestart", "pendingShellCalls"],
    assertCurrent,
    assertHostCurrent: assertCurrent,
    refuse: () => {
      throw new Error("The interrupted turn no longer owns this notice");
    },
  }).prepareSessionSource();
  try {
    const check = () => {
      assertCurrent();
      prepared.assertCurrent();
    };
    check();
    const { appendAssistantMessageToSessionTranscript } = await import("./transcript.js");
    const saved = await appendAssistantMessageToSessionTranscript({
      ...target,
      expectedSessionId: entry.sessionId,
      expectedLifecycleRevision: entry.lifecycleRevision ?? null,
      text: params.text,
      idempotencyKey,
      assertCurrent: check,
    });
    if (!saved.ok) {
      throw new Error(saved.reason);
    }
    const route = resolveInterruptedShellNoticeRoute(pending, marker);
    if (route) {
      await params.deliver?.(route, idempotencyKey, check);
    }
    check();
    // Revalidate the exact pending set and marker in the acknowledgement transaction.
    const acknowledged = await applySessionEntryOperation(
      target,
      { kind: "shell-call", runId, expected, acknowledged: { marker, pending } },
      {
        skipMaintenance: true,
        preserveActivity: true,
        requireWriteSuccess: true,
        assertCommitAllowed: assertCurrent,
      },
    );
    if (
      !acknowledged ||
      acknowledged.sessionId !== expected.sessionId ||
      acknowledged.lifecycleRevision !== expected.lifecycleRevision ||
      acknowledged.resumeAfterRestart ||
      acknowledged.pendingShellCalls
    ) {
      throw new Error("The interrupted turn no longer owns its acknowledgement");
    }
    return true;
  } finally {
    await prepared.release?.();
  }
}
