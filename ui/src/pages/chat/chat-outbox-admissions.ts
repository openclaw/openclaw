import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store-scope.ts";

/** Owned by one Gateway outbox; volatile transfers block every pane until admitted or discarded. */
export class ChatOutboxAdmissions {
  private readonly pending = new Map<string, Set<string>>();
  private readonly settled = new Map<string, Set<() => void>>();

  hold(scope: StoredChatOutboxScope, ids: readonly string[], onSettled?: () => void): void {
    const key = storedChatOutboxScopeKey(scope);
    const pending = this.pending.get(key) ?? new Set<string>();
    ids.forEach((id) => pending.add(id));
    if (pending.size) {
      this.pending.set(key, pending);
      if (onSettled) {
        const callbacks = this.settled.get(key) ?? new Set<() => void>();
        callbacks.add(onSettled);
        this.settled.set(key, callbacks);
      }
    } else {
      onSettled?.();
    }
  }

  has(scope: StoredChatOutboxScope): boolean {
    return Boolean(this.pending.get(storedChatOutboxScopeKey(scope))?.size);
  }

  release(id: string): void {
    for (const [key, pending] of this.pending) {
      pending.delete(id);
      if (!pending.size) {
        this.pending.delete(key);
        const callbacks = this.settled.get(key);
        this.settled.delete(key);
        for (const callback of callbacks ?? []) {
          callback();
        }
      }
    }
  }
}
