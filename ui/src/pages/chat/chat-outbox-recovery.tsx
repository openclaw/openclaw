import {
  action,
  createMemo,
  createOptimistic,
  createSignal,
  For,
  lazy,
  onSettled,
  Show,
} from "solid-js";
import type { SessionsListResult } from "../../api/types.ts";
import { readOfflineStorageScope } from "../../app/boot-record.ts";
import { registerChatComposerEnglish } from "../../i18n/locales/en-chat-composer.ts";
import type { DurableComposerRecoveryEntry } from "../../lib/chat/composer-draft-store.runtime.ts";
import "../../styles/chat/outbox-recovery.css";
import {
  captureChatOutboxRecoveryDestination,
  readChatOutboxRecovery,
  retireDeliveredChatOutboxRecovery,
  type ChatOutboxRecoveryEntry,
} from "../../lib/chat/outbox-recovery.ts";
import {
  storageTargetForGateway,
  storedChatOutboxScopeKey,
  subscribeStoredChatOutboxChanges,
} from "../../lib/chat/outbox-store.ts";
import { t, registerEnglishCatalog } from "../../lib/reactive/i18n.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { chatRunPresentation } from "./chat-run-presentation.ts";
import { ChatLazyBoundary } from "./components/chat-lazy-boundary.tsx";

registerEnglishCatalog(registerChatComposerEnglish);

export type RecoveryEntry = ChatOutboxRecoveryEntry | DurableComposerRecoveryEntry;
export type RecoveryHost = Parameters<typeof captureChatOutboxRecoveryDestination>[0] &
  Required<
    Pick<
      Parameters<typeof captureChatOutboxRecoveryDestination>[0],
      "sessionKey" | "chatAttachments" | "chatQueue" | "chatMessages"
    >
  > & {
    settings: { gatewayUrl: string };
    sessionsResult?: SessionsListResult | null;
  };

// Start at the first admitted refresh, preserving promise ordering for recovery actions.
let draftStore: Promise<typeof import("../../lib/chat/composer-draft-store.runtime.ts")>;
const loadDraftStore = () =>
  (draftStore ??= import("../../lib/chat/composer-draft-store.runtime.ts"));

const RecoveryRows = lazy(() => import("./chat-outbox-recovery.runtime.tsx"), {
  export: "RecoveryRows",
});

function captureRestore(
  host: RecoveryHost,
  owner: { gatewayOwner: string; recoveryScope: string },
) {
  const scope = resolveUiConversationIdentity(host, host.sessionKey);
  return {
    scope,
    destination: captureChatOutboxRecoveryDestination(host, scope),
    durableScope: { ...owner, scopeKey: `chat:v3:${storedChatOutboxScopeKey(scope)}` },
  };
}
export type RecoveryRestore = ReturnType<typeof captureRestore>;

type RecoveryProps = {
  host: RecoveryHost | undefined;
  identity: string;
  onRestored?: () => void;
};

