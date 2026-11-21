import { createMemo, For } from "solid-js";
import { showConfirmDialog } from "../../components/confirm-dialog.ts";
import {
  captureChatOutboxRecoveryDestination,
  discardChatOutboxRecovery,
  restoreChatOutboxRecovery,
} from "../../lib/chat/outbox-recovery.ts";
import {
  parseStoredChatOutboxScope,
  storedChatOutboxScopeKey,
} from "../../lib/chat/outbox-store.ts";
import { formatDateTimeMs } from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../../lib/session-display.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import type { RecoveryEntry, RecoveryHost, RecoveryRestore } from "./chat-outbox-recovery.tsx";

type DraftStore = typeof import("../../lib/chat/composer-draft-store.runtime.ts");

export function* commitOutboxRecovery(operation: {
  host: RecoveryHost;
  entry: RecoveryEntry;
  owner: { gatewayOwner: string; recoveryScope: string };
  restore: RecoveryRestore | null;
  isCurrent: () => boolean;
  loadDraftStore: () => Promise<DraftStore>;
  setError: (error: string) => void;
}) {
  const { host, entry, owner, restore, isCurrent, loadDraftStore, setError } = operation;
  if (!restore) {
    // A dialog must render outside the transaction waiting for its answer.
    const confirmed: boolean = yield Promise.resolve().then(() =>
      isCurrent()
        ? showConfirmDialog({
            title: t("chat.outboxRecoveryDeleteTitle"),
            message: t("chat.outboxRecoveryDeleteConfirm"),
            details: details(entry),
            confirmLabel: t("chat.outboxRecoveryDelete"),
            danger: true,
          })
        : false,
    );
    if (!confirmed || !isCurrent()) {
      return undefined;
    }
    let result: ReturnType<typeof discardChatOutboxRecovery>;
    if ("id" in entry) {
      result = discardChatOutboxRecovery(host, entry, isCurrent);
    } else {
      const store: DraftStore = yield loadDraftStore();
      const discarded: Awaited<ReturnType<typeof store.discardDurableComposerRecovery>> =
        yield store.discardDurableComposerRecovery(owner, entry, isCurrent);
      result = discarded.status;
    }
    if (!isCurrent()) {
      return undefined;
    }
    if (result === "discarded") {
      return "discarded" as const;
    }
    setError(
      t(
        result === "conflict"
          ? "chat.outboxRecoveryDeleteConflict"
          : "chat.outboxRecoveryStorageFailed",
      ),
    );
    return undefined;
  }
  if (!isCurrent()) {
    setError(t("chat.outboxRecoveryConflict"));
    return undefined;
  }
  const { scope, destination, durableScope } = restore;
  const store: DraftStore = yield loadDraftStore();
  const before: Awaited<ReturnType<typeof store.readDurableComposerDraft>> =
    yield store.readDurableComposerDraft(durableScope);
  if (before.status === "storage-failed") {
    setError(t("chat.outboxRecoveryStorageFailed"));
    return undefined;
  }
  if (!destination || before.status === "found" || !isCurrent()) {
    setError(t("chat.outboxRecoveryConflict"));
    return undefined;
  }
  const confirmed: boolean = yield Promise.resolve().then(() =>
    isCurrent()
      ? showConfirmDialog({
          title: t("chat.outboxRecoveryReviewTitle"),
          message: t("chat.outboxRecoveryConfirm", {
            chat: resolveSessionDisplayName(
              scope.sessionKey,
              host.sessionsResult?.sessions.find((session) => session.key === scope.sessionKey),
            ),
          }),
          details: details(entry),
          confirmLabel: t("chat.outboxRecoveryRestore"),
        })
      : false,
  );
  if (!confirmed || !isCurrent()) {
    return undefined;
  }
  const currentDraft: Awaited<ReturnType<typeof store.readDurableComposerDraft>> =
    yield store.readDurableComposerDraft(durableScope);
  if (!isCurrent() || JSON.stringify(currentDraft) !== JSON.stringify(before)) {
    setError(t("chat.outboxRecoveryConflict"));
    return undefined;
  }
  let result:
    | ReturnType<typeof restoreChatOutboxRecovery>
    | Awaited<ReturnType<typeof store.restoreDurableComposerRecovery>>["status"];
  if ("id" in entry) {
    result = restoreChatOutboxRecovery(host, entry, destination, before.revision ?? 0);
  } else {
    const restored: Awaited<ReturnType<typeof store.restoreDurableComposerRecovery>> =
      yield store.restoreDurableComposerRecovery(
        durableScope,
        entry,
        before.revision ?? 0,
        before.writeId,
        () =>
          isCurrent() &&
          JSON.stringify(captureChatOutboxRecoveryDestination(host, scope)) ===
            JSON.stringify(destination),
        destination.revision,
      );
    result = restored.status;
  }
  if (result === "restored" || result === "persisted") {
    return "restored" as const;
  }
  setError(
    t(result === "conflict" ? "chat.outboxRecoveryConflict" : "chat.outboxRecoveryStorageFailed"),
  );
  return undefined;
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
export function RecoveryRows(props: {
  rows: readonly RecoveryEntry[];
  host: RecoveryHost | undefined;
  busy: boolean;
  canRecover: boolean;
  onChange: (entry: RecoveryEntry, action: "restore" | "discard") => Promise<void>;
}) {
  return (
    <For
      each={props.rows}
      keyed={(entry) => ("id" in entry ? `outbox:${entry.id}` : `draft:${entry.scopeKey}`)}
    >
      {(entry) => (
        <RecoveryRow
          entry={entry()}
          host={props.host}
          busy={props.busy}
          canRecover={props.canRecover}
          onChange={props.onChange}
        />
      )}
    </For>
  );
}
