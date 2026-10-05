import { readOfflineStorageScope } from "../../app/boot-record.ts";
import { chatQueueOrderKey, compareChatQueueOrder } from "../../lib/chat/chat-queue-order.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  outboxPayloadMatchesOwner,
  outboxStorageScope,
} from "../../lib/chat/outbox-payload-store.runtime.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import { readStoredChatOutbox } from "../../lib/chat/outbox-store-projection.ts";
import type { StoredChatOutboxScope as Scope } from "../../lib/chat/outbox-store-scope.ts";
import {
  applyStoredChatOutboxScope,
  subscribeStoredChatOutboxChanges,
  type captureChatOutboxAdmission,
} from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { getSafeSessionStorage } from "../../local-storage.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import {
  projectChatOutboxItem,
  isActiveLocal,
  projectChatOutboxAttention,
  type ChatOutboxHostProjection as HostProjection,
} from "./chat-outbox-owner.projection.ts";
import type { StoredChatQueueReplacement } from "./composer-persistence-state.ts";
import {
  admitStoredChatComposerQueueItemResult,
  listStoredChatOutboxes,
  removeStoredChatComposerQueueItem,
  updateStoredChatComposerQueueItem,
  updateStoredChatComposerQueueItems,
  storedChatOutboxScopeKey,
  type ChatComposerScope as Composer,
} from "./composer-persistence.ts";
import {
  captureOutboxPayloadOwner,
  failOutboxPayload,
  prepareOutboxPayload,
} from "./outbox-payloads.ts";
type Host = Composer & { chatQueue: ChatQueueItem[]; sessionKey: string; requestUpdate?(): void };
type LiveProjection = {
  item: ChatQueueItem;
  owner: Host;
  expectedDurableVersion?: ChatQueueItem;
  submissionIsCurrent?: () => boolean;
};
const LIVE_VERSION_KEYS = ["sendRunId", "sendAttempts", "sendState", "sendError"] as const;
const storageIds = new WeakMap<Storage, number>();
let nextStorageId = 0;
// One gateway owner merges durable, live, and pane-local rows for every subscribed pane.
class ChatOutboxGatewayOwner {
  private readonly hosts = new Map<Host, HostProjection>();
  private readonly panes = new Set<Host>();
  private readonly live = new Map<string, Map<string, LiveProjection>>();
  private readonly hydrating = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  constructor(readonly ownerGatewayKey: string) {}
  private state(host: Host): HostProjection {
    const previous = hostOwners.get(host);
    if (previous && previous !== this) {
      previous.retireHost(host);
    }
    hostOwners.set(host, this);
    const existing = this.hosts.get(host);
    if (existing) {
      return existing;
    }
    host.chatQueue = host.chatQueue.filter((item) => outboxPayloadMatchesOwner(host, item));
    const scope = resolveUiConversationIdentity(host, host.sessionKey);
    const durableSeen = new Set(readStoredChatOutbox(host, scope)?.queue.map((item) => item.id));
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
  private retireHost(host: Host): void {
    const state = this.hosts.get(host);
    if (state) {
      const retained = new Set<string>();
      for (const [key, local] of state.byScope) {
        // Retryable memory custody has no reload-safe source. Keep its bytes with
        // this opaque owner, never its retired operation or a durable overlay.
        local.queue = local.queue
          .filter(
            (item) =>
              state.retryable.has(item.id) &&
              !state.durableSeen.has(item.id) &&
              !item.pendingRunId &&
              !item.localCommandName,
          )
          .map((item) => {
            retained.add(item.id);
            return item.sendState === "failed" || item.sendState === "unconfirmed"
              ? item
              : Object.assign({}, item, { sendState: "held" as const });
          });
        if (!local.queue.length) {
          state.byScope.delete(key);
        }
      }
      state.retryable = retained;
      if (!state.byScope.size) {
        this.hosts.delete(host);
      }
    }
    for (const [key, entries] of this.live) {
      for (const [id, entry] of entries) {
        if (entry.owner === host) {
          entries.delete(id);
        }
      }
      if (!entries.size) {
        this.live.delete(key);
      }
    }
    this.prune(host);
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
  private observeDurable(id: string): void {
    // Admission supersedes every retained copy, even an offscreen pane now using
    // another account. Subsequent canonical removal must not resurrect its bytes.
    for (const [pane, projection] of this.hosts) {
      if (projection.retryable.delete(id)) {
        projection.durableSeen.add(id);
        const custody = this.local(projection, id);
        custody?.queue.splice(custody.index, 1);
        if (hostOwners.get(pane) !== this) {
          this.prune(pane);
        }
      }
    }
  }
  snapshot(
    host: Host,
    scope: Scope,
    durable = readStoredChatOutbox(host, scope)?.queue ?? [],
  ): ChatQueueItem[] {
    const key = storedChatOutboxScopeKey(scope);
    const state = this.state(host);
    const local = state.byScope.get(key)?.queue ?? [];
    const visible = durable.map((item) => {
      state.durableSeen.add(item.id);
      this.observeDurable(item.id);
      const pending = local.find((entry) => entry.id === item.id);
      const live = this.readLive(key, item.id, item)?.item;
      return pending?.pendingRunId || pending?.sendState === "waiting-model"
        ? pending
        : live && live.sendRunId === item.sendRunId
          ? live
          : pending && pending.sendRunId === item.sendRunId
            ? projectChatOutboxItem(item, pending)
            : item;
    });
    const durableIds = new Set(durable.map((item) => item.id));
    visible.push(...local.filter((item) => !durableIds.has(item.id) && isActiveLocal(state, item)));
    this.prune(host);
    return visible
      .filter((item) => outboxPayloadMatchesOwner(host, item))
      .toSorted(compareChatQueueOrder);
  }
  syncHost(host: Host, options: { requestUpdate?: boolean } = {}): void {
    if (this.ownerGatewayKey !== outboxOwnerKey(host)) {
      chatOutboxOwner(host).syncHost(host, options);
      return;
    }
    readOfflineStorageScope(host);
    const queue = this.snapshot(host, resolveUiConversationIdentity(host, host.sessionKey));
    // Draft persistence also publishes outbox changes; an empty queue must not
    // invalidate the transcript merely because the composer changed.
    if (queue.length || host.chatQueue.length) {
      host.chatQueue = queue;
    }
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
      previous.retireHost(pane);
      hostOwners.delete(pane);
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
    durableIds.forEach((id) => {
      state.durableSeen.add(id);
      this.observeDurable(id);
    });
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
  keep(
    host: Host,
    { sessionKey, agentId }: Scope,
    item: ChatQueueItem,
    retryable = false,
  ): ChatQueueItem {
    const scope = { sessionKey, agentId };
    const state = this.state(host);
    const key = storedChatOutboxScopeKey(scope);
    const retained = [
      ...(readStoredChatOutbox(host, scope)?.queue ?? []),
      ...[...this.hosts.values()].flatMap(
        (projection) =>
          projection.byScope.get(key)?.queue.filter((entry) => isActiveLocal(projection, entry)) ??
          [],
      ),
    ];
    const existing = retained.find((entry) => entry.id === item.id);
    const tail = Math.max(...retained.map(chatQueueOrderKey));
    // Position belongs to admission, not to clocks, storage timing, or later state updates.
    const orderKey = existing
      ? existing.orderKey
      : (item.orderKey ?? (item.createdAt <= tail ? tail + 1 : undefined));
    const positioned = applyStoredChatOutboxScope(
      { ...item, storageScope: item.storageScope ?? outboxStorageScope(host) },
      scope,
    );
    if (!outboxPayloadMatchesOwner(host, positioned)) {
      return positioned;
    }
    if (orderKey === undefined) {
      delete positioned.orderKey;
    } else {
      positioned.orderKey = orderKey;
    }
    const queue = [...(state.byScope.get(key)?.queue ?? [])];
    const index = queue.findIndex((entry) => entry.id === item.id);
    if (index < 0) {
      queue.push(positioned);
    } else {
      queue[index] = positioned;
    }
    queue.sort(compareChatQueueOrder);
    state.byScope.set(key, { scope, queue });
    if (retryable) {
      state.retryable.add(item.id);
    }
    this.syncHost(host);
    return positioned;
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
      match.queue[match.index] = projectChatOutboxItem(stored, current);
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
    // Validate the captured admission before keep() can publish a local row.
    if (outboxStorageScope(host) !== JSON.stringify([captured.gatewayOwner, captured.owner])) {
      return "storage-failed";
    }
    const positioned = this.keep(host, captured.scope, item);
    const result = admitStoredChatComposerQueueItemResult(host, captured, positioned, replaces);
    if (result === "admitted") {
      this.observeDurable(item.id);
      if (item.sendState !== "waiting-model") {
        this.change(host, item.id);
      }
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
    return (
      !item.pendingRunId &&
      (item.sendState === "failed" || item.sendState === "unconfirmed" || item.sendState === "held")
    );
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
    return [...items.values()].filter((item) => outboxPayloadMatchesOwner(host, item));
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
const hostOwners = new WeakMap<Host, ChatOutboxGatewayOwner>();
const subscriptions = new WeakMap<
  Composer,
  { owner: ChatOutboxGatewayOwner; onDiscard?: (item: ChatQueueItem) => void }
>();
function outboxOwnerKey(host: Composer): string {
  const storage = getSafeSessionStorage();
  if (storage && !storageIds.has(storage)) {
    storageIds.set(storage, ++nextStorageId);
  }
  return `${storage ? storageIds.get(storage) : 0}\u0000${host.settings?.gatewayUrl?.trim() || "default"}\u0000${readOfflineStorageScope(host) ?? ""}`;
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
  if (!readOfflineStorageScope(host)) {
    return [];
  }
  const owner = owners.get(outboxOwnerKey(host));
  return projectChatOutboxAttention(listStoredChatOutboxes(host), owner);
}
