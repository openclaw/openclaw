import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  captureGenericBindingSupport,
  readCurrentConversationBindingSelectionAsync,
  requiresRegisteredSessionBindingAdapter,
} from "./current-conversation-bindings.js";
import {
  CURRENT_BINDINGS_ID_PREFIX,
  isBindingExpired,
} from "./current-conversation-bindings.kernel.js";
import { currentConversationBindingPublication } from "./current-conversation-bindings.publication.js";
import {
  nativeSessionBindingInspection,
  type NativeSessionBindingReads,
} from "./session-binding-native-selection.js";
import {
  captureConversationRef,
  withSessionBindingInspectionConversation,
} from "./session-binding-normalization.js";
import type { SessionBindingAdapter, SessionBindingAdapterV2 } from "./session-binding-service.js";
import type {
  ConversationRef,
  SessionBindingInspection,
  SessionBindingRecord,
  SessionBindingScope,
} from "./session-binding.types.js";

type BindingInspectionOwner = {
  resolveAdapterForChannelAccount(
    scope: SessionBindingScope,
  ): (SessionBindingAdapter & NativeSessionBindingReads) | null;
  assertAdapterSelectionCurrent(
    scope: SessionBindingScope,
    adapter: SessionBindingAdapter | null,
  ): void;
  isAsyncAdapter(adapter: SessionBindingAdapter): adapter is SessionBindingAdapterV2;
  availableBindingInspection(
    conversation: ConversationRef,
    binding: SessionBindingRecord | null,
  ): SessionBindingInspection;
};

/** Prepared row facts serve synchronous effect grants; committed writes invalidate the selection. */
export async function prepareSessionBindingSelection(
  refs: readonly ConversationRef[],
  owner: BindingInspectionOwner,
) {
  const conversations = refs.map(captureConversationRef);
  let changed = false;
  let active = true;
  const unsubscribe = currentConversationBindingPublication.subscribeFacts((change) => {
    if (
      "receipt" in change ||
      change.kind === "pending" ||
      change.kind === "unknown" ||
      (change.kind === "settled" && change.outcome === "unknown")
    ) {
      changed = true;
    }
  });
  const dispose = () => {
    active = false;
    unsubscribe();
  };
  const checks: Array<() => void> = [];
  const records: Array<SessionBindingRecord | null> = conversations.map(() => null);
  const native: Array<{ index: number; conversation: ConversationRef }> = [];
  const groups = new Map<SessionBindingAdapter, number[]>();
  try {
    for (const [index, conversation] of conversations.entries()) {
      const adapter = owner.resolveAdapterForChannelAccount(conversation);
      checks.push(() => owner.assertAdapterSelectionCurrent(conversation, adapter));
      if (adapter?.[nativeSessionBindingInspection]) {
        const source = adapter[nativeSessionBindingInspection]!;
        const captured = source.capture(conversation);
        checks.push(source.assertCurrent);
        if (captured) native.push({ index, conversation: captured });
      } else if (adapter) {
        const indexes = groups.get(adapter) ?? [];
        indexes.push(index);
        groups.set(adapter, indexes);
      } else if (!requiresRegisteredSessionBindingAdapter(conversation)) {
        const support = captureGenericBindingSupport(conversation);
        checks.push(support.assertCurrent);
        if (support.supported) native.push({ index, conversation });
      }
    }
    if (native.length) {
      const context = captureOpenClawStateWorkerContext();
      checks.push(() => context.admission.assertCurrent());
    }
    const values = native.length
      ? await readCurrentConversationBindingSelectionAsync(native.map((item) => item.conversation))
      : [];
    native.forEach((item, index) => {
      records[item.index] = values[index] ?? null;
    });
    for (const [adapter, indexes] of groups) {
      const selected = indexes.map((index) => conversations[index]!);
      if (owner.isAsyncAdapter(adapter)) {
        const snapshot = await adapter.inspectByConversationsAsync(selected);
        if (snapshot.bindings.length !== selected.length)
          throw new Error("Session binding owner returned an incomplete conversation selection");
        checks.push(snapshot.assertCurrent);
        indexes.forEach((index, position) => {
          records[index] = snapshot.bindings[position] ?? null;
        });
      } else {
        // Released third-party adapters retain their owner-held synchronous effect reader.
        checks.push(() => {
          const inspect = adapter.inspectByConversation ?? adapter.resolveByConversation;
          indexes.forEach((index) => {
            records[index] = inspect.call(adapter, conversations[index]!);
          });
        });
      }
    }
    return {
      inspect() {
        if (!active) throw new Error("Conversation binding inspection is no longer active");
        if (changed) throw new Error("Conversation binding ownership changed. Retry the request.");
        for (const check of checks) check();
        return conversations.map((conversation, index) => {
          const adapter = owner.resolveAdapterForChannelAccount(conversation);
          if (!adapter && requiresRegisteredSessionBindingAdapter(conversation)) {
            return withSessionBindingInspectionConversation(
              { status: "unavailable" as const },
              conversation,
            );
          }
          const selected = records[index] ?? null;
          const record =
            !adapter && !selected?.bindingId.startsWith(CURRENT_BINDINGS_ID_PREFIX)
              ? null
              : selected;
          return owner.availableBindingInspection(
            conversation,
            record && !isBindingExpired(record) ? record : null,
          );
        });
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
