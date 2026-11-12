import { extractDeliveryInfo } from "../config/sessions/delivery-info.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { SessionDeliveryGeneration } from "../config/sessions/session-delivery-generation.types.js";
import { withSessionEntriesFromStoresInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildOutboundSessionContext } from "../infra/outbound/session-context.js";
import { resolveSystemEventQueueKey } from "../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import type { MessagePresentation } from "../interactive/payload.js";
import type { PluginNotice } from "../shared/plugin-notice.js";
import { PLUGIN_NOTICE_KIND } from "../shared/transcript-only-openclaw-assistant.js";
import { isDeliverableMessageChannel, normalizeMessageChannel } from "../utils/message-channel.js";

/** The exact session incarnation a background producer observed; a reset or replacement ends it. */
export type SessionGeneration = SessionDeliveryGeneration;

// A completed send stays on record, so a retry with the same key finishes the transcript
// without sending again.
const SESSION_NOTICE_COMPLETION_RETENTION = {
  idPrefix: "plugin-notice:",
  maxAgeMs: 24 * 60 * 60_000,
  maxEntries: 2_000,
} as const;

export type SessionNotice = {
  /** Notice type within the posting plugin; clients that know it may render `data` natively. */
  type: string;
  /** Plain text every client and channel shows. */
  text: string;
  data: Record<string, unknown>;
  /** Buttons or other blocks for channels that render them; plain-text channels get the text. */
  presentation?: MessagePresentation;
};

export type PostSessionNoticeParams = {
  generation: SessionGeneration;
  notice: SessionNotice;
  /** Stable per notice; makes the channel send and the transcript row safe to retry. */
  idempotencyKey: string;
  /** Context the next foreground turn receives, queued only while the generation is current. */
  systemEvent?: string;
  /** Also send to the session's channel when it is deliverable. Omitted: transcript only. */
  deliver?: { skipChannels?: readonly string[] };
};

export type PostSessionNoticeResult =
  | { status: "posted"; delivered: boolean }
  | { status: "skipped"; reason: "session-changed" }
  | { status: "failed"; stage: "delivery" | "transcript"; error: string };

/** Reads the current generation of a session, or undefined when it has no active session. */
export async function captureSessionGeneration(params: {
  config: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  storePath?: string;
}): Promise<SessionGeneration | undefined> {
  const { agentId, sessionKey } = params;
  const storePath =
    params.storePath ?? resolveSessionStorePathCore(params.config.session?.store, { agentId });
  return await readCurrentEntry({ agentId, storePath, sessionKey }, (entry) =>
    entry?.sessionId
      ? {
          agentId,
          storePath,
          sessionKey,
          sessionId: entry.sessionId,
          lifecycleRevision: entry.lifecycleRevision ?? null,
        }
      : undefined,
  );
}

async function readCurrentEntry<T>(
  target: Pick<SessionGeneration, "agentId" | "storePath" | "sessionKey">,
  consume: (entry: { sessionId?: string; lifecycleRevision?: string } | undefined) => T,
): Promise<T> {
  return await withSessionEntriesFromStoresInWorker(
    [
      {
        agentId: target.agentId,
        storePath: target.storePath,
        sessionKeys: [target.sessionKey],
        projection: "exact",
        snapshotFields: [],
      },
    ],
    ([read]) =>
      consume(read?.result.entries.find((row) => row.sessionKey === target.sessionKey)?.entry),
    { ordered: true },
  );
}

/**
 * Posts a plugin's background notice to the session generation it observed: one transcript-only
 * row carrying the plugin notice marker, an optional system event for the next turn, and an
 * optional durable send to the session's channel. Outbound delivery does not record the notice
 * again because the transcript row already belongs to this session. A session reset or replaced
 * since `generation` gets none of it.
 */
