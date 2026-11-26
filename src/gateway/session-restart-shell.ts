import { isDeepStrictEqual } from "node:util";
import { applySessionEntryOperation } from "../config/sessions/session-accessor.sqlite-entry.js";
import { captureSessionEntrySourceAssertion } from "../config/sessions/session-entry-source-authority.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import { getGatewayLifecycleRuntime } from "./server-lifecycle-runtime-context.js";

const notice =
  "The Gateway restarted before it could verify the result of a shell command. Its effect is unknown. I paused this turn without retrying the command. Check its outcome before sending a new request.";

export async function pauseInterruptedShellTurn(params: {
  target: { agentId: string; sessionKey: string; storePath: string; env?: NodeJS.ProcessEnv };
  entry: InternalSessionEntry;
  marker: NonNullable<InternalSessionEntry["resumeAfterRestart"]>;
  assertCurrent: () => void;
  transcriptOnly?: boolean;
}): Promise<boolean> {
  const { target, entry, marker, assertCurrent } = params;
  const runId = marker.sourceRunId;
  if (!runId || entry.pendingShellCalls?.runId !== runId) {
    return false;
  }
  const expected = { sessionId: entry.sessionId, lifecycleRevision: entry.lifecycleRevision };
  const options = {
    skipMaintenance: true,
    preserveActivity: true,
    requireWriteSuccess: true,
    assertCommitAllowed: assertCurrent,
  };
  // The writer compares pending calls with accepted terminal results in one transaction.
  const checked = await applySessionEntryOperation(
    target,
    { kind: "shell-call", runId, expected },
    options,
  );
  if (
    !checked ||
    checked.sessionId !== entry.sessionId ||
    checked.lifecycleRevision !== entry.lifecycleRevision ||
    !isDeepStrictEqual(checked.resumeAfterRestart, marker)
  ) {
    throw new Error("Session changed while checking interrupted shell results");
  }
  if (!checked.pendingShellCalls?.calls.length) {
    return false;
  }
  const scope = sha256Base64Url(
    JSON.stringify([target.agentId, target.sessionKey, entry.sessionId, runId]),
  );
  const idempotencyKey = `main-session-restart-recovery:shell-uncertain:${scope}`;
  const prepared = await captureSessionEntrySourceAssertion({
    scope: target,
    expected: checked,
    fields: ["sessionId", "lifecycleRevision", "resumeAfterRestart"],
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
    const saved = await appendAssistantMessageToSessionTranscript({
      ...target,
      expectedSessionId: entry.sessionId,
      expectedLifecycleRevision: entry.lifecycleRevision ?? null,
      text: notice,
      idempotencyKey,
      assertCurrent: check,
    });
    if (!saved.ok) {
      throw new Error(saved.reason);
    }
    const route = checked.pendingShellCalls.notice;
    if (
      !params.transcriptOnly &&
      route &&
      (!marker.operatorSource || isDeepStrictEqual(route.operatorSource, marker.operatorSource))
    ) {
      const runtime = getGatewayLifecycleRuntime();
      if (!runtime) {
        throw new Error("The original channel notice is awaiting its Gateway delivery owner");
      }
      // The admitted input owns this route. A new session destination cannot receive the notice.
      const { channel, to, accountId, threadId, replyToId } = route;
      const sent = await runtime.sendNotice({
        channel,
        to,
        accountId,
        threadId,
        replyToId,
        text: notice,
        idempotencyKey,
        isCurrent: () => {
          check();
          return true;
        },
      });
      if (sent.suppressed) {
        const { findDeliveryIntentOwner } =
          await import("../infra/outbound/delivery-queue-storage.js");
        if ((await findDeliveryIntentOwner(idempotencyKey))?.status !== "completed") {
          throw new Error("The original channel has not acknowledged the interrupted shell notice");
        }
      }
    }
    check();
  } finally {
    await prepared.release?.();
  }
  await applySessionEntryOperation(
    target,
    { kind: "shell-call", runId, expected, acknowledged: marker },
    options,
  );
  return true;
}
