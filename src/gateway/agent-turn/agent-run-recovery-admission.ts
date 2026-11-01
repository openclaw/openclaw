import { isDeepStrictEqual } from "node:util";
import {
  commitMainSessionRecovery,
  type MainSessionRecoveryPendingTarget,
} from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { resolveRestartRecoveryChannelAuthority } from "../../config/sessions/restart-recovery-state.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { readUndispatchedChannelText } from "../../sessions/undispatched-channel-text.js";
import { readSessionMessagesAsync } from "../session-transcript-readers.js";

export async function readOriginalUndispatchedInput(params: {
  sourceTurnId: string;
  expected?: InternalSessionEntry;
  current?: InternalSessionEntry;
  sessionKey: string;
  storePath: string;
}): Promise<string> {
  const { current, expected, sourceTurnId } = params;
  const source = current && resolveRestartRecoveryChannelAuthority(current);
  if (
    !source ||
    !current ||
    !expected ||
    current.sessionId !== expected.sessionId ||
    current.lifecycleRevision !== expected.lifecycleRevision ||
    current.restartRecoveryDeliverySourceRunId !== sourceTurnId ||
    !current.restartRecoveryRequesterSenderId ||
    current.restartRecoveryRequesterSenderId !== expected.restartRecoveryRequesterSenderId ||
    current.restartRecoveryRequesterAccountId !== expected.restartRecoveryRequesterAccountId ||
    !isDeepStrictEqual(source, resolveRestartRecoveryChannelAuthority(expected))
  ) {
    throw new Error("Undispatched channel ownership changed before recovery.");
  }
  const rows = await readSessionMessagesAsync(
    {
      sessionKey: params.sessionKey,
      sessionId: current.sessionId,
      storePath: params.storePath,
      sessionEntry: current,
    },
    { mode: "recent", maxMessages: 1, maxBytes: 256 * 1024 },
  );
  const text = readUndispatchedChannelText(rows.at(-1), sourceTurnId);
  if (text === undefined) {
    throw new Error("The original undispatched channel input is unavailable.");
  }
  return text;
}

/** Bind durable recovery admission to the exact restoration needed if execution never starts. */
export async function admitAgentRestartRecovery(params: {
  lifecycleGeneration: string;
  runId: string;
  sessionId: string;
  sessionKey: string;
  storePath: string;
}) {
  const admission = await commitMainSessionRecovery({
    command: {
      kind: "admit_recovery",
      lifecycleGeneration: params.lifecycleGeneration,
      now: Date.now(),
      runId: params.runId,
      sessionId: params.sessionId,
    },
    requireWriteSuccess: true,
    target: { sessionKey: params.sessionKey, storePath: params.storePath },
  });
  if (admission.transition.kind !== "admitted_recovery") {
    throw new Error(
      `Session "${params.sessionKey}" restart recovery reservation is stale; recovery was skipped.`,
    );
  }
  const sessionKey = admission.sessionKey ?? params.sessionKey;
  const admittedAttempt = admission.transition.admission;
  let restored = false;
  const restore = async (): Promise<MainSessionRecoveryPendingTarget | undefined> => {
    if (restored) {
      return undefined;
    }
    const recovery = await commitMainSessionRecovery({
      command: {
        kind: "mark_admitted_recovery_interrupted",
        ...admittedAttempt,
        now: Date.now(),
      },
      requireWriteSuccess: true,
      target: { sessionKey, storePath: params.storePath },
    });
    restored = true;
    return (recovery.transition.kind === "applied" || recovery.transition.kind === "no_change") &&
      recovery.entry?.sessionId === params.sessionId &&
      recovery.sessionKey
      ? {
          sessionId: recovery.entry.sessionId,
          sessionKey: recovery.sessionKey,
          storePath: params.storePath,
        }
      : undefined;
  };
  const sourceTurnId = admission.transition.undispatchedSourceTurnId;
  return {
    restore,
    undispatchedSourceTurnId: sourceTurnId,
    readUndispatchedInput: (expected?: InternalSessionEntry) =>
      sourceTurnId
        ? readOriginalUndispatchedInput({
            current: admission.entry,
            expected,
            sourceTurnId,
            sessionKey,
            storePath: params.storePath,
          })
        : undefined,
  };
}
