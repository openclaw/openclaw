import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveUserTimezone } from "../../agents/date-time.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionStorePathCore,
} from "../../config/sessions.js";
import { loadTranscriptEvents } from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import { withCurrentSessionRecipientAuthority } from "../../config/sessions/session-recipient-authority-current.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { buildChannelSummary } from "../../infra/channel-summary.js";
import { emitContinuationQueueDrainSpan } from "../../infra/continuation-tracer.js";
import {
  formatUtcTimestamp,
  formatZonedTimestamp,
  resolveTimezone,
} from "../../infra/format-time/format-datetime.ts";
import { ackSessionDelivery } from "../../infra/session-delivery-queue-storage.js";
import {
  claimSystemEventDeliveryAdoption,
  createDeliveryAdoptionTurnHold,
  releaseSystemEventDeliveryAdoption,
} from "../../infra/system-event-delivery-claims.js";
import {
  isSystemEventStoreCurrent,
  resolveSystemEventQueueKey,
} from "../../infra/system-event-ownership.js";
import {
  adoptSelectedSystemEventEntries,
  isSystemEventTurnOwned,
  peekDeliverableSystemEventEntries,
  restoreConsumedSystemEventEntries,
  type SystemEvent,
} from "../../infra/system-events.js";
import { defaultRuntime } from "../../runtime.js";
import { SESSION_CREATED_NOTICE_CONTEXT_PREFIX } from "../../sessions/session-state-event-kinds.js";
import { acknowledgeSessionStateNotices } from "../../sessions/session-state-events.js";
import { decodeSessionStateNoticeContextKey } from "../../sessions/session-state-notices.js";
import { captureContinuationQueueContext } from "../continuation/queue-context.js";
import {
  createPreparedSystemEventAuthorityOwner,
  readAdoptedSystemEventDeliveryIds,
  readPreparedSystemEventAuthorityKey,
  resolveFinalSystemEventAdoption,
  settleStaleSystemEventAuthority,
  type PreparedFormattedSystemEvents,
  type PreparedManagedSystemEventDelivery,
  type PreparedSystemEventBlock,
} from "./session-system-event-adoption.js";

function compactSystemEvent(event: SystemEvent): string | null {
  const trimmed = event.text.trim();
  if (!trimmed) {
    return null;
  }
  // Creation metadata may mention heartbeat work; it is not a retired wake prompt.
  if (event.contextKey?.startsWith(SESSION_CREATED_NOTICE_CONTEXT_PREFIX)) {
    return trimmed;
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  // Keep retired heartbeat prompts out of replayed legacy system events.
  if (
    lower.includes("reason periodic") ||
    lower.startsWith("read heartbeat.md") ||
    /^heartbeat (?:poll|wake)/i.test(trimmed)
  ) {
    return null;
  }
  if (trimmed.startsWith("Node:")) {
    return trimmed.replace(/ · last input [^·]+/i, "").trim();
  }
  return trimmed;
}

function resolveSystemEventTimezone(cfg: OpenClawConfig) {
  const raw = normalizeOptionalString(cfg.agents?.defaults?.userTimezone);
  const lowered = normalizeLowercaseStringOrEmpty(raw);
  if (lowered === "utc" || lowered === "gmt") {
    return { mode: "utc" as const };
  }
  if (!raw || lowered === "local" || lowered === "host") {
    return { mode: "local" as const };
  }
  const timeZone =
    lowered === "user"
      ? resolveUserTimezone(cfg.agents?.defaults?.userTimezone)
      : resolveTimezone(raw);
  return timeZone ? { mode: "iana" as const, timeZone } : { mode: "local" as const };
}

function formatSystemEventTimestamp(ts: number, cfg: OpenClawConfig) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) {
    return "unknown-time";
  }
  const zone = resolveSystemEventTimezone(cfg);
  if (zone.mode === "utc") {
    return formatUtcTimestamp(date, { displaySeconds: true });
  }
  return (
    formatZonedTimestamp(date, {
      ...(zone.mode === "iana" ? { timeZone: zone.timeZone } : {}),
      displaySeconds: true,
    }) ?? "unknown-time"
  );
}

/**
 * Prepare queued system events for one prompt. Managed deliveries remain
 * pending until the caller durably adopts the resulting user turn.
 */