/** Recovery is owner-scoped and intentionally outside every automatic drain. */
function createChatOutboxRecovery(props: RecoveryProps, element: () => HTMLElement) {
  const [entries, setEntries] = createSignal<ChatOutboxRecoveryEntry[]>([]);
  const [drafts, setDrafts] = createSignal<DurableComposerRecoveryEntry[]>([]);
  const [failure, setError] = createSignal("");
  const [busy, setBusy] = createOptimistic(false);
  // Ordinary error writes settle with the action; hide prior feedback during its retry.
  const error = () => (busy() ? "" : failure());
  const rows = createMemo(() => [...entries(), ...drafts()]);
  let generation = 0;
  let refreshQueued = false;
  let active = true;
  // Admission stays synchronous while Solid defers the busy presentation.
  let changeInFlight = false;
  const isConnected = () => active && element().isConnected;
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
    if (!owner) {
      setDrafts([]);
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
      // A background check is not recovery: retain rows and feedback until storage answers.
      const result = await (await loadDraftStore()).prepareDurableComposerRecovery(owner);
      if (request !== generation || !isConnected()) {
        return;
      }
      if (result.status === "storage-failed") {
        throw new Error("storage-failed");
      }
      setDrafts(result.entries);
      setError(retirementError || (recovery?.blocked ? t("chat.outboxRecoveryFull") : ""));
    } catch {
      if (request !== generation || !isConnected()) {
        return;
      }
      setError(t("chat.outboxRecoveryStorageFailed"));
    }
  }
  const commitRecovery = action(function* (entry: RecoveryEntry, operation: "restore" | "discard") {
    const host = props.host;
    const owner = readOwner();
    if (!host || !owner || changeInFlight || !isConnected()) {
      return undefined;
    }
    const identity = props.identity;
    const client = host.client;
    const sessionId = host.currentSessionId;
    const connectionEpoch = host.connectionEpoch;
    const restoring = operation === "restore";
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
      if (restoring && !isCurrent()) {
        setError(t("chat.outboxRecoveryConflict"));
        return undefined;
      }
      // Preserve the clicked destination before a cold implementation can settle.
      const restore = restoring ? captureRestore(host, owner) : null;
      const runtime: typeof import("./chat-outbox-recovery.runtime.tsx") =
        yield RecoveryRows.preload();
      return yield* runtime.commitOutboxRecovery({
        host,
        entry,
        owner,
        restore,
        isCurrent,
        loadDraftStore,
        setError,
      });
    } catch {
      if (active && (restoring || isCurrent())) {
        setError(t("chat.outboxRecoveryStorageFailed"));
      }
    } finally {
      changeInFlight = false;
    }
    return undefined;
  });
  async function changeRecovery(entry: RecoveryEntry, operation: "restore" | "discard") {
    const host = props.host;
    const identity = props.identity;
    try {
      const result = await commitRecovery(entry, operation);
      if (!result || !isConnected() || props.host !== host || props.identity !== identity) {
        return;
      }
      // Finish the mutation before publishing another owner's state. A refresh
      // inside the held action would also hold the restored composer's render.
      if (result === "restored") {
        props.onRestored?.();
      }
      await refresh();
    } catch {
      if (isConnected() && props.host === host && props.identity === identity) {
        setError(t("chat.outboxRecoveryStorageFailed"));
      }
    }
  }
  return { rows, error, busy, canRecover: () => readOwner() !== null, changeRecovery };
}

export function PaneOutboxRecovery(props: {
  state: RecoveryHost;
  identity: string;
  onRestored: () => void;
}) {
  let element!: HTMLElement;
  const scope = createMemo(
    () => ({ host: props.state, identity: props.identity, onRestored: () => props.onRestored() }),
    {
      equals: (previous, next) =>
        previous.host === next.host && previous.identity === next.identity,
    },
  );
  return (
    <openclaw-chat-outbox-recovery
      ref={(node) => {
        element = node;
      }}
    >
      <For each={[scope()]}>
        {(current) => {
          const recovery = createChatOutboxRecovery(current, () => element);
          return (
            <Show when={recovery.rows().length || recovery.error()}>
              <div class="chat-outbox-recovery">
                <Show when={recovery.error()}>
                  <div class="chat-outbox-recovery__error" role="alert" title={recovery.error()}>
                    {recovery.error()}
                  </div>
                </Show>
                <Show when={recovery.rows().length}>
                  <ChatLazyBoundary>
                    <RecoveryRows
                      rows={recovery.rows()}
                      host={current.host}
                      busy={recovery.busy()}
                      canRecover={recovery.canRecover()}
                      onChange={recovery.changeRecovery}
                    />
                  </ChatLazyBoundary>
                </Show>
              </div>
            </Show>
          );
        }}
      </For>
    </openclaw-chat-outbox-recovery>
  );
}

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-chat-outbox-recovery": HTMLAttributes<HTMLElement>;
    }
  }
}
