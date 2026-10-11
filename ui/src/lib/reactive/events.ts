import { subscribeBootRecordChanges } from "../../app/boot-record.ts";
import {
  subscribeBrowserAuthRestored,
  subscribeBrowserHttpFailures,
} from "../../app/browser-http.ts";
import { subscribeInitialTurnHandoff } from "../../pages/chat/initial-turn-handoff.ts";
import { subscribeSnapshotInvalidation } from "../../pages/chat/session-snapshot-invalidation-events.ts";
import { subscribeFirstRunActivationCleared } from "../../pages/model-setup/first-run-activation-receipt.ts";
import { subscribeDurableComposerDraftChanges } from "../chat/composer-draft-changes.ts";
import { subscribeChatOutboxAttentionChanges } from "../chat/outbox-owner-registry.ts";
import { subscribeStoredChatOutboxChanges } from "../chat/outbox-store.ts";
import type { SessionPatchOptions, SessionPatchResult } from "../sessions/patch.ts";
import { projectAsyncEvents, projectEvents } from "./projection.ts";

type ListenerEvent<Subscribe> = Subscribe extends (listener: infer Listener) => unknown
  ? Listener extends (event: infer Event) => unknown
    ? Event
    : never
  : never;

// These channels intentionally expose no read/last-value accessor: repeated
// invalidations and confirmations remain separate deliveries.
export function projectBootRecordChanges() {
  return projectEvents<
    typeof subscribeBootRecordChanges,
    ListenerEvent<typeof subscribeBootRecordChanges>
  >(subscribeBootRecordChanges, { subscribe: (subscribe, listener) => subscribe(listener) });
}

export function projectBrowserHttpFailures() {
  return projectEvents<typeof subscribeBrowserHttpFailures, string>(subscribeBrowserHttpFailures, {
    subscribe: (subscribe, listener) => subscribe(listener),
  });
}

export function projectBrowserAuthRestored() {
  return projectEvents<typeof subscribeBrowserAuthRestored, void>(subscribeBrowserAuthRestored, {
    subscribe: (subscribe, listener) => subscribe(() => listener()),
  });
}

export function projectStoredChatOutboxChanges() {
  return projectEvents<typeof subscribeStoredChatOutboxChanges, void>(
    subscribeStoredChatOutboxChanges,
    { subscribe: (subscribe, listener) => subscribe(() => listener()) },
  );
}

export function projectDurableComposerDraftChanges() {
  return projectEvents<typeof subscribeDurableComposerDraftChanges, void>(
    subscribeDurableComposerDraftChanges,
    { subscribe: (subscribe, listener) => subscribe(() => listener()) },
  );
}

export function projectChatOutboxAttentionChanges() {
  return projectEvents<typeof subscribeChatOutboxAttentionChanges, string>(
    subscribeChatOutboxAttentionChanges,
    { subscribe: (subscribe, listener) => subscribe(listener) },
  );
}

export function projectSnapshotInvalidation() {
  return projectAsyncEvents<
    typeof subscribeSnapshotInvalidation,
    ListenerEvent<typeof subscribeSnapshotInvalidation>
  >(subscribeSnapshotInvalidation, { subscribe: (subscribe, listener) => subscribe(listener) });
}

export function projectInitialTurnHandoff() {
  return projectEvents<typeof subscribeInitialTurnHandoff, void>(subscribeInitialTurnHandoff, {
    subscribe: (subscribe, listener) => subscribe(() => listener()),
  });
}

export function projectFirstRunActivationCleared() {
  return projectEvents<typeof subscribeFirstRunActivationCleared, string>(
    subscribeFirstRunActivationCleared,
    { subscribe: (subscribe, listener) => subscribe(listener) },
  );
}

export type ChatPickerPatchReceipt = NonNullable<SessionPatchOptions["predecessorReceipt"]>;

/** Consume the existing pending-tail receipt; confirmations are never replayed as initial state. */
export function projectChatPickerPatchConfirmations(source: ChatPickerPatchReceipt) {
  return projectEvents<ChatPickerPatchReceipt, SessionPatchResult | null>(source, {
    subscribe: (receipt, listener) => receipt.subscribe(() => listener(receipt.read())),
  });
}