export async function postSessionNotice(
  params: PostSessionNoticeParams & {
    config: OpenClawConfig;
    pluginId: string;
    /**
     * Present when a loaded plugin posts through its runtime. `assertCurrent` is the host-owned
     * live check of that plugin; it runs before each effect and its failure is thrown. A queued
     * channel send also names the plugin so restart recovery replays it only while it is loaded.
     */
    pluginOwner?: { assertCurrent?: () => void };
  },
): Promise<PostSessionNoticeResult> {
  const { config, generation, notice, idempotencyKey } = params;
  // Keep the first authority failure so it is thrown, never reported as a delivery failure.
  let revoked: { error: unknown } | undefined;
  const assertCurrent = () => {
    try {
      params.pluginOwner?.assertCurrent?.();
    } catch (error) {
      revoked ??= { error };
      throw error;
    }
  };
  const rethrowRevocation = () => {
    if (revoked) {
      throw revoked.error;
    }
  };
  const { agentId, sessionKey } = generation;
  const route = params.deliver ? await extractDeliveryInfo(sessionKey, { cfg: config }) : undefined;
  const current = await readCurrentEntry(generation, (entry) => {
    if (
      entry?.sessionId !== generation.sessionId ||
      (entry.lifecycleRevision ?? null) !== generation.lifecycleRevision
    ) {
      return false;
    }
    assertCurrent();
    // Queued in the same read that proved the generation and the owner, before any awaited work.
    if (params.systemEvent) {
      enqueueSystemEvent(params.systemEvent, {
        sessionKey: resolveSystemEventQueueKey(sessionKey, agentId),
      });
    }
    return true;
  });
  if (!current) {
    return { status: "skipped", reason: "session-changed" };
  }
  const target = route?.deliveryContext;
  const channel = target?.channel ? normalizeMessageChannel(target.channel) : undefined;
  const delivery =
    channel &&
    target?.to &&
    isDeliverableMessageChannel(channel) &&
    !params.deliver?.skipChannels?.includes(channel)
      ? {
          channel,
          to: target.to,
          accountId: target.accountId,
          // The session key's thread is canonical; stored context may name a stale thread.
          threadId: route?.threadId ?? target.threadId,
        }
      : undefined;
  if (delivery) {
    assertCurrent();
    try {
      // Delivery and transcript runtimes stay lazy: most background producers post nothing.
      const { sendDurableMessageBatchCore } = await import("../channels/message/runtime.js");
      const send = await sendDurableMessageBatchCore(
        {
          cfg: config,
          ...delivery,
          payloads: [
            notice.presentation
              ? { text: notice.text, presentation: notice.presentation }
              : { text: notice.text },
          ],
          session: buildOutboundSessionContext({ cfg: config, sessionKey, agentId }),
          deliveryIntentId: `${SESSION_NOTICE_COMPLETION_RETENTION.idPrefix}${params.pluginId}:${idempotencyKey}`,
          reusePendingDeliveryIntent: true,
          completionRetention: SESSION_NOTICE_COMPLETION_RETENTION,
          ...(params.pluginOwner
            ? { deliveryCompletion: { kind: "plugin-notice" as const, pluginId: params.pluginId } }
            : {}),
          bestEffort: true,
          // Rechecked by delivery right before provider I/O.
          assertDirectAdapterHandoff: assertCurrent,
        },
        undefined,
        undefined,
        generation,
      );
      if (send.status === "failed" || send.status === "partial_failed") {
        throw send.error;
      }
    } catch (error) {
      rethrowRevocation();
      return { status: "failed", stage: "delivery", error: String(error) };
    }
  }
  const marker: PluginNotice = {
    kind: PLUGIN_NOTICE_KIND,
    pluginId: params.pluginId,
    type: notice.type,
    data: notice.data,
  };
  assertCurrent();
  try {
    const { appendAssistantMessageToSessionTranscript } =
      await import("../config/sessions/transcript.runtime.js");
    const appended = await appendAssistantMessageToSessionTranscript({
      agentId,
      sessionKey,
      storePath: generation.storePath,
      expectedSessionId: generation.sessionId,
      expectedLifecycleRevision: generation.lifecycleRevision,
      text: notice.text,
      idempotencyKey,
      deliveryMirror: marker,
      config,
      // Rechecked by the transcript writer after its awaited reads and before the commit.
      assertCurrent,
    });
    rethrowRevocation();
    if (!appended.ok) {
      return { status: "failed", stage: "transcript", error: appended.reason };
    }
  } catch (error) {
    rethrowRevocation();
    return { status: "failed", stage: "transcript", error: String(error) };
  }
  return { status: "posted", delivered: Boolean(delivery) };
}
