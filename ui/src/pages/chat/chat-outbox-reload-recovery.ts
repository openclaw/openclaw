import { registerControlUiReloadGuard } from "../../app/document-reload-guard.ts";
import { createGatewayControlUiReloadOptions } from "../../app/gateway-control-ui-reload.ts";
import type { ApplicationGateway } from "../../app/gateway.ts";
import { retryStaleChunkReloadWhenReachable } from "../../app/stale-chunk-reload.ts";
import { t } from "../../i18n/index.ts";
import { registerChatComposerEnglish } from "../../i18n/locales/en-chat-composer.ts";
import type { ChatAttachment, ChatQueueItem } from "../../lib/chat/chat-types.ts";
import { outboxOwnerKey } from "../../lib/chat/outbox-owner-registry.ts";
import { showToast } from "../../lib/toast.ts";
import { releaseChatAttachmentPayloads } from "./attachment-payload-store.ts";
import {
  preloadPrivateComposerRecovery,
  reviewPrivateComposerDraft,
} from "./components/private-composer-recovery-dialog.tsx";

registerChatComposerEnglish();

export type ChatOutboxReloadBinding = {
  gateway: ApplicationGateway;
  retainedAttachmentIds: (attachments: readonly ChatAttachment[]) => ReadonlySet<string>;
};
export type CapturedChatOutboxInput<T> = { entry: T; item: ChatQueueItem };

/** Presentation and guard registration only; the account outbox keeps and retires custody. */
export function protectChatOutboxFromReload<T extends { item: ChatQueueItem }>(options: {
  ownerKey: () => string;
  inputs: ReadonlyMap<string, T>;
  discard: (captured: CapturedChatOutboxInput<T>) => ChatQueueItem | null;
  retainedAttachmentIds: () => ReadonlySet<string>;
}) {
  let binding: ChatOutboxReloadBinding | undefined;
  let stopGateway: (() => void) | undefined;
  let active: { controller: AbortController; current: () => boolean } | undefined;
  let disposed = false;
  const ownerIsCurrent = (gateway: ApplicationGateway) =>
    Boolean(gateway.snapshot.client) &&
    outboxOwnerKey({
      client: gateway.snapshot.client,
      connected: gateway.snapshot.phase === "connected",
      settings: gateway.connection,
    }) === options.ownerKey();
  const changed = () => {
    // Defer closed-dialog code during ordinary boot, but prepare it while custody
    // still has the current build's assets. Module/custom-element owners deduplicate loads.
    if (options.inputs.size && binding) {
      void preloadPrivateComposerRecovery().catch(() => undefined);
    }
    if (active && !active.current()) {
      active.controller.abort();
    }
  };
  const review = async () => {
    const entry = options.inputs.values().next().value;
    const selected = binding;
    if (disposed || active || !entry || !selected || !ownerIsCurrent(selected.gateway)) {
      return;
    }
    const { gateway } = selected;
    const { client } = gateway.snapshot;
    const connection = gateway.connection;
    const item = entry.item;
    const controller = new AbortController();
    const current = () =>
      !disposed &&
      !controller.signal.aborted &&
      binding?.gateway === gateway &&
      gateway.snapshot.client === client &&
      gateway.connection === connection &&
      ownerIsCurrent(gateway) &&
      options.inputs.get(item.id) === entry &&
      entry.item === item;
    active = { controller, current };
    const reload = createGatewayControlUiReloadOptions(gateway);
    try {
      const discard = await reviewPrivateComposerDraft({
        text: item.text,
        attachments: item.attachments ?? [],
        hasGoal: false,
        pendingReads: 0,
        labels: {
          title: t("chat.queue.memoryOnlyTitle"),
          description: t("chat.queue.memoryOnlyDescription"),
          text: t("chat.queue.memoryOnlyText"),
          discard: t("chat.queue.memoryOnlyDiscard"),
        },
        isCurrent: current,
        signal: controller.signal,
      });
      if (!discard || !current()) {
        return;
      }
      const removed = options.discard({ entry, item });
      if (!removed) {
        showToast({ message: t("chat.queue.memoryOnlyChanged") });
        return;
      }
      const attachments = removed.attachments ?? [];
      const retained = new Set([
        ...options.retainedAttachmentIds(),
        ...selected.retainedAttachmentIds(attachments),
      ]);
      releaseChatAttachmentPayloads(
        attachments.filter((attachment) => !retained.has(attachment.id)),
      );
      // The explicit choice retires one row. Every remaining input and edit still guards reload.
      await retryStaleChunkReloadWhenReachable({ timeoutMs: 0, ...reload });
    } catch {
      if (current()) {
        showToast({ message: t("chat.queue.memoryOnlyUnavailable") });
      }
    } finally {
      if (active?.controller === controller) {
        active = undefined;
      }
    }
  };
  const unregister = registerControlUiReloadGuard(
    () => options.inputs.size === 0,
    () =>
      showToast({
        message: t("chat.queue.memoryOnlyReloadBlocked"),
        actionLabel: t("chat.queue.memoryOnlyReview"),
        onAction: () => void review(),
      }),
  );
  return {
    changed,
    bind(next: ChatOutboxReloadBinding | undefined) {
      if (disposed || !next) {
        return;
      }
      if (binding?.gateway === next.gateway) {
        binding = next;
        changed();
        return;
      }
      stopGateway?.();
      active?.controller.abort();
      binding = next;
      stopGateway = next.gateway.subscribe(changed);
      changed();
    },
    dispose() {
      disposed = true;
      unregister();
      stopGateway?.();
      active?.controller.abort();
    },
  };
}
