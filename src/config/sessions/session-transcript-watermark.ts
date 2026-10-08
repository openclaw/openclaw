import path from "node:path";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { readSessionTranscriptWatermark } from "./session-accessor.sqlite-transcript-watermark.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { captureIncognitoSessionHistoryBinding } from "./session-incognito-binding.js";
import {
  readIncognitoSessionHistory,
  type IncognitoSessionHistoryBinding,
} from "./session-incognito-history-read.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";

export function readSessionTranscriptWatermarkAsync(
  scope: SessionTranscriptReadScope,
  suppliedIncognito?: IncognitoSessionHistoryBinding,
) {
  const incognito = suppliedIncognito ?? captureIncognitoSessionHistoryBinding(scope);
  if (incognito) {
    return readIncognitoSessionHistory(incognito, scope, (target) => ({
      type: "session.history.watermark",
      input: target,
    })).then((result) => result.watermark);
  }
  return withSessionTranscriptReadSource(
    scope,
    readSessionTranscriptWatermark,
    ({ scope: captured, owner, preparedReads, expectedIdentity }) =>
      (preparedReads ?? owner).readWatermark({ scope: captured, expectedIdentity }),
  );
}

/** Prepared boundary evidence only; final delivery retains its current writer and turn guards. */
export async function readSessionTranscriptStartAsync(
  scope: SessionTranscriptRuntimeTarget & { env?: NodeJS.ProcessEnv },
  incognito?: IncognitoSessionHistoryBinding,
) {
  const target = {
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    storePath: path.resolve(scope.storePath),
  };
  const watermark = await readSessionTranscriptWatermarkAsync(
    { ...target, env: scope.env },
    incognito,
  );
  return { ...target, ...watermark };
}
