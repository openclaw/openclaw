import type { TranscriptSessionDescriptor } from "./provider-types.js";

export class TranscriptStartError extends Error {
  constructor(
    readonly code: "id-conflict" | "admitted-start-failed",
    cause: unknown,
    // Only failed provider startup retains an admission that its owning service may retry.
    readonly retry?: { session: TranscriptSessionDescriptor; revision: string },
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TranscriptStartError";
  }
}

const pendingStartRetries = new Set<{
  stateDir: string;
  session: TranscriptSessionDescriptor;
}>();

export function retainTranscriptStartRetry(
  stateDir: string,
  retry: NonNullable<TranscriptStartError["retry"]>,
) {
  const owner = { stateDir, session: retry.session };
  pendingStartRetries.add(owner);
  return {
    session: retry.session,
    revision: retry.revision,
    assertCurrent: () => {
      if (!pendingStartRetries.has(owner)) {
        throw new TranscriptStartError(
          "id-conflict",
          new Error("transcript changed or stopped before startup retry"),
        );
      }
    },
    release: () => pendingStartRetries.delete(owner),
  };
}

export function revokeTranscriptStartRetries(
  stateDir: string,
  session: TranscriptSessionDescriptor,
) {
  // Repeated historical stop preserves stoppedAt and summary inputs. Revoke
  // pending process authority explicitly instead of rewriting that history.
  for (const owner of pendingStartRetries) {
    if (
      owner.stateDir === stateDir &&
      owner.session.sessionId === session.sessionId &&
      owner.session.startedAt === session.startedAt
    ) {
      pendingStartRetries.delete(owner);
    }
  }
}
