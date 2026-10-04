import path from "node:path";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { readSessionTranscriptWatermark } from "./session-accessor.sqlite-transcript-watermark.js";
import type { SessionTranscriptRuntimeTarget } from "./session-accessor.types.js";
import { withSessionTranscriptReadSource } from "./session-transcript-read-source.js";

export function readSessionTranscriptWatermarkAsync(scope: SessionTranscriptReadScope) {
  return withSessionTranscriptReadSource(
    scope,
    readSessionTranscriptWatermark,
    ({ scope: captured, owner, expectedIdentity }) =>
      owner.readWatermark({ scope: captured, expectedIdentity }),
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
