import { compareChatQueueOrder } from "../../lib/chat/chat-queue-order.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  outboxPayloadMatchesOwner,
  observeOutboxRecoveryOwner,
} from "../../lib/chat/outbox-payload-store.runtime.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import {
  applyStoredChatOutboxScope,
  subscribeStoredChatOutboxChanges,
  type captureChatOutboxAdmission,
} from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { getSafeSessionStorage } from "../../local-storage.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import {
  admitStoredChatComposerQueueItemResult,
  listStoredChatOutboxes,
  removeStoredChatComposerQueueItem,
  updateStoredChatComposerQueueItem,
  updateStoredChatComposerQueueItems,
  storedChatOutboxScopeKey,
  type ChatComposerScope as Composer,
  type StoredChatQueueReplacement,
  type StoredChatOutboxScope as Scope,
} from "./composer-persistence.ts";
import {
  captureOutboxPayloadOwner,
  failOutboxPayload,
  prepareOutboxPayload,
} from "./outbox-payloads.ts";
type Host = Composer & { chatQueue: ChatQueueItem[]; sessionKey: string; requestUpdate?(): void };
type HostProjection = {
  byScope: Map<string, { scope: Scope; queue: ChatQueueItem[] }>;
  durableSeen: Set<string>;
  retryable: Set<string>;
};
type LiveProjection = {
  item: ChatQueueItem;
  owner: Host;
  expectedDurableVersion?: ChatQueueItem;
  submissionIsCurrent?: () => boolean;
};
const LIVE_VERSION_KEYS = ["sendRunId", "sendAttempts", "sendState", "sendError"] as const;
const storageIds = new WeakMap<Storage, number>();
let nextStorageId = 0;
function isActiveLocal(state: HostProjection, item: ChatQueueItem): boolean {
  return Boolean(
    item.pendingRunId ||
    item.sendState === "waiting-model" ||
    state.retryable.has(item.id) ||
    !state.durableSeen.has(item.id),
  );
}
// One gateway owner merges durable, live, and pane-local rows for every subscribed pane.
class ChatOutboxGatewayOwner {
  private readonly hosts = new Map<Host, HostProjection>();
  private readonly panes = new Set<Host>();
  private readonly live = new Map<string, Map<string, LiveProjection>>();
  private readonly hydrating = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  constructor(readonly ownerGatewayKey: string) {}
  private state(host: Host): HostProjection {
    const existing = this.hosts.get(host);
    if (existing) {
      return existing;
    }
    const scope = resolveUiConversationIdentity(host, host.sessionKey);
    const durableSeen = new Set(this.outbox(host, scope)?.queue.map((item) => item.id));
    const created: HostProjection = { byScope: new Map(), durableSeen, retryable: new Set() };
    if (host.chatQueue.length) {
      created.byScope.set(storedChatOutboxScopeKey(scope), {
        scope,
        queue: host.chatQueue.filter((item) => outboxPayloadMatchesOwner(host, item)),
      });
    }
    this.hosts.set(host, created);
    return created;
  }
  private outbox(host: Composer, scope: Scope) {
    return listStoredChatOutboxes(host).find(
      ({ sessionKey, agentId }) => sessionKey === scope.sessionKey && agentId === scope.agentId,
    );
  }
  durable(host: Composer, id: string) {
    return listStoredChatOutboxes(host).find(({ queue }) => queue.some((item) => item.id === id));
  }
  locate(host: Host, id: string) {
    const outbox = this.durable(host, id);
    const captured = outbox ?? this.local(this.state(host), id)?.scope;
    if (!captured) {
      return undefined;
    }
    const { sessionKey, agentId } = captured;
    const scope = { sessionKey, agentId };
    const item = this.snapshot(host, scope, outbox?.queue ?? []).find((row) => row.id === id);
    return item ? { item, scope, durable: outbox?.queue.find((row) => row.id === id) } : undefined;
  }
  private project(item: ChatQueueItem, local: ChatQueueItem): ChatQueueItem {
    const projected: ChatQueueItem = { ...item };
    if (local.attachments) {
      const presented = new Map(local.attachments.map((attachment) => [attachment.id, attachment]));
      projected.attachments = (item.attachments ?? local.attachments).map((attachment) =>
        Object.assign({}, attachment, presented.get(attachment.id)),
      );
    }
    for (const key of ["sendSubmittedAtMs", "sendRequestStartedAtMs"] as const) {
      if (typeof local[key] === "number") {
        projected[key] = local[key];
      }
    }
    return projected;
  }
  private readLive(key: string, id: string, durable?: ChatQueueItem): LiveProjection | undefined {
    const entries = this.live.get(key);
    if (!entries) {
      return undefined;
    }
    const live = entries.get(id);
    if (
      (live?.expectedDurableVersion &&
        (!durable || !sameQueuedDeliveryVersion(live.expectedDurableVersion, durable))) ||
      (live?.submissionIsCurrent && !live.submissionIsCurrent())
    ) {
      entries.delete(id);
      if (!entries.size) {
        this.live.delete(key);
      }
      return undefined;
    }
    return live;
  }
  snapshot(
    host: Host,
    scope: Scope,
    durable = this.outbox(host, scope)?.queue ?? [],
  ): ChatQueueItem[] {
    const key = storedChatOutboxScopeKey(scope);
    const state = this.state(host);
    const local = state.byScope.get(key)?.queue ?? [];
    const localById = new Map(local.map((item) => [item.id, item]));
    const visible = durable.map((item) => {
      state.durableSeen.add(item.id);
      const pending = localById.get(item.id);
      const live = this.readLive(key, item.id, item)?.item;
      return pending?.pendingRunId || pending?.sendState === "waiting-model"
        ? pending
        : live && live.sendRunId === item.sendRunId
          ? live
          : pending && pending.sendRunId === item.sendRunId
            ? this.project(item, pending)
            : item;
    });
    const durableIds = new Set(durable.map((item) => item.id));
    visible.push(...local.filter((item) => !durableIds.has(item.id) && isActiveLocal(state, item)));
    this.prune(host);
    return visible.toSorted(compareChatQueueOrder);
  }
  syncHost(host: Host, options: { requestUpdate?: boolean } = {}): void {
    if (this.ownerGatewayKey !== outboxOwnerKey(host)) {
      chatOutboxOwner(host).syncHost(host, options);
      return;
    }
    observeOutboxRecoveryOwner(host);
    host.chatQueue = this.snapshot(host, resolveUiConversationIdentity(host, host.sessionKey));
    for (const item of host.chatQueue) {
      const key = item.attachmentPayload?.key;
      if (
        !key ||
        item.attachmentStorageError ||
        this.hydrating.has(key) ||
        item.attachments?.every((attachment) => getChatAttachmentDataUrl(attachment))
      ) {
        continue;
      }
      this.hydrating.add(key);
      const isCurrent = captureOutboxPayloadOwner(host);
      void prepareOutboxPayload(host, item)
        .then((result) => {
          if (!isCurrent()) {
            return;
          }
          const outbox = this.durable(host, item.id);
          const current = outbox?.queue.find((row) => row.id === item.id);
          if (!outbox || current?.attachmentPayload?.key !== key) {
            return;
          }
          if (result.status === "ready") {
            if (result.update.attachmentPayload?.key !== key) {
              // Reconnect can park this attempt while its private Blob copy awaits.
              // Preserve that newer state, but never adopt over a changed submission.
              const parked =
                item.sendState === "waiting-reconnect" &&
                current.sendState === "unconfirmed" &&
                sameQueuedDeliveryVersion(current, {
                  ...applyStoredChatOutboxScope(item, outbox),
                  sendState: "unconfirmed",
                });
              if (
                !updateStoredChatComposerQueueItem(
                  host,
                  outbox.sessionKey,
                  parked ? current : item,
                  { ...current, ...result.update },
                  outbox.agentId,
                )
              ) {
                return;
              }
            }
            this.keep(host, outbox, {
              ...current,
              attachments: result.update.attachments,
              ...(result.update.attachmentPayload?.key !== key
                ? {
                    attachmentPayload: result.update.attachmentPayload,
                    sendState: result.update.sendState,
                    sendError: result.update.sendError,
                  }
                : {}),
            });
          } else {
            updateStoredChatComposerQueueItem(
              host,
              outbox.sessionKey,
              current,
              failOutboxPayload(current, result.reason),
              outbox.agentId,
            );
          }
          this.publish(host);
        })
        .finally(() => this.hydrating.delete(key));
    }
    if (options.requestUpdate !== false) {
      host.requestUpdate?.();
    }
  }
  publish(origin?: Host, reconcile = false): void {
    if (origin) {
      this.syncHost(origin);
    }
    for (const pane of this.panes) {
      if (pane !== origin) {
        if (reconcile) {
          this.reconcile(pane, this.state(pane));
        }
        this.syncHost(pane);
      }
    }
  }
  adoptSubscriptions(host: Composer): void {
    const previous = subscriptions.get(host)?.owner;
    if (!previous || previous === this) {
      return;
    }
    let adopted = false;
    // A shared client's credentials change before pane callbacks run. Move peers
    // together so the first reconnect drain still observes every pane's edit hold.
    for (const pane of previous.panes) {
      if (outboxOwnerKey(pane) !== this.ownerGatewayKey) {
        continue;
      }
      subscriptions.get(pane)!.owner = this;
      previous.hosts.delete(pane);
      for (const [key, live] of previous.live) {
        for (const [id, projection] of live) {
          if (projection.owner === pane) {
            live.delete(id);
          }
        }
        if (!live.size) {
          previous.live.delete(key);
        }
      }
      // Stored rows remain authoritative; old credential-local overlays do not.
      pane.chatQueue = [];
      previous.detach(pane);
      this.attach(pane);
      adopted = true;
    }
    if (adopted) {
      // Publish only after every peer has moved, preserving shared edit holds.
      this.publish();
    }
  }
  private attach(host: Host): void {
    this.panes.add(host);
    this.unsubscribe ??= subscribeStoredChatOutboxChanges(() => this.publish(undefined, true));
  }
  private detach(host: Host): void {
    this.panes.delete(host);
    if (!this.panes.size) {
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
    this.prune(host);
  }
  subscribe(host: Host, onDiscard?: (item: ChatQueueItem) => void): () => void {
    const subscription = { owner: this, onDiscard };
    subscriptions.set(host, subscription);
    this.attach(host);
    this.reconcile(host, this.state(host));
    this.syncHost(host, { requestUpdate: false });
    return () => {
      if (subscriptions.get(host) !== subscription) {
        return;
      }
      subscriptions.delete(host);
      subscription.owner.detach(host);
    };
  }
  private reconcile(host: Host, state: HostProjection): void {
    const durableIds = new Set(
      listStoredChatOutboxes(host).flatMap((outbox) => outbox.queue.map((item) => item.id)),
    );
    durableIds.forEach((id) => state.durableSeen.add(id));
    for (const local of state.byScope.values()) {
      local.queue = local.queue.filter(
        (item) => durableIds.has(item.id) || isActiveLocal(state, item),
      );
    }
  }
  retirePendingRun(host: Host, runId: string): ChatQueueItem[] {
    const removed = host.chatQueue.filter((item) => item.pendingRunId === runId);
    const scope = resolveUiConversationIdentity(host, host.sessionKey);
    const state = this.state(host);
    const local = state.byScope.get(storedChatOutboxScopeKey(scope));
    if (local) {
      local.queue = local.queue.filter((item) => item.pendingRunId !== runId);
    }
    for (const item of removed) {
      state.retryable.delete(item.id);
    }
    this.syncHost(host);
    return removed;
  }
  keep(host: Host, { sessionKey, agentId }: Scope, item: ChatQueueItem, retryable = false): void {
    const scope = { sessionKey, agentId };
    const state = this.state(host);
    const key = storedChatOutboxScopeKey(scope);
    const queue = (state.byScope.get(key)?.queue ?? []).filter((entry) => entry.id !== item.id);
    queue.push(applyStoredChatOutboxScope(item, scope));
    queue.sort(compareChatQueueOrder);
    state.byScope.set(key, { scope, queue });
    if (retryable) {
      state.retryable.add(item.id);
    }
    this.syncHost(host);
  }
  private local(state: HostProjection, id: string) {
    for (const { scope, queue } of state.byScope.values()) {
      const index = queue.findIndex((item) => item.id === id);
      if (index >= 0) {
        return { scope, queue, index };
      }
    }
    return undefined;
  }
  change(
    host: Host,
    id: string,
    update?: (item: ChatQueueItem) => ChatQueueItem,
    retryable = false,
  ): ChatQueueItem | null {
    const state = this.state(host);
    const match = this.local(state, id);
    if (!match) {
      this.prune(host);
      return null;
    }
    const current = match.queue[match.index]!;
    if (update) {
      const next = update(current);
      match.queue[match.index] = next;
      if (retryable) {
        state.retryable.add(id);
      }
      this.syncHost(host);
      return next;
    }
    state.retryable.delete(id);
    const stored = this.durable(host, id)?.queue.find((item) => item.id === id);
    if (stored) {
      state.durableSeen.add(id);
      match.queue[match.index] = this.project(stored, current);
    } else {
      match.queue.splice(match.index, 1);
    }
    this.syncHost(host);
    return current;
  }
  update(
    host: Host,
    updates: readonly { id: string; update: (item: ChatQueueItem) => ChatQueueItem }[],
  ): Array<ChatQueueItem | null> | null {
    const rows: Array<{
      item: ChatQueueItem;
      scope: Scope;
      durable?: ChatQueueItem;
      next: ChatQueueItem;
    }> = [];
    for (const { id, update } of updates) {
      const located = this.locate(host, id);
      if (!located) {
        return null;
      }
      rows.push({ ...located, next: update(located.item) });
    }
    const durableRows = rows.filter((row) => row.durable);
    const outboxScope = durableRows[0]?.scope;
    // A reorder commits every captured row together before publishing any local changes.
    const applied =
      !outboxScope ||
      updateStoredChatComposerQueueItems(
        host,
        outboxScope.sessionKey,
        durableRows.map(({ item, next }) => ({ expected: item, next })),
        outboxScope.agentId,
      );
    for (const { item, scope, next } of durableRows) {
      const live = next.sendState === "sending" || next.sendState === "executing-command";
      if (applied) {
        if (next.sendState === "waiting-model") {
          this.keep(host, scope, next);
        } else {
          this.change(host, item.id);
        }
        this.projectLive(host, scope, item.id, live ? next : undefined);
      } else if (live) {
        this.syncHost(host);
      } else {
        this.projectLive(host, scope, item.id);
      }
    }
    if (!applied) {
      return null;
    }
    return rows.map(({ item, durable, next }) =>
      durable ? next : this.change(host, item.id, () => next),
    );
  }
  admit(
    host: Host,
    captured: ReturnType<typeof captureChatOutboxAdmission>,
    item: ChatQueueItem,
    replaces?: StoredChatQueueReplacement,
  ) {
    this.keep(host, captured.scope, item);
    const result = admitStoredChatComposerQueueItemResult(host, captured, item, replaces);
    if (result === "admitted" && item.sendState !== "waiting-model") {
      this.change(host, item.id);
    }
    return result;
  }
  remove(host: Host, id: string, options?: { discard?: boolean }): ChatQueueItem | null {
    const located = this.locate(host, id);
    const durable = located?.durable;
    const local = host.chatQueue.find((item) => item.id === id);
    const live = located && this.readLive(storedChatOutboxScopeKey(located.scope), id, durable);
    if (
      (live &&
        live.owner !== host &&
        !(local && durable && LIVE_VERSION_KEYS.every((key) => local[key] === durable[key]))) ||
      (located?.durable &&
        !removeStoredChatComposerQueueItem(
          host,
          located.scope.sessionKey,
          id,
          located.item,
          located.scope.agentId,
        ))
    ) {
      this.syncHost(host);
      return null;
    }
    if (located) {
      this.projectLive(host, located.scope, id);
      this.change(host, id);
    }
    this.publish(undefined, true);
    if (located && options?.discard) {
      // Row disappearance also means ACK retirement. Only successful explicit
      // discard invalidates admission presentation in every subscribed pane.
      for (const pane of this.panes) {
        subscriptions.get(pane)?.onDiscard?.(located.item);
      }
    }
    return located?.item ?? null;
  }
  hasVolatile(host: Host, id: string): boolean {
    return this.hosts.get(host)?.retryable.has(id) ?? false;
  }
  // Panes share this outbox and its drain while composer state stays per pane, so
  // a pane-local fact that blocks delivery has to be answerable from any of them.
  anyPane(matches: (host: Host) => boolean): boolean {
    for (const pane of this.panes) {
      if (matches(pane)) {
        return true;
      }
    }
    return false;
  }
  hasPendingSubmission(scope: Scope, item: ChatQueueItem): boolean {
    return Boolean(
      this.readLive(storedChatOutboxScopeKey(scope), item.id, item)?.submissionIsCurrent,
    );
  }
  /** Inbox reads delivery state, not the reload-safe aliases stored during live work. */
  needsReview(scope: Scope, item: ChatQueueItem): boolean {
    const key = storedChatOutboxScopeKey(scope);
    if (this.readLive(key, item.id, item)) {
      return false;
    }
    for (const state of this.hosts.values()) {
      if (
        state.byScope
          .get(key)
          ?.queue.some((local) => local.id === item.id && local.sendState === "waiting-model")
      ) {
        return false;
      }
    }
    return !item.pendingRunId && (item.sendState === "failed" || item.sendState === "unconfirmed");
  }
  beginSubmission(
    host: Host,
    id: string,
    options: { inline: boolean; isCurrent: () => boolean },
  ): { release(): void } | undefined {
    const located = this.locate(host, id);
    if (
      !located?.durable ||
      located.item.sendState !== "waiting-idle" ||
      located.durable.sendState !== "waiting-idle" ||
      !located.item.sendRunId ||
      (located.item.sendAttempts ?? 0) !== 0 ||
      located.item.sendRequestStartedAtMs !== undefined
    ) {
      return undefined;
    }
    const key = storedChatOutboxScopeKey(located.scope);
    const entries = this.live.get(key) ?? new Map<string, LiveProjection>();
    const projection: LiveProjection = {
      item: options.inline ? { ...located.item, sendState: "submitting" } : located.item,
      owner: host,
      expectedDurableVersion: located.durable,
      submissionIsCurrent: options.isCurrent,
    };
    entries.set(id, projection);
    this.live.set(key, entries);
    this.publish(host);
    return {
      release: () => {
        if (this.live.get(key)?.get(id) !== projection) {
          return;
        }
        this.projectLive(host, located.scope, id);
      },
    };
  }
  private projectLive(host: Host, scope: Scope, id: string, item?: ChatQueueItem): void {
    const key = storedChatOutboxScopeKey(scope);
    const live = this.live.get(key) ?? new Map<string, LiveProjection>();
    if (item) {
      live.set(id, { item, owner: host });
      this.live.set(key, live);
    } else {
      live.delete(id);
      if (!live.size) {
        this.live.delete(key);
      }
    }
    this.publish(host);
    this.prune(host);
  }
  allItems(host: Host): ChatQueueItem[] {
    const durable = listStoredChatOutboxes(host).flatMap((outbox) =>
      this.snapshot(host, outbox, outbox.queue),
    );
    const local = [...this.state(host).byScope.values()].flatMap(({ queue }) => queue);
    // The snapshot already merges durable and live state. A stale pane-local
    // copy must not hide its sending overlay during connection retirement.
    const items = new Map([...local, ...durable].map((item) => [item.id, item]));
    this.prune(host);
    return [...items.values()];
  }
  private prune(host: Host): void {
    const state = this.hosts.get(host);
    if (state && !this.panes.has(host)) {
      const active = [...state.byScope.values()].some(({ queue }) =>
        queue.some((item) => isActiveLocal(state, item)),
      );
      if (!active && !this.live.size) {
        this.hosts.delete(host);
      }
    }
    if (!this.unsubscribe && !this.live.size && !this.hosts.size) {
      // Defer eviction until a synchronous send transition can add its live overlay.
      queueMicrotask(() => {
        if (
          !this.unsubscribe &&
          !this.live.size &&
          !this.hosts.size &&
          owners.get(this.ownerGatewayKey) === this
        ) {
          owners.delete(this.ownerGatewayKey);
        }
      });
    }
  }
}
const owners = new Map<string, ChatOutboxGatewayOwner>();
const subscriptions = new WeakMap<
  Composer,
  { owner: ChatOutboxGatewayOwner; onDiscard?: (item: ChatQueueItem) => void }
>();
function outboxOwnerKey(host: Composer): string {
  const storage = getSafeSessionStorage();
  if (storage && !storageIds.has(storage)) {
    storageIds.set(storage, ++nextStorageId);
  }
  const key = `${storage ? storageIds.get(storage) : 0}\u0000${host.settings?.gatewayUrl?.trim() || "default"}\u0000${host.client?.recoveryScope ?? ""}`;
  return key;
}
export function chatOutboxOwner(host: Composer): ChatOutboxGatewayOwner {
  const key = outboxOwnerKey(host);
  const owner = owners.get(key) ?? new ChatOutboxGatewayOwner(key);
  owners.set(key, owner);
  owner.adoptSubscriptions(host);
  return owner;
}

/** Read-only view of the existing tab/Gateway outbox; it does not claim a personal owner. */
export function listChatOutboxAttention(host: Composer) {
  if (!observeOutboxRecoveryOwner(host)) {
    return [];
  }
  const owner = owners.get(outboxOwnerKey(host));
  return listStoredChatOutboxes(host).flatMap((outbox) =>
    outbox.queue
      .filter((item) =>
        owner
          ? owner.needsReview(outbox, item)
          : !item.pendingRunId && (item.sendState === "failed" || item.sendState === "unconfirmed"),
      )
      .map((item) => ({
        id: item.id,
        sessionKey: outbox.sessionKey,
        agentId: outbox.agentId,
        unconfirmed: item.sendState === "unconfirmed",
        command: Boolean(item.localCommandName),
      })),
  );
}
