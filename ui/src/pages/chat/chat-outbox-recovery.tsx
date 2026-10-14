import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack } from "solid-js";
import { readOfflineStorageScope } from "../../app/boot-record.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import type { DurableComposerRecoveryEntry } from "../../lib/chat/composer-draft-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination,
  discardChatOutboxRecovery,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
  retireDeliveredChatOutboxRecovery,
  type ChatOutboxRecoveryEntry,
} from "../../lib/chat/outbox-recovery.ts";
import "../../styles/chat/outbox-recovery.css";
import {
  parseStoredChatOutboxScope,
  storageTargetForGateway,
  storedChatOutboxScopeKey,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../../lit/solid-bridge.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

type RecoveryEntry = ChatOutboxRecoveryEntry | DurableComposerRecoveryEntry;

const draftStore = import("../../lib/chat/composer-draft-store.runtime.ts");

type RecoveryProps = {
  host: ChatPageHost | undefined;
  identity: string;
  messages: readonly unknown[];
};

/** Recovery is owner-scoped and intentionally outside every automatic drain. */
class ChatOutboxRecoveryController {
  private entries: ChatOutboxRecoveryEntry[] = [];
  private drafts: DurableComposerRecoveryEntry[] = [];
  private error = "";
  private busy = false;
  private generation = 0;
  private refreshQueued = false;

  constructor(
    private readonly props: RecoveryProps,
    private readonly element: HTMLElement,
    private readonly notify: () => void,
  ) {}
  private get host() {
    return this.props.host;
  }
  private get identity() {
    return this.props.identity;
  }
  private get isConnected() {
    return this.element.isConnected;
  }

  subscribe() {
    return subscribeStoredChatOutboxChanges(() => {
      if (this.refreshQueued) {
        return;
      }
      this.refreshQueued = true;
      // Storage notifications can fire inside the owner's transfer fence.
      queueMicrotask(() => {
        this.refreshQueued = false;
        if (this.isConnected) {
          void this.refresh();
        }
      });
    });
  }
  disconnect() {
    this.generation++;
  }
  update(previous: RecoveryProps | undefined) {
    const awaitsProof =
      previous?.messages !== this.props.messages &&
      this.entries.some((entry) => entry.session.queue?.some((item) => item.sendRunId));
    if (
      !previous ||
      previous.identity !== this.identity ||
      previous.host !== this.host ||
      awaitsProof
    ) {
      void this.refresh();
    }
  }
  private owner() {
    const host = this.host;
    if (!host || host.selectedChatSessionIncognito || !readOfflineStorageScope(host)) {
      return null;
    }
    return {
      gatewayOwner: storageTargetForGateway(host.settings.gatewayUrl).gatewayOwner,
      recoveryScope: readOfflineStorageScope(host)!,
    };
  }
  private async refresh() {
    const generation = ++this.generation;
    const host = this.host;
    const owner = this.owner();
    this.drafts = [];
    if (!owner) {
      this.entries = [];
      this.error = "";
      this.notify();
      return;
    }
    try {
      let recovery = host ? readChatOutboxRecovery(host) : null;
      let retirementError = "";
      if (host && recovery?.entries.length) {
        const result = retireDeliveredChatOutboxRecovery(host, recovery.entries);
        if (result !== "unchanged") {
          recovery = readChatOutboxRecovery(host);
        }
        // A conflict means another writer moved first; the next refresh retries.
        if (result === "storage-failed") {
          retirementError = t("chat.outboxRecoveryStorageFailed");
        }
      }
      this.entries = recovery?.entries ?? [];
      this.error = retirementError || (recovery?.blocked ? t("chat.outboxRecoveryFull") : "");
      const result = await (await draftStore).prepareDurableComposerRecovery(owner);
      if (generation !== this.generation || !this.isConnected) {
        return;
      }
      if (result.status === "storage-failed") {
        throw new Error("storage-failed");
      }
      this.drafts = result.entries;
    } catch {
      if (generation !== this.generation || !this.isConnected) {
        return;
      }
      this.error = t("chat.outboxRecoveryStorageFailed");
    }
    this.notify();
  }
  private async changeRecovery(entry: RecoveryEntry, action: "restore" | "discard") {
    const host = this.host;
    const owner = this.owner();
    if (!host || !owner || this.busy) {
      return;
    }
    const identity = this.identity;
    const client = host.client;
    const sessionId = host.currentSessionId;
    const connectionEpoch = host.connectionEpoch;
    const restoring = action === "restore";
    const isCurrent = () =>
      this.isConnected &&
      this.host === host &&
      this.identity === identity &&
      host.client === client &&
      (!restoring || host.currentSessionId === sessionId) &&
      host.connectionEpoch === connectionEpoch &&
      JSON.stringify(this.owner()) === JSON.stringify(owner) &&
      (!restoring ||
        (!host.chatMessage &&
          !host.chatGoalDraftMode &&
          !host.chatReplyTarget &&
          !host.chatAttachments.length &&
          !host.chatQueue.length));
    this.busy = true;
    this.error = "";
    this.notify();
    try {
      if (!restoring) {
        const confirmed = await showConfirmDialog({
          title: t("chat.outboxRecoveryDeleteTitle"),
          message: t("chat.outboxRecoveryDeleteConfirm"),
          details: this.details(entry),
          confirmLabel: t("chat.outboxRecoveryDelete"),
          danger: true,
        });
        if (!confirmed || !isCurrent()) {
          return;
        }
        const result =
          "id" in entry
            ? discardChatOutboxRecovery(host, entry, isCurrent)
            : (await (await draftStore).discardDurableComposerRecovery(owner, entry, isCurrent))
                .status;
        if (!isCurrent()) {
          return;
        }
        if (result === "discarded") {
          await this.refresh();
        } else {
          this.error = t(
            result === "conflict"
              ? "chat.outboxRecoveryDeleteConflict"
              : "chat.outboxRecoveryStorageFailed",
          );
        }
        return;
      }
      if (!isCurrent()) {
        this.error = t("chat.outboxRecoveryConflict");
        return;
      }
      const scope = resolveUiConversationIdentity(host, host.sessionKey);
      const destination = captureChatOutboxRecoveryDestination(host, scope);
      const durableScope = { ...owner, scopeKey: `chat:v3:${storedChatOutboxScopeKey(scope)}` };
      const store = await draftStore;
      const before = await store.readDurableComposerDraft(durableScope);
      if (before.status === "storage-failed") {
        this.error = t("chat.outboxRecoveryStorageFailed");
        return;
      }
      if (!destination || before.status === "found" || !isCurrent()) {
        this.error = t("chat.outboxRecoveryConflict");
        return;
      }
      const confirmed = await showConfirmDialog({
        title: t("chat.outboxRecoveryReviewTitle"),
        message: t("chat.outboxRecoveryConfirm", { chat: this.chatName(scope.sessionKey) }),
        details: this.details(entry),
        confirmLabel: t("chat.outboxRecoveryRestore"),
      });
      if (!confirmed || !isCurrent()) {
        return;
      }
      const currentDraft = await store.readDurableComposerDraft(durableScope);
      if (!isCurrent() || JSON.stringify(currentDraft) !== JSON.stringify(before)) {
        this.error = t("chat.outboxRecoveryConflict");
        return;
      }
      const result =
        "id" in entry
          ? restoreChatOutboxRecovery(host, entry, destination, before.revision ?? 0)
          : (
              await store.restoreDurableComposerRecovery(
                durableScope,
                entry,
                before.revision ?? 0,
                before.writeId,
                () =>
                  isCurrent() &&
                  JSON.stringify(captureChatOutboxRecoveryDestination(host, scope)) ===
                    JSON.stringify(destination),
                destination.revision,
              )
            ).status;
      if (result === "restored" || result === "persisted") {
        if (this.host === host && this.identity === identity) {
          this.element.dispatchEvent(new CustomEvent("outbox-restored", { bubbles: true }));
        }
        await this.refresh();
      } else {
        this.error = t(
          result === "conflict"
            ? "chat.outboxRecoveryConflict"
            : "chat.outboxRecoveryStorageFailed",
        );
      }
    } catch {
      if (restoring || isCurrent()) {
        this.error = t("chat.outboxRecoveryStorageFailed");
      }
    } finally {
      this.busy = false;
      this.notify();
    }
  }
  private chatName(sessionKey: string) {
    const row = this.host?.sessionsResult?.sessions.find((session) => session.key === sessionKey);
    return resolveSessionDisplayName(sessionKey, row);
  }
  private preview(entry: RecoveryEntry) {
    const text =
      "id" in entry
        ? entry.session.draft || entry.session.queue?.find((item) => item.text.trim())?.text
        : entry.text;
    if (text?.trim()) {
      return text.trim();
    }
    const attachments =
      "id" in entry
        ? (entry.session.queue ?? [])
            .flatMap((item) => item.attachments ?? [])
            .map((a) => a.fileName ?? a.mimeType)
        : entry.attachmentNames;
    if (attachments.length) {
      return t("chat.outboxRecoveryAttachments", { files: attachments.join(", ") });
    }
    const { goalMode: goal, replyTarget: reply } = "id" in entry ? entry.session : entry;
    if (goal) {
      return t("chat.outboxRecoveryGoal");
    }
    if (reply) {
      return t("chat.outboxRecoveryReply", { text: reply.text });
    }
    return t("chat.outboxRecoveryQueued");
  }
  private unconfirmed(entry: RecoveryEntry) {
    return (
      "id" in entry &&
      entry.session.queue?.some(
        (item) => (item.sendAttempts ?? 0) > 0 || item.sendState === "unconfirmed",
      )
    );
  }
  private details(entry: RecoveryEntry) {
    const session = "id" in entry ? entry.session : null;
    const text = "id" in entry ? entry.session.draft : entry.text;
    const { goalMode: goal, replyTarget: reply } = "id" in entry ? entry.session : entry;
    const attachmentNames = "id" in entry ? [] : entry.attachmentNames;
    return [
      text?.trim(),
      goal ? t("chat.outboxRecoveryGoal") : "",
      reply ? t("chat.outboxRecoveryReply", { text: reply.text }) : "",
      attachmentNames.length
        ? t("chat.outboxRecoveryAttachments", { files: attachmentNames.join(", ") })
        : "",
      ...(session?.queue ?? []).flatMap((item) => [
        item.text.trim(),
        item.attachments?.length
          ? t("chat.outboxRecoveryAttachments", {
              files: item.attachments
                .map((attachment) => attachment.fileName ?? attachment.mimeType)
                .join(", "),
            })
          : "",
        item.attachmentStorageError ? t("chat.outboxRecoveryAttachmentMissing") : "",
      ]),
      this.unconfirmed(entry) ? t("chat.outboxRecoveryUnconfirmed") : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  private renderEntry(readEntry: () => RecoveryEntry, busy: () => boolean) {
    const view = createMemo(() => {
      const entry = readEntry();
      const scope = parseStoredChatOutboxScope(
        "id" in entry ? entry.sourceScopeKey : entry.scopeKey,
      );
      const currentScope = this.host
        ? resolveUiConversationIdentity(this.host, this.host.sessionKey)
        : undefined;
      // Old global/main buckets do not identify a conversation. Never use today's
      // defaults to invent their source or show an inaccessible chat's raw key.
      const source =
        scope &&
        !["global", "main"].includes(scope.sessionKey) &&
        (!currentScope ||
          storedChatOutboxScopeKey(scope) !== storedChatOutboxScopeKey(currentScope))
          ? this.host?.sessionsResult?.sessions.find((row) => row.key === scope.sessionKey)
          : undefined;
      const updatedAt = "id" in entry ? entry.session.updatedAt : entry.updatedAt;
      const queued = "id" in entry && Boolean(entry.session.queue?.length);
      return {
        source,
        updatedAt,
        queued,
        sourceLabel: source ? resolveSessionDisplayName(source.key, source) : "",
      };
    });
    return (
      <div
        class="chat-outbox-recovery-row"
        title={
          view().updatedAt > 0
            ? t("chat.outboxRecoveryUpdated", {
                time: formatDateTimeMs(view().updatedAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })
            : ""
        }
      >
        <span class="chat-outbox-recovery__kind">
          {t(view().queued ? "chat.outboxRecoveryQueued" : "chat.outboxRecoveryDraft")}
        </span>
        <span class="chat-outbox-recovery__preview">{this.preview(readEntry())}</span>
        {this.unconfirmed(readEntry()) ? (
          <span class="chat-outbox-recovery__warning" title={t("chat.outboxRecoveryUnconfirmed")}>
            {t("chat.outboxRecoveryUnconfirmedLabel")}
          </span>
        ) : null}
        {view().source ? (
          <span class="chat-outbox-recovery__source">
            {t("chat.outboxRecoverySource", {
              chat: view().sourceLabel,
            })}
          </span>
        ) : null}
        <div class="chat-outbox-recovery__actions">
          <button
            class="btn btn--sm"
            disabled={busy() || !this.owner()}
            onClick={() => void this.changeRecovery(readEntry(), "restore")}
          >
            {t("chat.outboxRecoveryRestore")}
          </button>
          <button
            class="btn btn--sm"
            disabled={busy() || !this.owner()}
            onClick={() => void this.changeRecovery(readEntry(), "discard")}
          >
            {t("chat.outboxRecoveryDelete")}
          </button>
        </div>
      </div>
    );
  }
  render(revision: () => number) {
    const view = createMemo(() => {
      revision();
      return { rows: [...this.entries, ...this.drafts], error: this.error, busy: this.busy };
    });
    return (
      <Show when={view().rows.length || view().error}>
        <div class="chat-outbox-recovery">
          <Show when={view().error}>
            <div class="chat-outbox-recovery__error" role="alert" title={view().error}>
              {view().error}
            </div>
          </Show>
          <For
            each={view().rows}
            keyed={(entry) => ("id" in entry ? `outbox:${entry.id}` : `draft:${entry.scopeKey}`)}
          >
            {(entry) => <>{this.renderEntry(entry, () => view().busy)}</>}
          </For>
        </div>
      </Show>
    );
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-outbox-recovery": SolidBridgeElement<RecoveryProps>;
  }
}

defineSolidBridge<RecoveryProps>(
  "openclaw-chat-outbox-recovery",
  (props, element) => {
    const [revision, setRevision] = createSignal(0);
    const controller = new ChatOutboxRecoveryController(props, element, () =>
      setRevision((value) => value + 1),
    );
    const unsubscribe = controller.subscribe();
    createEffect(
      () => ({ host: props.host, identity: props.identity, messages: props.messages }),
      (_current, previous) => untrack(() => controller.update(previous)),
    );
    onCleanup(() => {
      unsubscribe();
      controller.disconnect();
    });
    return untrack(() => controller.render(revision));
  },
  {
    properties: {
      host: { default: undefined, attribute: false },
      identity: { default: "" },
      messages: { default: [], attribute: false },
    },
  },
);
