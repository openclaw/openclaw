import { readOfflineStorageScope } from "../../app/boot-record.ts";
import { compareChatQueueOrder } from "../../lib/chat/chat-queue-order.ts";
import type { ChatQueueItem } from "../../lib/chat/chat-types.ts";
import {
  chatOutboxAttentionOwners,
  notifyChatOutboxAttentionChanges,
  outboxOwnerKey,
  storedChatOutboxItemNeedsReview,
} from "../../lib/chat/outbox-owner-registry.ts";
import {
  outboxPayloadMatchesOwner,
  outboxStorageScope,
} from "../../lib/chat/outbox-payload-store.runtime.ts";
import { sameQueuedDeliveryVersion } from "../../lib/chat/outbox-store-codec.ts";
import {
  readStoredChatOutbox as read,
  listStoredChatOutboxes as listOutboxes,
} from "../../lib/chat/outbox-store-projection.ts";
import {
  type StoredChatOutboxScope as Scope,
  storedChatOutboxScopeKey,
} from "../../lib/chat/outbox-store-scope.ts";
import {
  subscribeStoredChatOutboxChanges,
  type captureChatOutboxAdmission,
  type ChatComposerScope,
} from "../../lib/chat/outbox-store.ts";
import { resolveUiConversationIdentity } from "../../lib/sessions/session-key.ts";
import { getChatAttachmentDataUrl } from "./attachment-payload-store.ts";
import { ChatOutboxAdmissions } from "./chat-outbox-admissions.ts";
import {
  projectChatOutboxItem,
  isActiveLocal,
  hasActiveChatOutboxProjection,
  hasWaitingModelProjection,
  reconcileChatOutboxProjection,
  retainedOutboxAttachmentIds,
  locateLocalOutboxItem,
  positionChatOutboxItem,
  type ChatOutboxLiveProjection,
  type ChatOutboxHost as Host,
  type ChatOutboxHostProjection as HostProjection,
} from "./chat-outbox-owner.projection.ts";
import { publishChatOutboxQueue, replaceChatOutboxQueue } from "./chat-outbox-queue.ts";
import {
  protectChatOutboxFromReload,
  type ChatOutboxReloadBinding,
  type CapturedChatOutboxInput,
} from "./chat-outbox-reload-recovery.ts";
import {
  type StoredChatQueueReplacement,
  admitStoredChatComposerQueueItemResult,
  updateStoredChatComposerQueueItems,
} from "./composer-queue-persistence.ts";
import {
  captureOutboxPayloadOwner,
  failOutboxPayload,
  prepareOutboxPayload,
} from "./outbox-payloads.ts";

