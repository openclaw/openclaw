import { makeZeroUsageSnapshot } from "../agents/usage.js";
import { readRuntimeConfig } from "../config/runtime-snapshot.js";
import { appendSessionTranscriptReport } from "../config/sessions/session-accessor.sqlite-transcript-reports.js";
import {
  captureSessionActorStorageOwner,
  readCapturedSessionActorEntry,
} from "../config/sessions/session-actor-storage-binding.js";
import { attachSessionTranscriptRunId } from "../sessions/transcript-events.js";

export type RepositoryPublicationTranscriptRuntime = {
  resolveCanonicalSessionEntryFromStoreKeys: typeof import("./session-utils-store.js").resolveCanonicalSessionEntryFromStoreKeys;
  resolveGatewaySessionStoreTargetInWorker: typeof import("./session-utils-store-worker.js").resolveGatewaySessionStoreTargetInWorker;
};
export type RepositoryPublicationTranscriptReport = {
  sessionId: string;
  sessionKey: string;
  agentId: string;
  requestId: string;
  lifecycleRevision?: string | null;
  runId?: string;
  text: string;
  responseId: string;
};

/** Accepted receipt custody supplies this operation; vendor code formats text and never selects transcript storage. */
export async function reportRepositoryPublicationTranscript(
  loadSessionRuntime: () => Promise<RepositoryPublicationTranscriptRuntime>,
  markReported: (requestId: string) => Promise<void>,
  params: RepositoryPublicationTranscriptReport,
): Promise<void> {
  const memory = captureSessionActorStorageOwner(params, { assertCurrent() {}, authorize() {} });
  const selected = memory
    ? {
        target: {
          agentId: memory.agentId,
          canonicalKey: params.sessionKey,
          storePath: memory.path,
        },
        entry: readCapturedSessionActorEntry(memory, params.sessionKey),
      }
    : await (async () => {
        const runtime = await loadSessionRuntime();
        const target = await runtime.resolveGatewaySessionStoreTargetInWorker({
          cfg: readRuntimeConfig(),
          key: params.sessionKey,
          agentId: params.agentId,
        });
        return {
          target,
          entry: runtime.resolveCanonicalSessionEntryFromStoreKeys(target.store, target.storeKeys),
        };
      })();
  const { target, entry } = selected;
  // A reset or rotation ended that transcript for good; the receipt stays readable by request id.
  if (
    entry &&
    target.canonicalKey === params.sessionKey &&
    (entry.sessionId !== params.sessionId ||
      (params.lifecycleRevision !== undefined &&
        (entry.lifecycleRevision ?? null) !== params.lifecycleRevision))
  ) {
    await markReported(params.requestId);
    return;
  }
  if (entry?.sessionId !== params.sessionId || target.canonicalKey !== params.sessionKey) {
    throw new Error("Publication transcript owner changed");
  }
  const appended = await appendSessionTranscriptReport(
    {
      agentId: target.agentId,
      sessionId: params.sessionId,
      sessionKey: target.canonicalKey,
      storePath: target.storePath,
      expectedLifecycleRevision: params.lifecycleRevision ?? undefined,
    },
    {
      kind: "assistant",
      message: attachSessionTranscriptRunId(
        {
          role: "assistant",
          content: [{ type: "text", text: params.text }],
          api: "openai-responses",
          provider: "openclaw",
          model: "gateway-publication",
          responseId: params.responseId,
          usage: makeZeroUsageSnapshot(),
          stopReason: "stop",
          timestamp: Date.now(),
        },
        params.runId,
      ),
    },
  );
  if (!appended.ok) {
    throw new Error("Publication transcript owner changed", { cause: appended.error });
  }
  await markReported(params.requestId);
}
