import { html, LitElement, nothing, type PropertyValues } from "lit";
import { readOfflineStorageScope } from "../../app/boot-record.ts";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import "../../styles/chat/outbox-recovery.css";
import type { DurableComposerRecoveryEntry } from "../../lib/chat/composer-draft-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination,
  discardChatOutboxRecovery,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
  retireDeliveredChatOutboxRecovery,
  type ChatOutboxRecoveryEntry,
} from "../../lib/chat/outbox-recovery.ts";
import {
  parseStoredChatOutboxScope,
  storageTargetForGateway,
  storedChatOutboxScopeKey,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import type { ChatPageHost } from "./chat-state-host.ts";

type RecoveryEntry = ChatOutboxRecoveryEntry | DurableComposerRecoveryEntry;

const draftStore = import("../../lib/chat/composer-draft-store.runtime.ts");

/** Recovery is owner-scoped and intentionally outside every automatic drain. */
class ChatOutboxRecovery extends LitElement {
  static override properties = {
    host: { attribute: false },
    identity: { type: String },
    messages: { attribute: false },
  };
  host?: ChatPageHost;
  identity = "";
  messages: readonly unknown[] = [];
  private entries: ChatOutboxRecoveryEntry[] = [];
  private drafts: DurableComposerRecoveryEntry[] = [];
  private error = "";
  private busy = false;
  private generation = 0;
  private unsubscribe?: () => void;
  private refreshQueued = false;

  override createRenderRoot() {
    return this;
  }
  override connectedCallback() {
    super.connectedCallback();
    this.unsubscribe = subscribeStoredChatOutboxChanges(() => {
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
  override disconnectedCallback() {
    this.generation++;
    this.unsubscribe?.();
    super.disconnectedCallback();
  }
  protected override updated(changed: PropertyValues) {
    // Loaded history only matters while a recovery row awaits delivery proof.
    const awaitsProof =
      changed.has("messages") &&
      this.entries.some((entry) => entry.session.queue?.some((item) => item.sendRunId));
    if (changed.has("identity") || changed.has("host") || awaitsProof) {
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
      this.requestUpdate();
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
    this.requestUpdate();
  }
  private async recover(entry: RecoveryEntry) {
    const host = this.host;
    const owner = this.owner();
    if (!host || !owner || this.busy) {
      return;
    }
    const identity = this.identity;
    const client = host.client;
    const sessionId = host.currentSessionId;
    const connectionEpoch = host.connectionEpoch;
    const isCurrent = () =>
      this.isConnected &&
      this.host === host &&
      this.identity === identity &&
      host.client === client &&
      host.currentSessionId === sessionId &&
      host.connectionEpoch === connectionEpoch &&
      JSON.stringify(this.owner()) === JSON.stringify(owner) &&
      !host.chatMessage &&
      !host.chatGoalDraftMode &&
      !host.chatReplyTarget &&
      !host.chatAttachments.length &&
      !host.chatQueue.length;
    this.busy = true;
    this.error = "";
    this.requestUpdate();
    try {
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
          this.dispatchEvent(new CustomEvent("outbox-restored", { bubbles: true }));
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
      this.error = t("chat.outboxRecoveryStorageFailed");
    } finally {
      this.busy = false;
      this.requestUpdate();
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
  private async discard(entry: RecoveryEntry) {
    const host = this.host;
    const owner = this.owner();
    if (!host || !owner || this.busy) {
      return;
    }
    const identity = this.identity;
    const client = host.client;
    const epoch = host.connectionEpoch;
    const isCurrent = () =>
      this.isConnected &&
      this.host === host &&
      this.identity === identity &&
      host.client === client &&
      host.connectionEpoch === epoch &&
      JSON.stringify(this.owner()) === JSON.stringify(owner);
    this.busy = true;
    this.error = "";
    this.requestUpdate();
    try {
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
    } catch {
      if (isCurrent()) {
        this.error = t("chat.outboxRecoveryStorageFailed");
      }
    } finally {
      this.busy = false;
      this.requestUpdate();
    }
  }
  private renderEntry(entry: RecoveryEntry) {
    const scope = parseStoredChatOutboxScope("id" in entry ? entry.sourceScopeKey : entry.scopeKey);
    const currentScope = this.host
      ? resolveUiConversationIdentity(this.host, this.host.sessionKey)
      : undefined;
    // Old global/main buckets do not identify a conversation. Never use today's
    // defaults to invent their source or show an inaccessible chat's raw key.
    const source =
      scope &&
      !["global", "main"].includes(scope.sessionKey) &&
      (!currentScope || storedChatOutboxScopeKey(scope) !== storedChatOutboxScopeKey(currentScope))
        ? this.host?.sessionsResult?.sessions.find((row) => row.key === scope.sessionKey)
        : undefined;
    const updatedAt = "id" in entry ? entry.session.updatedAt : entry.updatedAt;
    const queued = "id" in entry && Boolean(entry.session.queue?.length);
    return html`<div
      class="chat-outbox-recovery-row"
      title=${
        updatedAt > 0
          ? t("chat.outboxRecoveryUpdated", {
              time: formatDateTimeMs(updatedAt, { dateStyle: "medium", timeStyle: "short" }),
            })
          : ""
      }
    >
      <span class="chat-outbox-recovery__kind"
        >${t(queued ? "chat.outboxRecoveryQueued" : "chat.outboxRecoveryDraft")}</span
      >
      <span class="chat-outbox-recovery__preview">${this.preview(entry)}</span>
      ${
        this.unconfirmed(entry)
          ? html`<span
              class="chat-outbox-recovery__warning"
              title=${t("chat.outboxRecoveryUnconfirmed")}
              >${t("chat.outboxRecoveryUnconfirmedLabel")}</span
            >`
          : nothing
      }
      ${
        source
          ? html`<span class="chat-outbox-recovery__source"
              >${t("chat.outboxRecoverySource", { chat: resolveSessionDisplayName(source.key, source) })}</span
            >`
          : nothing
      }
      <div class="chat-outbox-recovery__actions">
        ${(
          [
            ["chat.outboxRecoveryRestore", () => void this.recover(entry)],
            ["chat.outboxRecoveryDelete", () => void this.discard(entry)],
          ] as const
        ).map(
          ([label, action]) => html`
            <button class="btn btn--sm" ?disabled=${this.busy || !this.owner()} @click=${action}>
              ${t(label)}
            </button>
          `,
        )}
      </div>
    </div>`;
  }
  protected override render() {
    const rows: RecoveryEntry[] = [...this.entries, ...this.drafts];
    if (!rows.length && !this.error) {
      return nothing;
    }
    return html`<div class="chat-outbox-recovery">
      ${this.error ? html`<div class="chat-outbox-recovery__error" role="alert" title=${this.error}>${this.error}</div>` : nothing}
      ${rows.map((entry) => this.renderEntry(entry))}
    </div>`;
  }
}
customElements.define("openclaw-chat-outbox-recovery", ChatOutboxRecovery);