type Composer = ChatComposerScope & { outboxRecovery?: ChatOutboxReloadBinding };
type LiveProjection = ChatOutboxLiveProjection<Host>;
type VolatileInput = { scope: Scope; item: ChatQueueItem; owner: Host };
const LIVE_VERSION_KEYS = ["sendRunId", "sendAttempts", "sendState", "sendError"] as const;
// One gateway owner merges durable, live, and pane-local rows for every subscribed pane.
class ChatOutboxGatewayOwner {
  readonly admissions = new ChatOutboxAdmissions(() => this.prune());
  attentionRevision = 0;
  private readonly hosts = new Map<Host, HostProjection>();
  private readonly panes = new Set<Host>();
  private readonly live = new Map<string, Map<string, LiveProjection>>();
  private readonly volatile = new Map<string, VolatileInput>();
  private readonly hydrating = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  // Custody outlives panes and account switches; recovery uses the live application binding.
  readonly reloadRecovery = protectChatOutboxFromReload({
    ownerKey: () => this.ownerGatewayKey,
    inputs: this.volatile,
    discard: (captured) =>
      this.remove(captured.entry.owner, captured.item.id, { discard: true, captured }),
    retainedAttachmentIds: () => {
      const ids = new Set<string>();
      for (const owner of owners.values()) {
        for (const id of retainedOutboxAttachmentIds(owner.hosts, owner.live, owner.volatile)) {
          ids.add(id);
        }
      }
      return ids;
    },
  });
  constructor(readonly ownerGatewayKey: string) {}
  private publishAttention(): void {
    this.reloadRecovery.changed();
    this.attentionRevision += 1;
    notifyChatOutboxAttentionChanges(this.ownerGatewayKey);
  }
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
    const durableSeen = new Set(read(host, scope)?.queue.map((item) => item.id));
    const created: HostProjection = { byScope: new Map(), durableSeen };
    // Bootstrap caller-owned input once. Later host queues are projections and
    // cannot reacquire custody after the canonical item was retired.
    if (!previous && host.chatQueue.length) {
      created.byScope.set(storedChatOutboxScopeKey(scope), {
        scope,
        queue: host.chatQueue.filter(
          (item) => !this.volatile.has(item.id) && outboxPayloadMatchesOwner(host, item),
        ),
      });
    }
    this.hosts.set(host, created);
    return created;
  }
  private retireHost(host: Host): void {
    this.admissions.cancelRequests(host);
    this.hosts.delete(host);
    // Custody belongs to this account, not its retired pane or transport. Bound
    // attempts can replay with their original key; interrupted preparation cannot.
    for (const entry of this.volatile.values()) {
      if (entry.owner === host && !["failed", "held"].includes(entry.item.sendState ?? "")) {
        entry.item = {
          ...entry.item,
          sendState:
            entry.item.sendRunId && entry.item.sessionId && entry.item.sendState !== "waiting-model"
              ? "waiting-reconnect"
              : "held",
        };
      }
    }
    for (const [key, entries] of this.live) {
      for (const [id, entry] of entries) {
        if (entry.owner === host) {
          entries.delete(id);
        }
      }
      this.pruneLiveScope(key, entries);
    }
    this.prune(host);
    this.publishAttention();
  }
  durable(host: Composer, id: string) {
    return listOutboxes(host).find(({ queue }) => queue.some((item) => item.id === id));
  }
  locate(host: Host, id: string) {
    const outbox = this.durable(host, id);
    const captured =
      outbox ?? this.volatile.get(id)?.scope ?? locateLocalOutboxItem(this.state(host), id)?.scope;
    if (!captured) {
      return undefined;
    }
    const scope = { sessionKey: captured.sessionKey, agentId: captured.agentId };
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
      this.pruneLiveScope(key, entries);
      return undefined;
    }
    return live;
  }
  private pruneLiveScope(key: string, entries: ReadonlyMap<string, LiveProjection>): void {
    if (!entries.size) {
      this.live.delete(key);
    }
  }
  private observeDurable(id: string): void {
    this.admissions.release(id);
    // Admission supersedes every retained copy, even an offscreen pane now using
    // another account. Subsequent canonical removal must not resurrect its bytes.
    if (this.volatile.delete(id)) {
      for (const [pane, projection] of this.hosts) {
        projection.durableSeen.add(id);
        const custody = locateLocalOutboxItem(projection, id);
        custody?.queue.splice(custody.index, 1);
        if (hostOwners.get(pane) !== this) {
          this.prune(pane);
        }
      }
    }
  }
  snapshot(host: Host, scope: Scope, durable = read(host, scope)?.queue ?? []): ChatQueueItem[] {
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
    for (const entry of this.volatile.values()) {
      if (storedChatOutboxScopeKey(entry.scope) === key && !durableIds.has(entry.item.id)) {
        visible.push(entry.item);
      }
    }
    this.prune(host);
    return visible
      .filter((item) => outboxPayloadMatchesOwner(host, item))
      .toSorted(compareChatQueueOrder);
  }
  syncHost(host: Host, options: { notify?: boolean } = {}): void {
    if (this.ownerGatewayKey !== outboxOwnerKey(host)) {
      chatOutboxOwner(host).syncHost(host, options);
      return;
    }
    readOfflineStorageScope(host);
    const previousQueue = host.chatQueue;
    const queue = this.snapshot(host, resolveUiConversationIdentity(host, host.sessionKey));
    // Draft persistence also publishes outbox changes; an empty queue must not
    // invalidate the transcript merely because the composer changed.
    if (queue.length || previousQueue.length) {
      replaceChatOutboxQueue(host, queue, options.notify);
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
              if (
                !updateStoredChatComposerQueueItems(
                  host,
                  outbox.sessionKey,
                  [{ expected: item, next: { ...current, ...result.update } }],
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
                  }
                : {}),
            });
          } else {
            updateStoredChatComposerQueueItems(
              host,
              outbox.sessionKey,
              [{ expected: current, next: failOutboxPayload(current, result.reason) }],
              outbox.agentId,
            );
          }
          this.publish(host);
        })
        .finally(() => this.hydrating.delete(key));
    }
    this.publishAttention();
  }
  publish(origin?: Host, reconcile = false): void {
    // Recovery may retire custody whose original pane now belongs to another account.
    if (origin && outboxOwnerKey(origin) === this.ownerGatewayKey) {
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
    const adopted: Host[] = [];
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
      adopted.push(pane);
    }
    if (adopted.length) {
      // Publish only after every peer has moved, preserving shared edit holds.
      this.publish();
      adopted.filter((pane) => !pane.chatQueue.length).forEach(publishChatOutboxQueue);
    }
  }
  private attach(host: Host): void {
    this.panes.add(host);
    this.unsubscribe ??= subscribeStoredChatOutboxChanges(() => this.publish(undefined, true));
  }
  private detach(host: Host): void {
    this.admissions.cancelRequests(host);
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
    this.syncHost(host, { notify: false });
    return () => {
      if (subscriptions.get(host) !== subscription) {
        return;
      }
      subscriptions.delete(host);
      subscription.owner.detach(host);
    };
  }
  private reconcile(host: Host, state: HostProjection): void {
    const outboxes = listOutboxes(host);
    const durableIds = new Set(outboxes.flatMap((outbox) => outbox.queue.map((item) => item.id)));
    reconcileChatOutboxProjection(state, durableIds, (id) => this.observeDurable(id));
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
      this.volatile.delete(item.id);
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
      ...(read(host, scope)?.queue ?? []),
      ...[...this.volatile.values()]
        .filter((entry) => storedChatOutboxScopeKey(entry.scope) === key)
        .map((entry) => entry.item),
      ...[...this.hosts.values()].flatMap(
        (projection) =>
          projection.byScope.get(key)?.queue.filter((entry) => isActiveLocal(projection, entry)) ??
          [],
      ),
    ];
    const positioned = positionChatOutboxItem(host, scope, item, retained);
    if (!outboxPayloadMatchesOwner(host, positioned)) {
      return positioned;
    }
    if (retryable || this.volatile.has(item.id)) {
      const local = locateLocalOutboxItem(state, item.id);
      local?.queue.splice(local.index, 1);
      this.volatile.set(item.id, { scope, item: positioned, owner: host });
      this.publish(host);
      return positioned;
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
    this.syncHost(host);
    return positioned;
  }
  change(
    host: Host,
    id: string,
    update?: (item: ChatQueueItem) => ChatQueueItem,
    retryable = false,
  ): ChatQueueItem | null {
    const volatile = this.volatile.get(id);
    if (volatile) {
      const current = volatile.item;
      if (update) {
        volatile.item = update(current);
        volatile.owner = host;
      } else {
        this.volatile.delete(id);
      }
      this.publishAttention();
      this.publish(host);
      this.prune();
      return update ? volatile.item : current;
    }
    const state = this.state(host);
    const match = locateLocalOutboxItem(state, id);
    if (!match) {
      this.prune(host);
      return null;
    }
    const current = match.queue[match.index]!;
    if (update) {
      const next = update(current);
      if (retryable) {
        return this.keep(host, match.scope, next, true);
      }
      match.queue[match.index] = next;
      this.syncHost(host);
      return next;
    }
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
  remove(
    host: Host,
    id: string,
    options?: { discard?: boolean; captured?: CapturedChatOutboxInput<VolatileInput> },
  ): ChatQueueItem | null {
    const captured = options?.captured;
    if (
      captured &&
      (this.volatile.get(id) !== captured.entry ||
        captured.entry.item !== captured.item ||
        [...owners.values()].some((owner) =>
          owner.anyPane((pane) => pane.chatQueuedEdit?.id === id),
        ))
    ) {
      return null;
    }
    const located = captured
      ? { scope: captured.entry.scope, item: captured.item, durable: undefined }
      : this.locate(host, id);
    const durable = located?.durable;
    const local = host.chatQueue.find((item) => item.id === id);
    const live = located && this.readLive(storedChatOutboxScopeKey(located.scope), id, durable);
    if (
      (live &&
        live.owner !== host &&
        !(local && durable && LIVE_VERSION_KEYS.every((key) => local[key] === durable[key]))) ||
      (located?.durable &&
        !updateStoredChatComposerQueueItems(
          host,
          located.scope.sessionKey,
          [{ expected: located.item, next: null }],
          located.scope.agentId,
        ))
    ) {
      this.syncHost(host);
      return null;
    }
    if (located) {
      this.admissions.release(id);
      this.projectLive(host, located.scope, id);
      this.change(host, id);
    }
    this.publish(undefined, true);
    if (located && options?.discard) {
      this.admissions.cancelRequests(host, located.scope, located.item.sendRunId);
      // Row disappearance also means ACK retirement. Only successful explicit
      // discard invalidates admission presentation in every subscribed pane.
      for (const pane of this.panes) {
        subscriptions.get(pane)?.onDiscard?.(located.item);
      }
    }
    return located?.item ?? null;
  }
  hasVolatile(_host: Host, id: string): boolean {
    return this.volatile.has(id);
  }
  // Panes share this outbox and its drain while composer state stays per pane, so
  // a pane-local fact that blocks delivery has to be answerable from any of them.
  anyPane(matches: (host: Host) => boolean): boolean {
    return [...this.panes].some(matches);
  }
  hasPendingSubmission(scope: Scope, item: ChatQueueItem): boolean {
    const live = this.readLive(storedChatOutboxScopeKey(scope), item.id, item);
    return Boolean(live?.submissionIsCurrent);
  }
  /** Attention reads delivery state, not the reload-safe aliases stored during live work. */
  needsReview(scope: Scope, item: ChatQueueItem): boolean {
    const key = storedChatOutboxScopeKey(scope);
    return (
      !this.readLive(key, item.id, item) &&
      !hasWaitingModelProjection(this.hosts.values(), key, item.id) &&
      storedChatOutboxItemNeedsReview(item)
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
      this.pruneLiveScope(key, live);
    }
    this.publish(host);
    this.prune(host);
  }
  allItems(host: Host): ChatQueueItem[] {
    const durable = listOutboxes(host).flatMap((outbox) =>
      this.snapshot(host, outbox, outbox.queue),
    );
    const local = [...this.state(host).byScope.values()].flatMap(({ queue }) => queue);
    // The snapshot already merges durable and live state. A stale pane-local
    // copy must not hide its sending overlay during connection retirement.
    const items = new Map(
      [...local, ...durable, ...[...this.volatile.values()].map((entry) => entry.item)].map(
        (item) => [item.id, item],
      ),
    );
    this.prune(host);
    return [...items.values()].filter((item) => outboxPayloadMatchesOwner(host, item));
  }
  private prune(host?: Host): void {
    const state = host ? this.hosts.get(host) : undefined;
    if (host && state && !this.panes.has(host)) {
      if (!hasActiveChatOutboxProjection(state) && !this.live.size) {
        this.hosts.delete(host);
      }
    }
    const empty = () =>
      !this.unsubscribe &&
      !this.live.size &&
      !this.hosts.size &&
      !this.volatile.size &&
      !this.admissions.hasRequests;
    if (empty()) {
      // Defer eviction until a synchronous send transition can add its live overlay.
      queueMicrotask(() => {
        if (empty() && owners.get(this.ownerGatewayKey) === this) {
          owners.delete(this.ownerGatewayKey);
          chatOutboxAttentionOwners.delete(this.ownerGatewayKey);
          this.reloadRecovery.dispose();
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
export function chatOutboxOwner(host: Composer): ChatOutboxGatewayOwner {
  const key = outboxOwnerKey(host);
  const owner = owners.get(key) ?? new ChatOutboxGatewayOwner(key);
  owners.set(key, owner);
  chatOutboxAttentionOwners.set(key, owner);
  owner.reloadRecovery.bind(host.outboxRecovery);
  owner.adoptSubscriptions(host);
  return owner;
}
