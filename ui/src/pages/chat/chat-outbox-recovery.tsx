import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type { SessionsListResult } from "../../api/types.ts";
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
import { defineSolidBridge, type SolidBridgeElement } from "../../lib/solid-bridge.ts";
import type { ElementProperties } from "../../types/solid-elements.d.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";

type RecoveryEntry = ChatOutboxRecoveryEntry | DurableComposerRecoveryEntry;
type RecoveryHost = Parameters<typeof captureChatOutboxRecoveryDestination>[0] &
  Required<
    Pick<
      Parameters<typeof captureChatOutboxRecoveryDestination>[0],
      "sessionKey" | "chatAttachments" | "chatQueue" | "chatMessages"
    >
  > & {
    settings: { gatewayUrl: string };
    sessionsResult?: SessionsListResult | null;
  };

const draftStore = import("../../lib/chat/composer-draft-store.runtime.ts");

type RecoveryProps = {
  host: RecoveryHost | undefined;
  identity: string;
};

/** Recovery is owner-scoped and intentionally outside every automatic drain. */
function createChatOutboxRecovery(props: RecoveryProps, element: HTMLElement) {
  const [entries, setEntries] = createSignal<ChatOutboxRecoveryEntry[]>([]);
  const [drafts, setDrafts] = createSignal<DurableComposerRecoveryEntry[]>([]);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const rows = createMemo(() => [...entries(), ...drafts()]);
  let generation = 0;
  let refreshQueued = false;
  let active = true;
  // Admission stays synchronous while Solid defers the busy presentation.
  let changeInFlight = false;
  const isConnected = () => active && element.isConnected;
  const readOwner = () => {
    const host = props.host;
    const recoveryScope = host && readOfflineStorageScope(host);
    return host && !host.selectedChatSessionIncognito && recoveryScope
      ? {
          gatewayOwner: storageTargetForGateway(host.settings.gatewayUrl).gatewayOwner,
          recoveryScope,
        }
      : null;
  };
  onSettled(() => {
    const unsubscribe = subscribeStoredChatOutboxChanges(() => {
      if (refreshQueued) {
        return;
      }
      refreshQueued = true;
      // Storage notifications can fire inside the owner's transfer fence.
      queueMicrotask(() => {
        refreshQueued = false;
        if (isConnected()) {
          void refresh();
        }
      });
    });
    const host = props.host;
    let messages = host?.chatMessages;
    const stopReceipts =
      host &&
      chatRunPresentation(host).subscribe(() => {
        if (messages === host.chatMessages) {
          return;
        }
        messages = host.chatMessages;
        if (entries().some((entry) => entry.session.queue?.some((item) => item.sendRunId))) {
          void refresh();
        }
      });
    void refresh();
    return () => {
      active = false;
      unsubscribe();
      stopReceipts?.();
    };
  });
  async function refresh() {
    if (!active) {
      return;
    }
    const request = ++generation;
    const host = props.host;
    const owner = readOwner();
    setDrafts([]);
    if (!owner) {
      setEntries([]);
      setError("");
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
      setEntries(recovery?.entries ?? []);
      setError(retirementError || (recovery?.blocked ? t("chat.outboxRecoveryFull") : ""));
      const result = await (await draftStore).prepareDurableComposerRecovery(owner);
      if (request !== generation || !isConnected()) {
        return;
      }
      if (result.status === "storage-failed") {
        throw new Error("storage-failed");
      }
      setDrafts(result.entries);
    } catch {
      if (request !== generation || !isConnected()) {
        return;
      }
      setError(t("chat.outboxRecoveryStorageFailed"));
    }
  }
  async function changeRecovery(entry: RecoveryEntry, action: "restore" | "discard") {
    const host = props.host;
    const owner = readOwner();
    if (!host || !owner || changeInFlight || !isConnected()) {
      return;
    }
    const identity = props.identity;
    const client = host.client;
    const sessionId = host.currentSessionId;
    const connectionEpoch = host.connectionEpoch;
    const restoring = action === "restore";
    const isCurrent = () =>
      isConnected() &&
      props.host === host &&
      props.identity === identity &&
      host.client === client &&
      (!restoring || host.currentSessionId === sessionId) &&
      host.connectionEpoch === connectionEpoch &&
      JSON.stringify(readOwner()) === JSON.stringify(owner) &&
      (!restoring ||
        (!host.chatMessage &&
          !host.chatGoalDraftMode &&
          !host.chatReplyTarget &&
          !host.chatAttachments.length &&
          !host.chatQueue.length));
    changeInFlight = true;
    setBusy(true);
    setError("");
    try {
      if (!restoring) {
        const confirmed = await showConfirmDialog({
          title: t("chat.outboxRecoveryDeleteTitle"),
          message: t("chat.outboxRecoveryDeleteConfirm"),
          details: details(entry),
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
          await refresh();
        } else {
          setError(
            t(
              result === "conflict"
                ? "chat.outboxRecoveryDeleteConflict"
                : "chat.outboxRecoveryStorageFailed",
            ),
          );
        }
        return;
      }
      if (!isCurrent()) {
        setError(t("chat.outboxRecoveryConflict"));
        return;
      }
      const scope = resolveUiConversationIdentity(host, host.sessionKey);
      const destination = captureChatOutboxRecoveryDestination(host, scope);
      const durableScope = { ...owner, scopeKey: `chat:v3:${storedChatOutboxScopeKey(scope)}` };
      const store = await draftStore;
      const before = await store.readDurableComposerDraft(durableScope);
      if (before.status === "storage-failed") {
        setError(t("chat.outboxRecoveryStorageFailed"));
        return;
      }
      if (!destination || before.status === "found" || !isCurrent()) {
        setError(t("chat.outboxRecoveryConflict"));
        return;
      }
      const confirmed = await showConfirmDialog({
        title: t("chat.outboxRecoveryReviewTitle"),
        message: t("chat.outboxRecoveryConfirm", { chat: chatName(scope.sessionKey) }),
        details: details(entry),
        confirmLabel: t("chat.outboxRecoveryRestore"),
      });
      if (!confirmed || !isCurrent()) {
        return;
      }
      const currentDraft = await store.readDurableComposerDraft(durableScope);
      if (!isCurrent() || JSON.stringify(currentDraft) !== JSON.stringify(before)) {
        setError(t("chat.outboxRecoveryConflict"));
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
        if (active && props.host === host && props.identity === identity) {
          element.dispatchEvent(new CustomEvent("outbox-restored", { bubbles: true }));
        }
        await refresh();
      } else {
        setError(
          t(
            result === "conflict"
              ? "chat.outboxRecoveryConflict"
              : "chat.outboxRecoveryStorageFailed",
          ),
        );
      }
    } catch {
      if (active && (restoring || isCurrent())) {
        setError(t("chat.outboxRecoveryStorageFailed"));
      }
    } finally {
      changeInFlight = false;
      if (active) {
        setBusy(false);
      }
    }
  }
  function chatName(sessionKey: string) {
    const row = props.host?.sessionsResult?.sessions.find((session) => session.key === sessionKey);
    return resolveSessionDisplayName(sessionKey, row);
  }
  return { rows, error, busy, canRecover: () => readOwner() !== null, changeRecovery };
}

function preview(entry: RecoveryEntry) {
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
function unconfirmed(entry: RecoveryEntry) {
  return (
    "id" in entry &&
    entry.session.queue?.some(
      (item) => (item.sendAttempts ?? 0) > 0 || item.sendState === "unconfirmed",
    )
  );
}
function details(entry: RecoveryEntry) {
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
    unconfirmed(entry) ? t("chat.outboxRecoveryUnconfirmed") : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
function RecoveryRow(props: {
  entry: RecoveryEntry;
  host: RecoveryHost | undefined;
  busy: boolean;
  canRecover: boolean;
  onChange: (entry: RecoveryEntry, action: "restore" | "discard") => Promise<void>;
}) {
  const view = createMemo(() => {
    const entry = props.entry;
    const scope = parseStoredChatOutboxScope("id" in entry ? entry.sourceScopeKey : entry.scopeKey);
    const currentScope = props.host
      ? resolveUiConversationIdentity(props.host, props.host.sessionKey)
      : undefined;
    // Old global/main buckets do not identify a conversation. Never use today's
    // defaults to invent their source or show an inaccessible chat's raw key.
    const source =
      scope &&
      !["global", "main"].includes(scope.sessionKey) &&
      (!currentScope || storedChatOutboxScopeKey(scope) !== storedChatOutboxScopeKey(currentScope))
        ? props.host?.sessionsResult?.sessions.find((row) => row.key === scope.sessionKey)
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
      <span class="chat-outbox-recovery__preview">{preview(props.entry)}</span>
      {unconfirmed(props.entry) ? (
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
          disabled={props.busy || !props.canRecover}
          onClick={() => void props.onChange(props.entry, "restore")}
        >
          {t("chat.outboxRecoveryRestore")}
        </button>
        <button
          class="btn btn--sm"
          disabled={props.busy || !props.canRecover}
          onClick={() => void props.onChange(props.entry, "discard")}
        >
          {t("chat.outboxRecoveryDelete")}
        </button>
      </div>
    </div>
  );
}
declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-outbox-recovery": SolidBridgeElement<RecoveryProps>;
  }
}

defineSolidBridge<RecoveryProps>(
  "openclaw-chat-outbox-recovery",
  (props, element) => {
    const scope = createMemo(() => ({ host: props.host, identity: props.identity }), {
      equals: (previous, next) =>
        previous.host === next.host && previous.identity === next.identity,
    });
    return (
      <For each={[scope()]}>
        {(current) => {
          const recovery = createChatOutboxRecovery(current, element);
          return (
            <Show when={recovery.rows().length || recovery.error()}>
              <div class="chat-outbox-recovery">
                <Show when={recovery.error()}>
                  <div class="chat-outbox-recovery__error" role="alert" title={recovery.error()}>
                    {recovery.error()}
                  </div>
                </Show>
                <For
                  each={recovery.rows()}
                  keyed={(entry) =>
                    "id" in entry ? `outbox:${entry.id}` : `draft:${entry.scopeKey}`
                  }
                >
                  {(entry) => (
                    <RecoveryRow
                      entry={entry()}
                      host={current.host}
                      busy={recovery.busy()}
                      canRecover={recovery.canRecover()}
                      onChange={recovery.changeRecovery}
                    />
                  )}
                </For>
              </div>
            </Show>
          );
        }}
      </For>
    );
  },
  {
    properties: {
      host: { default: undefined, attribute: false },
      identity: { default: "" },
    },
  },
);

export function PaneOutboxRecovery(props: {
  state: RecoveryHost;
  identity: string;
  onRestored: () => void;
}) {
  return (
    <openclaw-chat-outbox-recovery
      prop:host={props.state}
      prop:identity={props.identity}
      onOutbox-restored={() => props.onRestored()}
    />
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-outbox-recovery": HTMLAttributes<
        HTMLElementTagNameMap["openclaw-chat-outbox-recovery"]
      > &
        ElementProperties<
          Pick<HTMLElementTagNameMap["openclaw-chat-outbox-recovery"], "host" | "identity">
        > & {
          "onOutbox-restored"?: () => void;
        };
    }
  }
}
