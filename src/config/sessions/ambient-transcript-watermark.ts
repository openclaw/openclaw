import { applySessionEntryOperation } from "./session-accessor.sqlite-entry.js";
import type { SessionEntry } from "./types.js";
export { readAmbientTranscriptWatermarkFromEntry } from "./ambient-transcript-watermark-projection.js";

export type AmbientTranscriptWatermarkScope = {
  channel: string;
  accountId?: string;
  conversationId: string;
  threadId?: string | number;
};

export function resolveAmbientTranscriptWatermarkKey(
  scope: AmbientTranscriptWatermarkScope,
): string {
  return JSON.stringify([
    scope.channel,
    scope.accountId ?? "",
    scope.conversationId,
    scope.threadId === undefined ? "" : String(scope.threadId),
  ]);
}

export async function updateAmbientTranscriptWatermark(params: {
  storePath: string;
  sessionKey: string;
  key: string;
  messageId: string;
  timestampMs?: number;
  expectedSessionId?: string;
}): Promise<SessionEntry | null> {
  return await applySessionEntryOperation(
    { storePath: params.storePath, sessionKey: params.sessionKey },
    { kind: "ambient-transcript-watermark", watermark: { ...params, now: Date.now() } },
    { skipMaintenance: true, takeCacheOwnership: true },
  );
}
