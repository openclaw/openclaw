import { t } from "../i18n/index.ts";
import { showToast } from "../lib/toast.ts";
import { releaseChatAttachmentPayloads } from "../pages/chat/attachment-payload-lifecycle.ts";
import type { ApplicationChatAttachmentHandoff } from "./context.ts";
import { registerControlUiReloadGuard } from "./document-reload-guard.ts";
import { createGatewayControlUiReloadOptions } from "./gateway-control-ui-reload.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { capturePlacementStartupConnection } from "./session-placement-startup.ts";
import { retryStaleChunkReloadWhenReachable } from "./stale-chunk-reload.ts";

const MAX_PENDING_CHAT_ATTACHMENT_ENTRIES = 32;
// Hidden split panes can remain unmounted indefinitely, so wall-clock expiry
// would lose valid drafts. Bounded oldest-first eviction owns abandoned cleanup.

type PendingChatAttachmentHandoff = NonNullable<
  ReturnType<ApplicationChatAttachmentHandoff["consume"]>
> & {
  owner: NonNullable<Parameters<ApplicationChatAttachmentHandoff["prepare"]>[0]["owner"]>;
  paneId: string;
  scopeKey: string;
  message: string;
  preparedAt: number;
  incognito?: boolean;
  isConnectionCurrent: () => boolean;
  reviewPrivateDraft: Parameters<
    ApplicationChatAttachmentHandoff["prepare"]
  >[0]["reviewPrivateDraft"];
};

const hasInput = (
  draft: Pick<
    PendingChatAttachmentHandoff,
    "message" | "attachments" | "goalMode" | "mentions" | "replyTarget"
  >,
) =>
  Boolean(
    draft.message ||
    draft.attachments.length ||
    draft.goalMode ||
    draft.replyTarget ||
    draft.mentions?.length,
  );