export async function prepareFormattedSystemEvents(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey: string;
  isMainSession: boolean;
  isNewSession: boolean;
  events?: readonly SystemEvent[];
  deferredEventIds?: readonly string[];
  onEventsAdmitted?: (events: readonly SystemEvent[]) => void;
}): Promise<PreparedFormattedSystemEvents> {
  const blocks: PreparedSystemEventBlock[] = [];
  const queueKey = resolveSystemEventQueueKey(params.sessionKey, params.agentId);
  // Passive selection leaves held notices with their delivery owner.
  // The queue is keyed by the owning agent, so peeking the resolved queue key is
  // the ownership filter; our delivery-ack/session filtering runs after it.
  // Claimed turns retain their own execution and delivery owner (#167113).
  let selected = (params.events ?? peekDeliverableSystemEventEntries(queueKey)).filter(
    (event) => !isSystemEventTurnOwned(queueKey, event),
  );
  // Prompt admission may defer captured occurrences to a delivery owner: they
  // are still formatted into this prompt but stay queued until that owner commits.
  // Consume before the first await, as upstream does: a concurrent drain or a
  // same-store resolver handoff must not observe (or re-select) these entries
  // while this preparation waits on worker-backed reads below. Consumption into a
  // prompt is adoption (upstream #178650): it settles receipts as adopted, and an
  // entry restored after a failed read below stays adopted while it is re-queued.
  let queued = adoptSelectedSystemEventEntries(queueKey, selected, {
    deferredEventIds: params.deferredEventIds,
  });
  // Storage must resolve under the SAME agent the ownership filter selected for,
  // or a global-scope key under a non-default agent reads the wrong store.
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey, params.agentId);
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
  const authorityScope = {
    agentId,
    sessionKey: params.sessionKey,
    storePath,
  };
  // Stale-authority entries are refused (retired unacked + removed) rather than formatted.
  // Authority-bound entries always carry a queue identity (id or ack id), which
  // survives the clone consumption hands back.
  const settledStaleAuthorityKeys = new Set<string>();
  const isSettledStaleAuthority = (event: SystemEvent) => {
    const key = event.recipientAuthority ? (event.id ?? event.sessionDeliveryAckId) : undefined;
    return key !== undefined && settledStaleAuthorityKeys.has(key);
  };
  let adoptedDeliveryIds: Set<string>;
  let currentSessionId: string | undefined;
  try {
    // Session reads stay off the caller thread: the worker-backed reader owns
    // store discovery, schema admission and the latest committed row.
    const currentSessionEntry = await readSessionEntryReadOnlyInWorker({
      agentId,
      sessionKey: params.sessionKey,
      storePath,
      projection: "list",
    });
    currentSessionId = currentSessionEntry?.sessionId;
    // Adoption-scoped events settle only after the turn is durably adopted, so a
    // crash between the transcript write and the queue ack leaves an ack id that
    // IS already adopted but whose row is still pending. Consult the transcript,
    // or an adoption-scoped notice would be re-injected.
    const hasAdoptionScopedDelivery = selected.some(
      (event) => event.sessionDeliveryAckId && event.sessionDeliveryAwaitsTurnAdoption,
    );
    adoptedDeliveryIds =
      currentSessionId && hasAdoptionScopedDelivery
        ? readAdoptedSystemEventDeliveryIds(
            await loadTranscriptEvents({
              agentId,
              sessionId: currentSessionId,
              sessionKey: params.sessionKey,
              storePath,
            }),
          )
        : new Set<string>();
    // A pre-filter only: final adoption decides under writer admission again.
    const bound = selected.filter((event) => event.recipientAuthority);
    const staleAuthorityEvents = await withCurrentSessionRecipientAuthority(
      bound.map((event) => ({ scope: authorityScope, authority: event.recipientAuthority! })),
      (current) => bound.filter((_, index) => !current[index]),
    );
    for (const event of staleAuthorityEvents) {
      await settleStaleSystemEventAuthority({
        event,
        sessionKey: queueKey,
        stage: "prompt-drain",
      });
      const key = event.id ?? event.sessionDeliveryAckId;
      if (key) {
        settledStaleAuthorityKeys.add(key);
      }
    }
    if (staleAuthorityEvents.length > 0) {
      const stale = new Set(staleAuthorityEvents);
      selected = selected.filter((event) => !stale.has(event));
      queued = queued.filter((event) => !isSettledStaleAuthority(event));
    }
  } catch (error) {
    // Nothing was formatted or claimed yet: a failed read or stale settlement
    // gives every unsettled entry back to the queue for the next turn.
    restoreConsumedSystemEventEntries(
      queueKey,
      queued.filter((event) => !isSettledStaleAuthority(event)),
    );
    throw error;
  }
  const authorityOwner = createPreparedSystemEventAuthorityOwner({
    scope: authorityScope,
    events: selected,
  });
  // Classify adoption-scoped deliveries BEFORE the prompt is assembled: an id
  // the persisted turn already adopted must be settled and excluded, not
  // re-injected.
  const adoptionScopedDeliveries: PreparedManagedSystemEventDelivery[] = [];
  // The turn that will adopt these deliveries binds this hold while it runs.
  const turnHold = createDeliveryAdoptionTurnHold();
  const seenAdoptionScopedIds = new Set<string>();
  const alreadyAdoptedAckIds: { id: string; stateDir?: string }[] = [];
  // Keyed by ack id, not object identity: adoptSelectedSystemEventEntries
  // returns different instances than the peeked entries classified here.
  const excludedAdoptedAckIds = new Set<string>();
  for (const event of selected) {
    if (!event.sessionDeliveryAwaitsTurnAdoption) {
      continue;
    }
    const id = normalizeOptionalString(event.sessionDeliveryAckId);
    if (!id || seenAdoptionScopedIds.has(id)) {
      continue;
    }
    seenAdoptionScopedIds.add(id);
    const stateDir = normalizeOptionalString(event.sessionDeliveryAckStateDir);
    if (adoptedDeliveryIds.has(id)) {
      // The persisted turn already adopted this id; only the queue ack was lost.
      // Settle it and keep it out of this prompt so a restart cannot surface the
      // same outcome twice.
      alreadyAdoptedAckIds.push({ id, ...(stateDir ? { stateDir } : {}) });
      excludedAdoptedAckIds.add(id);
      continue;
    }
    const authorityKey = readPreparedSystemEventAuthorityKey(event);
    const identity = {
      sessionDeliveryAckId: id,
      ...(stateDir ? { sessionDeliveryAckStateDir: stateDir } : {}),
    };
    adoptionScopedDeliveries.push({
      id,
      acknowledge: async () => {
        let settled = false;
        try {
          await ackSessionDelivery(id, captureContinuationQueueContext(stateDir));
          settled = true;
        } finally {
          releaseSystemEventDeliveryAdoption(identity, { settled });
        }
      },
      ...(authorityKey ? { authorityKey } : {}),
      turnHold,
    });
  }
  for (const ack of alreadyAdoptedAckIds) {
    try {
      await ackSessionDelivery(ack.id, captureContinuationQueueContext(ack.stateDir));
      releaseSystemEventDeliveryAdoption(
        {
          sessionDeliveryAckId: ack.id,
          ...(ack.stateDir ? { sessionDeliveryAckStateDir: ack.stateDir } : {}),
        },
        { settled: true },
      );
    } catch (error) {
      defaultRuntime.log(
        `[session-system-events] failed to settle already-adopted session delivery ${ack.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  for (const delivery of adoptionScopedDeliveries) {
    const consumed = queued.filter((event) => event.sessionDeliveryAckId === delivery.id);
    delivery.restore = () => restoreConsumedSystemEventEntries(queueKey, consumed);
  }
  const promptEvents = queued.filter(
    (event) =>
      !(event.sessionDeliveryAckId && excludedAdoptedAckIds.has(event.sessionDeliveryAckId)) &&
      (!event.expectedSessionId || event.expectedSessionId === currentSessionId),
  );
  // Upstream's admission hook sees every consumed entry (deferred ones included)
  // so the admitting owner can retire its ordinary generic events after delivery.
  params.onEventsAdmitted?.(queued);
  const sessionStateNotices = promptEvents.flatMap((event) => {
    const targetSessionKey = event.contextKey
      ? decodeSessionStateNoticeContextKey(event.contextKey)
      : undefined;
    return targetSessionKey === undefined
      ? []
      : [{ targetSessionKey, watcherStorePath: event.sessionStorePath ?? null }];
  });
  if (sessionStateNotices.length > 0) {
    await acknowledgeSessionStateNotices(params.sessionKey, sessionStateNotices);
  }
  const drainedContinuationCount = promptEvents.filter((event) =>
    event.text.startsWith("[continuation:"),
  ).length;
  const traceparent = promptEvents.find((event) => event.traceparent)?.traceparent;
  emitContinuationQueueDrainSpan({
    drainedCount: promptEvents.length,
    drainedContinuationCount,
    ...(settledStaleAuthorityKeys.size > 0
      ? {
          refusedCount: settledStaleAuthorityKeys.size,
          refusalReason: "recipient-authority-changed",
        }
      : {}),
    ...(traceparent ? { traceparent } : {}),
    log: (message) => defaultRuntime.log(message),
  });
  // Only an event that is formatted into this prompt may settle its durable
  // row. A selected event dropped above (bound to another session id, from a
  // replaced store, or empty after compaction) was consumed from memory, but its
  // row stays pending so replay can still deliver it where it belongs.
  const formattedEvents: SystemEvent[] = [];
  for (const event of promptEvents) {
    // A same-store resolver handoff does not retire already-consumed events.
    if (!isSystemEventStoreCurrent(params.sessionKey, event.sessionStorePath, params.agentId)) {
      continue;
    }
    const compacted = compactSystemEvent(event);
    if (!compacted) {
      continue;
    }
    formattedEvents.push(event);
    const timestamp = `[${formatSystemEventTimestamp(event.ts, params.cfg)}]`;
    const lines = compacted
      .split("\n")
      .map((subline, index) => `System: ${index === 0 ? `${timestamp} ` : ""}${subline}`);
    // Inbound text is deliberately not rewritten to neutralize look-alike `System:` lines.
    // Role separation plus external-content wrapping is the boundary.
    // This is an explicit product decision.
    const authorityKey = readPreparedSystemEventAuthorityKey(event);
    blocks.push({
      ...(event.sessionDeliveryAckId
        ? { key: `session-delivery:${event.sessionDeliveryAckId}` }
        : {}),
      text: lines.join("\n"),
      ...(authorityKey ? { authorityKey } : {}),
    });
  }
  const sessionDeliveryAcks = new Map<
    string,
    {
      id: string;
      stateDir?: string;
    }
  >();
  // Adoption-scoped events are NOT acked here: prompt preparation is not
  // adoption, and a crash or admission failure after this point would otherwise
  // complete the durable row with nothing delivered. They were classified above
  // and settle via settleManagedSystemEventsAfterTurnAdoption.
  for (const event of formattedEvents.filter((entry) => !entry.sessionDeliveryAwaitsTurnAdoption)) {
    const id = normalizeOptionalString(event.sessionDeliveryAckId);
    if (!id) {
      continue;
    }
    const stateDir = normalizeOptionalString(event.sessionDeliveryAckStateDir);
    const dedupeKey = `${id}\u0000${stateDir ?? ""}`;
    sessionDeliveryAcks.set(dedupeKey, {
      id,
      ...(stateDir ? { stateDir } : {}),
    });
  }
  for (const ack of sessionDeliveryAcks.values()) {
    try {
      await ackSessionDelivery(ack.id, captureContinuationQueueContext(ack.stateDir));
    } catch (error) {
      defaultRuntime.log(
        `[session-system-events] failed to ack consumed session delivery ${ack.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const formattedAckIds = new Set(
    formattedEvents.flatMap((event) =>
      event.sessionDeliveryAckId ? [event.sessionDeliveryAckId] : [],
    ),
  );
  const managedDeliveries = adoptionScopedDeliveries.filter((delivery) =>
    formattedAckIds.has(delivery.id),
  );
  // This turn now owns each managed delivery until it adopts (acknowledge) or
  // gives it back (restore): a replay meanwhile must not queue it again.
  for (const event of formattedEvents) {
    if (
      event.sessionDeliveryAckId &&
      managedDeliveries.some((d) => d.id === event.sessionDeliveryAckId)
    ) {
      claimSystemEventDeliveryAdoption(event, turnHold);
    }
  }
  // Each sub-line gets its own prefix so continuation lines can't be mistaken
  // for regular user content.
  const summaryLines =
    params.isMainSession && params.isNewSession
      ? (await buildChannelSummary(params.cfg)).flatMap((line) =>
          line.split("\n").map((subline) => `System: ${subline}`),
        )
      : [];
  if (summaryLines.length > 0) {
    blocks.unshift({ key: "session-summary", text: summaryLines.join("\n") });
  }
  return {
    blocks,
    managedDeliveries,
    ...(authorityOwner ? { authorityOwner } : {}),
  };
}

/** Drain queued system events and immediately acknowledge prepared deliveries. */
export async function drainFormattedSystemEvents(
  params: Parameters<typeof prepareFormattedSystemEvents>[0],
): Promise<string | undefined> {
  const prepared = await prepareFormattedSystemEvents(params);
  let adoption = await resolveFinalSystemEventAdoption({ prepared: [prepared] });
  while (adoption.kind === "settle-stale") {
    await adoption.settle();
    adoption = await resolveFinalSystemEventAdoption({ prepared: [prepared] });
  }
  for (const delivery of adoption.managedDeliveries.values()) {
    await delivery.acknowledge();
  }
  let finalAdoption = await resolveFinalSystemEventAdoption({ prepared: [prepared] });
  while (finalAdoption.kind === "settle-stale") {
    await finalAdoption.settle();
    finalAdoption = await resolveFinalSystemEventAdoption({ prepared: [prepared] });
  }
  return finalAdoption.blocks.length > 0
    ? finalAdoption.blocks.map((block) => block.text).join("\n")
    : undefined;
}
