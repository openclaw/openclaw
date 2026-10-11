import { resolveSessionLifecycleTimestampsWithHeader } from "./lifecycle-timestamps.js";
import type { SessionLifecycleTimestamps } from "./lifecycle.types.js";
import { readSessionTranscriptAnchorsAsync } from "./session-transcript-anchor-read.js";
import { SessionTranscriptReadFenceError } from "./session-transcript-read-fence.js";

/** Recover missing lifecycle metadata while the transcript reader retains its original owner. */
export async function resolveSessionLifecycleTimestampsAsync(
  params: Omit<Parameters<typeof resolveSessionLifecycleTimestampsWithHeader>[0], "readHeader"> & {
    sessionKey: string;
    signal?: AbortSignal;
  },
): Promise<SessionLifecycleTimestamps> {
  params.signal?.throwIfAborted();
  const entry = params.entry && { ...params.entry };
  const timestamps = resolveSessionLifecycleTimestampsWithHeader({
    ...params,
    entry,
    readHeader: () => undefined,
  });
  const sessionId = entry?.sessionId?.trim();
  if (!sessionId || timestamps.sessionStartedAt !== undefined) {
    return timestamps;
  }
  let accepted: SessionLifecycleTimestamps | undefined;
  await readSessionTranscriptAnchorsAsync(
    { ...params, sessionId },
    { entryIds: [], includeHeader: true },
    params.signal,
    ({ header }) => {
      accepted = resolveSessionLifecycleTimestampsWithHeader({
        ...params,
        entry,
        readHeader: () => header,
      });
    },
  );
  if (!accepted) {
    throw new SessionTranscriptReadFenceError("Session transcript changed during lifecycle read");
  }
  return accepted;
}
