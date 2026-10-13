import path from "node:path";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { captureSessionActorTranscriptRead } from "./session-actor-transcript-read.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";

export function readSessionTranscriptWatermarkAsync(scope: SessionTranscriptReadScope) {
  const memory = captureSessionActorTranscriptRead(scope);
  if (memory) {
    if (memory.missing) {
      memory.assertCurrent();
      return Promise.resolve({ generation: null, maxSeq: null });
    }
    return memory.read("session.history.watermark", {}).then((result) => result.watermark);
  }
  return withSessionTranscriptReadSource(
    scope,
    ({ scope: captured, owner, preparedReads, expectedIdentity }) =>
      (preparedReads ?? owner).readWatermark({ scope: captured, expectedIdentity }),
  );
}

/** Prepared boundary evidence only; final delivery retains its current writer and turn guards. */
export async function readSessionTranscriptStartAsync(
  scope: SessionTranscriptRuntimeTarget & { env?: NodeJS.ProcessEnv },
) {
  const target = {
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    sessionKey: scope.sessionKey,
    storePath: path.resolve(scope.storePath),
  };
  const watermark = await readSessionTranscriptWatermarkAsync({ ...target, env: scope.env });
  return { ...target, ...watermark };
}
