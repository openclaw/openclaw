import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ActiveTranscriptsSession } from "./capture-types.js";
import type { TranscriptSessionDescriptor } from "./provider-types.js";

export class TranscriptStartError extends Error {
  constructor(
    readonly code: "id-conflict" | "admitted-start-failed",
    cause: unknown,
    // Only failed provider startup retains an admission that its owning service may retry.
    readonly retry?: {
      session: TranscriptSessionDescriptor;
      revision: string;
      // Only an inserted, never accepted candidate can be discarded on abandonment.
      discardOnAbandon: boolean;
    },
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
    discardOnAbandon: retry.discardOnAbandon,
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

export type TranscriptStartRetry = ReturnType<typeof retainTranscriptStartRetry>;

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

// Capture ownership and admission stay available without loading provider or summary code.
export const activeSessions = new Map<string, ActiveTranscriptsSession>();
// Reserve ids across asynchronous provider startup so overlapping starts cannot
// replace the cleanup owner of a still-starting capture.
export const startingSessions = new Map<string, ActiveTranscriptsSession>();

const capturePolicyTransitions = new Map<string, symbol>();

export function assertTranscriptCaptureEnabled(ctx: { config?: OpenClawConfig; stateDir: string }) {
  if (ctx.config?.transcripts?.enabled === false || capturePolicyTransitions.has(ctx.stateDir)) {
    throw new Error("transcripts are disabled");
  }
}

export function createStartupAbortScope(parent?: AbortSignal) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parent?.reason);
  if (parent?.aborted) {
    abortFromParent();
  } else {
    parent?.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    // Provider startup owns this scoped signal only until start settles.
    // Detaching prevents a later agent-run abort from ending live capture.
    detach: () => parent?.removeEventListener("abort", abortFromParent),
  };
}

export function prepareTranscriptCaptureDisable(stateDir: string) {
  const transition = Symbol("capture-policy");
  capturePolicyTransitions.set(stateDir, transition);
  const entries = [...new Set([...startingSessions.values(), ...activeSessions.values()])].filter(
    (entry) => entry.directCapture?.stateDir === stateDir,
  );
  for (const entry of entries) {
    entry.cleanupPending = true;
    entry.abortStartup?.();
  }
  return {
    async drain() {
      const results = await Promise.allSettled(
        entries.map(async (entry) => entry.directCapture?.drain()),
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length) {
        throw new AggregateError(failures, "Transcript capture policy drainage failed");
      }
    },
    resume: () => {
      if (capturePolicyTransitions.get(stateDir) === transition) {
        capturePolicyTransitions.delete(stateDir);
      }
    },
  };
}
