import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store-scope.ts";
import { storedChatOutboxScopeKey } from "../../lib/chat/outbox-store-scope.ts";
import type { ChatComposerScope as Composer } from "./composer-persistence.ts";

/** Owned by one Gateway outbox; volatile transfers block every pane until admitted or discarded. */
export class ChatOutboxAdmissions {
  private readonly requests = new Set<{
    host: Composer;
    client: Composer["client"];
    scopeKey: string;
    runId: string;
    controller: AbortController;
  }>();

  private readonly pending = new Map<string, Set<string>>();
  private readonly settled = new Map<string, Set<() => void>>();

  constructor(private readonly onRequestReleased: () => void) {}

  get hasRequests(): boolean {
    return this.requests.size > 0;
  }

  beginRequest(host: Composer, scope: StoredChatOutboxScope, runId: string) {
    const request = {
      host,
      client: host.client,
      scopeKey: storedChatOutboxScopeKey(scope),
      runId,
      controller: new AbortController(),
    };
    this.requests.add(request);
    return {
      signal: request.controller.signal,
      release: () => {
        this.requests.delete(request);
        this.onRequestReleased();
      },
    };
  }
  cancelRequests(host: Composer, scope?: StoredChatOutboxScope, runId?: string): void {
    const scopeKey = scope ? storedChatOutboxScopeKey(scope) : undefined;
    for (const request of this.requests) {
      const matches = scope
        ? request.client === host.client && request.scopeKey === scopeKey
        : request.host === host;
      if (matches && (!runId || request.runId === runId)) {
        request.controller.abort();
      }
    }
  }

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
