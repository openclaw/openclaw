import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { TurnRecoveryIntent } from "../config/sessions/main-session-recovery.types.js";
import { readSessionPendingInputStage } from "../config/sessions/session-accessor.pending-inputs.js";
import {
  parseSessionPendingInputMessage,
  readPendingInputRecoveryIntent,
} from "../config/sessions/session-accessor.sqlite-pending-inputs.js";
import { buildRestartRecoveryExpectedState } from "../config/sessions/session-transcript-turn-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createUserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.js";
import { GatewayOperatorAccessDeniedError } from "./operator-access-policy.js";

/** The existing recorder consumes original accepted bytes under the restored issuer's live guard. */
export async function prepareRestoredAcceptedInput(params: {
  inputIntent: TurnRecoveryIntent;
  target: { agentId: string; canonicalKey: string; storePath: string };
  getConfig: () => OpenClawConfig;
  assertCurrent: () => void;
  assertGoalCurrent: () => Promise<string | undefined>;
}): Promise<string | undefined> {
  const deny = (): never => {
    throw new GatewayOperatorAccessDeniedError();
  };
  params.assertCurrent();
  await params.assertGoalCurrent();
  const snapshot = await readSessionPendingInputStage(
    {
      agentId: params.target.agentId,
      sessionKey: params.target.canonicalKey,
      storePath: params.target.storePath,
      sessionId: params.inputIntent.sessionId,
    },
    params.inputIntent.idempotencyKey,
    params.assertCurrent,
  );
  params.assertCurrent();
  if (!snapshot.current) {
    deny();
  }
  const input = snapshot.existing;
  const entry = snapshot.entry;
  const capturedInput = input && readPendingInputRecoveryIntent(input);
  if (
    input?.recovery_intent_json != null &&
    (!capturedInput || !isDeepStrictEqual(capturedInput.intent, params.inputIntent))
  ) {
    deny();
  }
  if (!input && snapshot.committed?.messageId === params.inputIntent.inputId) {
    const message = snapshot.committed.message;
    return isRecord(message) && message.role === "user" && typeof message.content === "string"
      ? message.content
      : undefined;
  }
  if (
    !entry ||
    !input ||
    input.input_id !== params.inputIntent.inputId ||
    input.run_id !== params.inputIntent.runId ||
    input.session_id !== params.inputIntent.sessionId ||
    entry.sessionId !== params.inputIntent.sessionId ||
    entry.lifecycleRevision !== params.inputIntent.lifecycleRevision ||
    !isDeepStrictEqual(entry.mainRestartRecovery?.turnIntent, params.inputIntent) ||
    input.state === "cancelled"
  ) {
    throw new GatewayOperatorAccessDeniedError();
  }
  if (input.consumed_event_id !== null) {
    const message = parseSessionPendingInputMessage(input.message_json);
    return typeof message.content === "string" ? message.content : undefined;
  }
  const recorder = createUserTurnTranscriptRecorder({
    message: parseSessionPendingInputMessage(input.message_json),
    pendingInputRequestFingerprint: input.request_hash.startsWith("request:")
      ? input.request_hash.slice("request:".length)
      : undefined,
    target: {
      agentId: params.target.agentId,
      sessionKey: params.target.canonicalKey,
      sessionId: params.inputIntent.sessionId,
      expectedSessionId: params.inputIntent.sessionId,
      storePath: params.target.storePath,
      sessionEntry: entry,
      config: params.getConfig(),
    },
    expectedSessionState: buildRestartRecoveryExpectedState(entry),
    assertOriginalInputCommit: params.assertCurrent,
  });
  try {
    const staged = await recorder.stageApproved!({
      runId: params.inputIntent.runId,
      assertCurrent: params.assertCurrent,
      assertAdmittedCurrent: params.assertCurrent,
      turnIssuerAdmission: {
        assertCurrent: params.assertCurrent,
        capture: (currentEntry, accepted) => {
          params.assertCurrent();
          if (
            currentEntry.sessionId !== params.inputIntent.sessionId ||
            currentEntry.lifecycleRevision !== params.inputIntent.lifecycleRevision ||
            currentEntry.repositoryWorkspaceId !== params.inputIntent.repositoryWorkspaceId ||
            accepted.inputId !== params.inputIntent.inputId ||
            accepted.idempotencyKey !== params.inputIntent.idempotencyKey
          ) {
            throw new GatewayOperatorAccessDeniedError();
          }
          return params.inputIntent;
        },
      },
    });
    params.assertCurrent();
    await params.assertGoalCurrent();
    if (!staged || !(await recorder.persistApproved())) {
      throw new GatewayOperatorAccessDeniedError();
    }
    params.assertCurrent();
    await params.assertGoalCurrent();
    const message = parseSessionPendingInputMessage(input.message_json);
    return typeof message.content === "string" ? message.content : undefined;
  } finally {
    recorder.finishPendingInput?.("interrupted");
    await recorder.waitForPendingInputSettlement?.();
  }
}