export function createChatAttachmentHandoff(
  gateway: ApplicationGateway,
): ApplicationChatAttachmentHandoff {
  const pending = new Map<string, PendingChatAttachmentHandoff>();
  let disposed = false;
  let activeReview: { key: string; controller: AbortController } | undefined;

  const handoffAttachments = (handoff: PendingChatAttachmentHandoff) => {
    const byId = new Map(handoff.attachments.map((attachment) => [attachment.id, attachment]));
    for (const fallback of Object.values(handoff.fallbacks)) {
      for (const attachment of fallback.attachments) {
        byId.set(attachment.id, attachment);
      }
    }
    return [...byId.values()];
  };
  const releaseHandoff = (
    handoff: PendingChatAttachmentHandoff | undefined,
    retainedIds = new Set<string>(),
  ) => {
    if (!handoff) {
      return;
    }
    releaseChatAttachmentPayloads(
      handoffAttachments(handoff).filter((attachment) => !retainedIds.has(attachment.id)),
    );
  };
  const entryKey = (paneId: string, scopeKey: string) => JSON.stringify([paneId, scopeKey]);
  const take = (key: string) => {
    const handoff = pending.get(key);
    if (handoff) {
      pending.delete(key);
      if (activeReview?.key === key) {
        activeReview.controller.abort();
      }
    }
    return handoff;
  };

  const privateDraft = (entry: PendingChatAttachmentHandoff) => {
    if ((entry.incognito || entry.newSessionDraft?.incognito) && hasInput(entry)) {
      return { draft: entry, fallbackKey: undefined };
    }
    for (const [fallbackKey, draft] of Object.entries(entry.fallbacks)) {
      if (draft.incognito && hasInput(draft)) {
        return { draft, fallbackKey };
      }
    }
    return undefined;
  };
  const retainedPayloadIds = () =>
    new Set([...pending.values()].flatMap(handoffAttachments).map((item) => item.id));
  const retirePrivateOwners = () => {
    for (const [key, entry] of pending) {
      if (privateDraft(entry) && !entry.isConnectionCurrent()) {
        releaseHandoff(take(key), retainedPayloadIds());
      }
    }
  };
  const stopGateway = gateway.subscribe(retirePrivateOwners);
  const privateEntry = () => {
    retirePrivateOwners();
    for (const [key, entry] of pending) {
      const selected = privateDraft(entry);
      if (selected) {
        return { key, entry, ...selected };
      }
    }
    return undefined;
  };
  const review = async () => {
    const selected = privateEntry();
    if (!selected || activeReview) {
      return;
    }
    const { key, entry, draft, fallbackKey } = selected;
    const controller = new AbortController();
    activeReview = { key, controller };
    const connection = gateway.connection;
    const client = gateway.snapshot.client;
    const current = () =>
      !disposed &&
      !controller.signal.aborted &&
      pending.get(key) === entry &&
      entry.isConnectionCurrent() &&
      gateway.snapshot.client === client &&
      gateway.connection === connection;
    const reloadOptions = createGatewayControlUiReloadOptions(gateway);
    try {
      if (!current()) {
        return;
      }
      const discard = await entry.reviewPrivateDraft({
        text: draft.message,
        attachments: draft.attachments,
        hasGoal: Boolean(draft.goalMode),
        pendingReads: 0,
        isCurrent: current,
        signal: controller.signal,
      });
      if (!discard || !current()) {
        return;
      }
      const attachments = [...draft.attachments];
      if (fallbackKey !== undefined) {
        delete entry.fallbacks[fallbackKey];
      } else {
        entry.message = "";
        entry.attachments = [];
        entry.goalMode = null;
        entry.replyTarget = null;
        entry.mentions = [];
      }
      if (
        !entry.message &&
        !entry.attachments.length &&
        !entry.goalMode &&
        !entry.replyTarget &&
        !Object.keys(entry.fallbacks).length
      ) {
        take(key);
      }
      const retained = retainedPayloadIds();
      releaseChatAttachmentPayloads(attachments.filter((item) => !retained.has(item.id)));
      await retryStaleChunkReloadWhenReachable({ timeoutMs: 0, ...reloadOptions });
    } catch {
      if (current()) {
        showToast({ message: t("chat.privateDraftReload.unavailable") });
      }
    } finally {
      if (activeReview?.controller === controller) {
        activeReview = undefined;
      }
    }
  };
  const unregister = registerControlUiReloadGuard(
    () => !privateEntry(),
    () =>
      showToast({
        message: t("chat.privateDraftReload.blocked"),
        actionLabel: t("chat.privateDraftReload.review"),
        onAction: () => void review(),
      }),
  );

  return {
    prepare: ({
      owner,
      paneId,
      scopeKey,
      attachments,
      fallbacks,
      message = "",
      draftRevision,
      goalMode,
      replyTarget,
      mentions,
      newSessionDraft,
      incognito,
      reviewPrivateDraft,
    }) => {
      const key = entryKey(paneId, scopeKey);
      const previous = take(key);
      const fallbackEntries = Object.entries(fallbacks);
      if (
        !message &&
        !goalMode &&
        !replyTarget &&
        attachments.length === 0 &&
        fallbackEntries.length === 0
      ) {
        releaseHandoff(previous);
        return;
      }
      const retainedIds = new Set(attachments.map((attachment) => attachment.id));
      for (const fallback of Object.values(fallbacks)) {
        for (const attachment of fallback.attachments) {
          retainedIds.add(attachment.id);
        }
      }
      releaseHandoff(previous, retainedIds);
      if (!owner || disposed) {
        releaseChatAttachmentPayloads(attachments);
        for (const fallback of Object.values(fallbacks)) {
          releaseChatAttachmentPayloads(fallback.attachments);
        }
        return;
      }
      pending.set(key, {
        owner,
        reviewPrivateDraft,
        isConnectionCurrent: capturePlacementStartupConnection(gateway, {
          gatewayUrl: gateway.connection.gatewayUrl,
          recoveryScope: owner.recoveryScope ?? "",
        }),
        preparedAt: Date.now(),
        paneId,
        scopeKey,
        attachments: [...attachments],
        ...(newSessionDraft ? { newSessionDraft } : {}),
        ...(incognito ? { incognito } : {}),
        message,
        ...(draftRevision !== undefined ? { draftRevision } : {}),
        ...(goalMode ? { goalMode } : {}),
        ...(replyTarget ? { replyTarget: { ...replyTarget } } : {}),
        ...(mentions?.length ? { mentions: mentions.map((mention) => ({ ...mention })) } : {}),
        fallbacks: Object.fromEntries(
          fallbackEntries.map(([fallbackKey, fallback]) => [
            fallbackKey,
            { ...fallback, attachments: [...fallback.attachments] },
          ]),
        ),
      });
      // Route handoffs normally consume immediately. Bounds make abandoned
      // split panes release their packages instead of leaking for the tab lifetime.
      for (const oldestKey of pending.keys()) {
        if (pending.size <= MAX_PENDING_CHAT_ATTACHMENT_ENTRIES) {
          break;
        }
        releaseHandoff(take(oldestKey));
      }
    },
    consume: ({ owner, paneId, scopeKey }) => {
      const match = take(entryKey(paneId, scopeKey));
      // A Gateway mismatch is terminal for this exact presentation. Other
      // retained session scopes under the same logical pane remain independent.
      if (match?.owner === owner) {
        return {
          attachments: match.attachments,
          fallbacks: match.fallbacks,
          ...(match.newSessionDraft ? { newSessionDraft: match.newSessionDraft } : {}),
          ...(match.message ? { message: match.message } : {}),
          ...(match.draftRevision !== undefined ? { draftRevision: match.draftRevision } : {}),
          ...(match.goalMode ? { goalMode: match.goalMode } : {}),
          ...(match.replyTarget ? { replyTarget: match.replyTarget } : {}),
          ...(match.mentions ? { mentions: match.mentions } : {}),
        };
      }
      releaseHandoff(match);
      return null;
    },
    retainedAttachmentIds: (attachments) => {
      const requested = new Set(attachments.map((attachment) => attachment.id));
      const retained = new Set<string>();
      for (const handoff of pending.values()) {
        for (const attachment of handoffAttachments(handoff)) {
          if (requested.has(attachment.id)) {
            retained.add(attachment.id);
          }
        }
      }
      return retained;
    },
    retireScope: (scopeKey, beforeRevision) => {
      // Optimistic navigation may unmount the pane before deletion confirms.
      // Retire that package without touching a later edit or another session.
      for (const [key, handoff] of pending) {
        if (handoff.scopeKey === scopeKey && handoff.preparedAt < beforeRevision) {
          releaseHandoff(take(key));
        }
      }
    },
    clearPane: (paneId) => {
      for (const [key, handoff] of pending) {
        if (handoff.paneId === paneId) {
          releaseHandoff(take(key));
        }
      }
    },
    dispose: () => {
      disposed = true;
      unregister();
      stopGateway();
      activeReview?.controller.abort();
      for (const handoff of pending.values()) {
        releaseHandoff(handoff);
      }
      pending.clear();
    },
  };
}
