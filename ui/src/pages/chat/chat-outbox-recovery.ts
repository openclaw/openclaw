import { html, LitElement, nothing, type PropertyValues } from "lit";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import { t } from "../../i18n/index.ts";
import "../../styles/chat/outbox-recovery.css";
import type { DurableComposerRecoveryEntry } from "../../lib/chat/composer-draft-store.runtime.ts";
import { observeOutboxRecoveryOwner } from "../../lib/chat/outbox-payload-store.runtime.ts";
import {
  captureChatOutboxRecoveryDestination,
  discardChatOutboxRecovery,
  readChatOutboxRecovery,
  restoreChatOutboxRecovery,
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
  static override properties = { host: { attribute: false }, identity: { type: String } };
  host?: ChatPageHost;
  identity = "";
  private entries: ChatOutboxRecoveryEntry[] = [];
  private drafts: DurableComposerRecoveryEntry[] = [];
  private error = "";
  private busy = false;
  private generation = 0;
  private unsubscribe?: () => void;

  override createRenderRoot() {
    return this;
  }
  override connectedCallback() {
    super.connectedCallback();
    this.unsubscribe = subscribeStoredChatOutboxChanges(() => void this.refresh());
  }
  override disconnectedCallback() {
    this.generation++;
    this.unsubscribe?.();
    super.disconnectedCallback();
  }
  protected override updated(changed: PropertyValues) {
    if (changed.has("identity") || changed.has("host")) {
      void this.refresh();
    }
  }
  private owner() {
    const host = this.host;
    if (!host || host.selectedChatSessionIncognito || !observeOutboxRecoveryOwner(host)) {
      return null;
    }
    return {
      gatewayOwner: storageTargetForGateway(host.settings.gatewayUrl).gatewayOwner,
      recoveryScope: observeOutboxRecoveryOwner(host)!,
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
      const recovery = host ? readChatOutboxRecovery(host) : null;
      this.entries = recovery?.entries ?? [];
      this.error = recovery?.blocked ? t("chat.outboxRecoveryFull") : "";
      if (owner) {
        const result = await (await draftStore).prepareDurableComposerRecovery(owner);
        if (generation !== this.generation || !this.isConnected) {
          return;
        }
        if (result.status === "storage-failed") {
          throw new Error("storage-failed");
        }
        this.drafts = result.entries;
      }
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
        details: this.preview(entry),
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
    const goal = "id" in entry ? entry.session.goalMode : entry.goalMode;
    const reply = "id" in entry ? entry.session.replyTarget : entry.replyTarget;
    if (goal) {
      return t("chat.outboxRecoveryGoal");
    }
    if (reply) {
      return t("chat.outboxRecoveryReply", { text: reply.text });
    }
    return t("chat.outboxRecoveryQueued");
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
        details: this.preview(entry),
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
    const session = "id" in entry ? entry.session : null;
    const draft = "id" in entry ? entry.session.draft : entry.text;
    const goal = "id" in entry ? entry.session.goalMode : entry.goalMode;
    const reply = "id" in entry ? entry.session.replyTarget : entry.replyTarget;
    const attachmentNames = "id" in entry ? [] : entry.attachmentNames;
    const scope = parseStoredChatOutboxScope("id" in entry ? entry.sourceScopeKey : entry.scopeKey);
    // Old global/main buckets do not identify a conversation. Never use today's
    // defaults to invent their source or show an inaccessible chat's raw key.
    const source =
      scope && !["global", "main"].includes(scope.sessionKey)
        ? this.host?.sessionsResult?.sessions.find((row) => row.key === scope.sessionKey)
        : undefined;
    const updatedAt = "id" in entry ? entry.session.updatedAt : entry.updatedAt;
    const queue = session?.queue ?? [];
    const hasDraft = !session || Boolean(draft?.trim() || goal || reply);
    return html`<div class="chat-outbox-recovery-row">
      ${
        hasDraft
          ? html`<div class="chat-outbox-recovery__message">
              <p class="chat-outbox-recovery__kind">${t("chat.outboxRecoveryDraft")}</p>
              ${draft?.trim() ? html`<p class="chat-outbox-recovery__preview">${draft}</p>` : nothing}
              ${goal ? html`<p>${t("chat.outboxRecoveryGoal")}</p>` : nothing}
              ${reply ? html`<p>${t("chat.outboxRecoveryReply", { text: reply.text })}</p>` : nothing}
              ${attachmentNames.length ? html`<p class="chat-outbox-recovery__attachments">${t("chat.outboxRecoveryAttachments", { files: attachmentNames.join(", ") })}</p>` : nothing}
            </div>`
          : nothing
      }
      ${queue.map(
        (item) => html`<div class="chat-outbox-recovery__message">
          <p class="chat-outbox-recovery__kind">${t("chat.outboxRecoveryQueued")}</p>
          ${item.text.trim() ? html`<p class="chat-outbox-recovery__preview">${item.text}</p>` : nothing}
          ${item.attachments?.length ? html`<p class="chat-outbox-recovery__attachments">${t("chat.outboxRecoveryAttachments", { files: item.attachments.map((a) => a.fileName ?? a.mimeType).join(", ") })}</p>` : nothing}
          ${item.attachmentStorageError ? html`<p class="chat-outbox-recovery__warning">${t("chat.outboxRecoveryAttachmentMissing")}</p>` : nothing}
          ${
            (item.sendAttempts ?? 0) > 0 || item.sendState === "unconfirmed"
              ? html`<p class="chat-outbox-recovery__warning">
                  ${t("chat.outboxRecoveryUnconfirmed")}
                </p>`
              : nothing
          }
        </div>`,
      )}
      <p class="chat-outbox-recovery__meta">
        ${
          source
            ? t("chat.outboxRecoverySource", {
                chat: resolveSessionDisplayName(source.key, source),
              })
            : t("chat.outboxRecoveryUnknownSource")
        }${
          updatedAt > 0
            ? html` ·
              ${t("chat.outboxRecoveryUpdated", { time: formatDateTimeMs(updatedAt, { dateStyle: "medium", timeStyle: "short" }) })}`
            : nothing
        }
      </p>
      <div class="chat-outbox-recovery__actions">
        <button
          class="btn primary"
          ?disabled=${this.busy || !this.owner()}
          @click=${() => void this.recover(entry)}
        >
          ${t("chat.outboxRecoveryRestore")}
        </button>
        <button
          class="btn"
          ?disabled=${this.busy || !this.owner()}
          @click=${() => void this.discard(entry)}
        >
          ${t("chat.outboxRecoveryDelete")}
        </button>
      </div>
    </div>`;
  }
  protected override render() {
    const rows: RecoveryEntry[] = [...this.entries, ...this.drafts];
    if (!rows.length && !this.error) {
      return nothing;
    }
    const queued = this.entries.reduce(
      (count, entry) => count + (entry.session.queue?.length ?? 0),
      0,
    );
    const drafts =
      this.drafts.length +
      this.entries.filter(
        ({ session }) => session.draft?.trim() || session.goalMode || session.replyTarget,
      ).length;
    const count = queued + drafts;
    const title = !count
      ? t("chat.outboxRecoveryFailedTitle")
      : queued
        ? t(count === 1 ? "chat.outboxRecoveryTitleOne" : "chat.outboxRecoveryTitle", {
            count: String(count),
          })
        : t(count === 1 ? "chat.outboxRecoveryDraftTitleOne" : "chat.outboxRecoveryDraftTitle", {
            count: String(count),
          });
    return html`<details class="chat-outbox-recovery" open>
      <summary>
        <span>${title}</span
        >${rows.length ? html`<span class="chat-outbox-recovery__summary-preview">${this.preview(rows[0]!)}</span>` : nothing}
      </summary>
      <div class="chat-outbox-recovery__content">
        ${this.error ? html`<p class="chat-outbox-recovery__error" role="alert">${this.error}</p>` : nothing}
        ${rows.map((entry) => this.renderEntry(entry))}
        ${rows.length ? html`<p class="chat-outbox-recovery__meta">${t(queued ? "chat.outboxRecoveryDescription" : count === 1 ? "chat.outboxRecoveryDraftDescriptionOne" : "chat.outboxRecoveryDraftDescription")}</p>` : nothing}
      </div>
    </details>`;
  }
}
customElements.define("openclaw-chat-outbox-recovery", ChatOutboxRecovery);
