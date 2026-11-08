import type { SessionColdArchive } from "./session-accessor.sqlite-archive-types.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import type { ResolvedTranscriptReadScope } from "./session-accessor.sqlite-scope.js";
import type { SessionSourceValidation } from "./session-source-authority.js";
import { SessionTranscriptColdError } from "./session-transcript-cold-error.js";

/** History callers retain their prepared physical target and read owner through restoration. */
export type SessionColdReadPreparation = {
  target: ResolvedTranscriptReadScope;
  acceptSourceValidation?: (validation: SessionSourceValidation) => void;
  readMetadata: (
    phase: "initial" | "queued",
  ) => Promise<Omit<SessionColdArchive, "archive_blob"> | undefined>;
};

/** Keep metadata and restored reads on the caller's already-retained history owner. */
export function readRestoredSessionTranscriptInWorker<T>(
  source: {
    scope: SessionTranscriptReadScope;
    resolved: ResolvedTranscriptReadScope;
    owner: {
      readColdMetadata(input: { sessionId: string; env: NodeJS.ProcessEnv }): Promise<{
        archive: Omit<SessionColdArchive, "archive_blob"> | undefined;
      }>;
    };
    assertCurrent: () => void;
  },
  read: () => T | Promise<T>,
): Promise<T> {
  return readRestoredSessionTranscript(source.scope, read, {
    assertCurrent: source.assertCurrent,
    coldRead: {
      target: source.resolved,
      readMetadata: async () => {
        const metadata = await source.owner.readColdMetadata({
          sessionId: source.resolved.sessionId,
          env: source.scope.env ?? {},
        });
        source.assertCurrent();
        return metadata.archive;
      },
    },
  });
}

/** Restore a cold transcript once; the owner keeps restored history hot for subsequent reads. */
export async function readRestoredSessionTranscript<T>(
  scope: SessionTranscriptReadScope,
  read: () => T | Promise<T>,
  options?: {
    readOnly?: boolean;
    assertCurrent?: () => void;
    coldRead?: SessionColdReadPreparation;
  },
): Promise<T> {
  options?.assertCurrent?.();
  // Read workers report cold storage to their host; only the host restores it.
  if (options?.readOnly) {
    return read();
  }
  try {
    return await read();
  } catch (error) {
    if (!(error instanceof SessionTranscriptColdError) || error.sessionId !== scope.sessionId) {
      throw error;
    }
    const { restoreSessionColdTranscript } = await import("./session-cold-storage.js");
    await restoreSessionColdTranscript(scope, options?.assertCurrent, options?.coldRead);
  }
  options?.assertCurrent?.();
  return read();
}
