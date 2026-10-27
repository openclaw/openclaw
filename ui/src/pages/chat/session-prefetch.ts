import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { onCleanup } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import type { AgentCapability } from "../../lib/agents/index.ts";
import { listen } from "../../lib/reactive/listener.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import {
  CHAT_PANE_LIFECYCLE_CHANGED_EVENT,
  CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT,
} from "./chat-history-events.ts";
import { requestChatSessionSnapshot } from "./chat-history-request.ts";
import { chatPanesWithin } from "./chat-pane-elements.ts";
import { getSessionCacheValue, MAX_CACHED_CHAT_SESSIONS } from "./session-cache.ts";
import {
  appendChatMessageToCache,
  cacheChatSessionSnapshot,
  projectChatTranscriptMetadata,
  readChatSessionSnapshot,
  type ChatMessageCache,
  type ChatSessionSnapshot,
} from "./session-message-cache.ts";
import { resolveChatSnapshotKey, resolveChatSnapshotSessionKey } from "./session-snapshot-key.ts";
import type { SessionSnapshotStore } from "./session-snapshot-store.ts";

// Coalesce navigation intent while leaving time to warm history before a click.
const SESSION_PREFETCH_INTENT_DELAY_MS = 75;
const SESSION_PREFETCH_COOLDOWN_MS = 30_000;

type ChatSnapshotKeyHost = Parameters<typeof resolveChatSnapshotKey>[0];

type SessionPrefetchContext = {
  readonly gateway: {
    readonly connection?: { gatewayUrl: string };
    readonly snapshot: Pick<ApplicationGatewaySnapshot, "assistantAgentId" | "hello"> &
      Partial<Pick<ApplicationGatewaySnapshot, "client">>;
    subscribe: (listener: () => void) => () => void;
  };
  readonly agents: { readonly state: Pick<AgentCapability["state"], "agentsList"> };
  readonly sessions: Pick<
    SessionCapability,
    "captureConnectionScope" | "isConnectionScopeCurrent" | "canonicalListRevision"
  > & {
    readonly state: { readonly result: { readonly sessions: readonly GatewaySessionRow[] } | null };
    subscribe: (listener: () => void) => () => void;
  };
};

type SessionPrefetchSnapshot = {
  client: GatewayBrowserClient | null;
  isCurrent: () => boolean;
  listRevision: number;
  openSessionKeys: readonly string[];
  intentSessionKey: string | null;
  /** False while a presented pane is still fetching its transcript. */
  presentedTranscriptsReady: boolean;
  rows: readonly GatewaySessionRow[] | null;
  snapshotHost: ChatSnapshotKeyHost;
};

type SessionPrefetchCandidate = {
  sessionKey: string;
  snapshotKey: string;
  canonicalSessionKey: string;
  sessionId: GatewaySessionRow["sessionId"];
};

function mayPrefetchHistory(
  snapshot: SessionPrefetchSnapshot | null,
  sessionKey?: string,
): boolean {
  return (
    snapshot?.presentedTranscriptsReady === true &&
    Boolean(snapshot.intentSessionKey && (!sessionKey || snapshot.intentSessionKey === sessionKey))
  );
}

// Synchronous request/cache owner; the page adapter below owns its lifetime.
class SessionPrefetcher {
  private connected = false;
  private snapshot: SessionPrefetchSnapshot | null = null;
  private readonly lastAttemptAt = new Map<string, number>();
  private delayTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private delayDeadline: number | null = null;
  private running = false;
  private rescheduleDelayMs: number | null = null;
  private stopVisibility: (() => void) | undefined;

  constructor(
    private readonly cache: ChatMessageCache,
    private readonly snapshotStore: SessionSnapshotStore,
  ) {}

  connect(): void {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.stopVisibility = listen(document, "visibilitychange", this.handleVisibilityChange);
    this.schedule();
  }

  disconnect(): void {
    this.connected = false;
    this.rescheduleDelayMs = null;
    this.stopVisibility?.();
    this.stopVisibility = undefined;
    this.cancelScheduledWork();
    this.lastAttemptAt.clear();
  }

  update(snapshot: SessionPrefetchSnapshot): void {
    const previous = this.snapshot;
    this.snapshot = snapshot;
    if (previous?.client !== snapshot.client) {
      this.lastAttemptAt.clear();
    }
    if (
      !previous ||
      previous.client !== snapshot.client ||
      previous.listRevision !== snapshot.listRevision ||
      previous.intentSessionKey !== snapshot.intentSessionKey ||
      previous.presentedTranscriptsReady !== snapshot.presentedTranscriptsReady ||
      previous.openSessionKeys.length !== snapshot.openSessionKeys.length ||
      previous.openSessionKeys.some((key, index) => key !== snapshot.openSessionKeys[index])
    ) {
      this.schedule();
    }
  }

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "visible") {
      this.schedule();
    }
  };

  private schedule(delayMs = SESSION_PREFETCH_INTENT_DELAY_MS): void {
    if (!this.connected || !mayPrefetchHistory(this.snapshot)) {
      this.cancelScheduledWork();
      this.rescheduleDelayMs = null;
      return;
    }
    if (this.running) {
      this.rescheduleDelayMs =
        this.rescheduleDelayMs === null ? delayMs : Math.min(this.rescheduleDelayMs, delayMs);
      return;
    }
    const deadline = Date.now() + delayMs;
    if (this.delayDeadline !== null && this.delayDeadline <= deadline) {
      return;
    }
    this.cancelScheduledWork();
    this.delayDeadline = deadline;
    this.delayTimer = globalThis.setTimeout(() => {
      this.delayTimer = null;
      this.delayDeadline = null;
      void this.runCycle();
    }, delayMs);
  }

  private async runCycle(): Promise<void> {
    if (!this.connected || this.running || document.visibilityState === "hidden") {
      return;
    }
    this.running = true;
    try {
      await this.prefetchIntendedSession();
    } catch (error) {
      console.debug("[chat-session-prefetch] cycle failed", error);
    } finally {
      this.running = false;
      if (this.rescheduleDelayMs !== null) {
        const delayMs = this.rescheduleDelayMs;
        this.rescheduleDelayMs = null;
        this.schedule(delayMs);
      }
    }
  }

  private async prefetchIntendedSession(): Promise<void> {
    const snapshot = this.snapshot;
    // A presented transcript still in flight owns the socket; the pane's
    // loading-changed event reschedules this cycle, so waiting costs no polling.
    if (
      !snapshot?.client ||
      !snapshot.rows ||
      !mayPrefetchHistory(snapshot) ||
      document.visibilityState === "hidden" ||
      !this.connected
    ) {
      return;
    }
    const { client } = snapshot;
    await this.snapshotStore.loadSavedAtIndex();
    if (!this.isCurrent(snapshot)) {
      return;
    }
    // Refresh presented snapshots through their LRU owner before background writes
    // so a full cache evicts stale entries instead of visible conversation panes.
    for (const sessionKey of snapshot.openSessionKeys) {
      const snapshotKey = resolveChatSnapshotKey(snapshot.snapshotHost, { sessionKey });
      const presented = getSessionCacheValue(this.cache, snapshotKey);
      if (presented && this.cache.size === MAX_CACHED_CHAT_SESSIONS) {
        this.snapshotStore.write(snapshotKey, presented.snapshot, presented.weight);
      }
    }
    const candidate = this.selectCandidate(snapshot);
    if (candidate) {
      await this.prefetchCandidate(snapshot, client, candidate);
    }
  }

  private async prefetchCandidate(
    snapshot: SessionPrefetchSnapshot,
    client: GatewayBrowserClient,
    candidate: SessionPrefetchCandidate,
  ): Promise<void> {
    // Hydration and cursor removal are synchronous owned writes. Renew
    // only after checking the previous claim, before another await.
    let ownsCache = this.snapshotStore.captureReadScope(candidate.snapshotKey);
    const isCurrent = () => this.isCurrent(snapshot, candidate) && ownsCache.isCurrent();
    // Every network request re-reads readiness: a presented pane can start
    // loading during the persisted snapshot read or between history pages.
    const mayRequest = () => isCurrent() && mayPrefetchHistory(this.snapshot, candidate.sessionKey);
    const target = { sessionKey: candidate.canonicalSessionKey };
    const readSnapshot = () => readChatSessionSnapshot(this.cache, snapshot.snapshotHost, target);
    const cacheSnapshot = (value: ChatSessionSnapshot) =>
      cacheChatSessionSnapshot(this.cache, snapshot.snapshotHost, target, value);
    try {
      if (!mayRequest() || this.isOpen(candidate.snapshotKey)) {
        return;
      }
      let existing = readSnapshot();
      if (!existing && this.snapshotStore.readSavedAt(candidate.snapshotKey) !== null) {
        existing = await this.snapshotStore.read(candidate.snapshotKey);
        if (!mayRequest()) {
          return;
        }
        if (existing) {
          cacheSnapshot(existing);
          ownsCache.dispose();
          ownsCache = this.snapshotStore.captureReadScope(candidate.snapshotKey);
        }
      }
      // The cooldown counts network attempts; a candidate yielded before its
      // request stays eligible for the cycle after the presented transcript commits.
      this.lastAttemptAt.set(candidate.snapshotKey, Date.now());
      let result = await requestChatSessionSnapshot(
        client,
        candidate.canonicalSessionKey,
        this,
        mayRequest,
        existing?.deltaCursor,
      );
      if (!isCurrent()) {
        return;
      }
      if (result.kind === "reset") {
        if (existing?.deltaCursor !== undefined) {
          const { deltaCursor: _deltaCursor, ...withoutCursor } = existing;
          cacheSnapshot(withoutCursor);
          existing = withoutCursor;
          ownsCache.dispose();
          ownsCache = this.snapshotStore.captureReadScope(candidate.snapshotKey);
        }
        if (!mayRequest()) {
          return;
        }
        result = await requestChatSessionSnapshot(
          client,
          candidate.canonicalSessionKey,
          this,
          mayRequest,
        );
        if (!isCurrent()) {
          return;
        }
      }
      if (this.isOpen(candidate.snapshotKey)) {
        return;
      }
      let cached: ChatSessionSnapshot;
      if (result.kind === "delta") {
        for (const payload of result.messages) {
          const event = asOptionalRecord(payload);
          if (!event || !Object.hasOwn(event, "message")) {
            continue;
          }
          appendChatMessageToCache(this.cache, snapshot.snapshotHost, target, event.message, event);
        }
        const updated = readSnapshot();
        if (!updated) {
          return;
        }
        cached = {
          ...updated,
          // Prefetch does not own transient run replay. Keep the prior cursor
          // so the opening pane can consume the same authoritative snapshot.
          ...(result.inFlightRun ? {} : { deltaCursor: result.deltaCursor }),
          ...(Object.hasOwn(result.sessionInfo, "activeLeafEntryId")
            ? { displayedLeafEntryId: result.sessionInfo.activeLeafEntryId?.trim() || null }
            : {}),
          sessionId: result.sessionInfo.sessionId?.trim() || updated.sessionId,
          transcriptMetadata: projectChatTranscriptMetadata(result.sessionInfo),
        };
      } else if (result.kind === "snapshot") {
        cached = result.snapshot;
      } else {
        throw new Error("chat history page request returned a cursor reset");
      }
      cacheSnapshot(cached);
    } catch (error) {
      console.debug(
        `[chat-session-prefetch] history fetch failed for ${candidate.canonicalSessionKey}`,
        error,
      );
    } finally {
      ownsCache.dispose();
    }
  }

  private selectCandidate(snapshot: SessionPrefetchSnapshot): SessionPrefetchCandidate | null {
    const now = Date.now();
    // Only attempts within the cooldown affect admission; old session keys
    // must not accumulate across a long-lived page's navigation history.
    for (const [key, attemptedAt] of this.lastAttemptAt) {
      if (now - attemptedAt >= SESSION_PREFETCH_COOLDOWN_MS) {
        this.lastAttemptAt.delete(key);
      }
    }
    const row = snapshot.rows?.find((candidate) => candidate.key === snapshot.intentSessionKey);
    // The presented pane owns transient run adoption and replay. Prefetch only
    // warms durable history after navigation intent.
    if (!row || isSessionRunStateActive(row)) {
      return null;
    }
    const openKeys = new Set(
      snapshot.openSessionKeys.map((sessionKey) =>
        resolveChatSnapshotKey(snapshot.snapshotHost, { sessionKey }),
      ),
    );
    const snapshotKey = resolveChatSnapshotKey(snapshot.snapshotHost, {
      sessionKey: row.key,
      agentId: row.agentId,
    });
    if (openKeys.has(snapshotKey) || openKeys.size >= MAX_CACHED_CHAT_SESSIONS) {
      return null;
    }
    const activityAt = row.lastActivityAt ?? row.updatedAt ?? 0;
    const savedAt = this.snapshotStore.readSavedAt(snapshotKey);
    if (savedAt !== null && savedAt >= activityAt) {
      return null;
    }
    const elapsed = now - (this.lastAttemptAt.get(snapshotKey) ?? 0);
    if (elapsed < SESSION_PREFETCH_COOLDOWN_MS) {
      this.schedule(SESSION_PREFETCH_COOLDOWN_MS - elapsed);
      return null;
    }
    return {
      sessionKey: row.key,
      canonicalSessionKey: resolveChatSnapshotSessionKey(snapshot.snapshotHost, {
        sessionKey: row.key,
        agentId: row.agentId,
      }),
      snapshotKey,
      sessionId: row.sessionId,
    };
  }

  private isCurrent(
    snapshot: SessionPrefetchSnapshot,
    candidate?: SessionPrefetchCandidate,
  ): boolean {
    const current = this.snapshot;
    if (
      !this.connected ||
      document.visibilityState === "hidden" ||
      !snapshot.isCurrent() ||
      !current ||
      current.client !== snapshot.client
    ) {
      return false;
    }
    if (!candidate) {
      return true;
    }
    // Warm history is best effort; opening the pane revalidates its cursor.
    // Cache invalidation and the final open-pane check still own publication.
    return (
      current.rows?.some(
        (row) => row.key === candidate.sessionKey && row.sessionId === candidate.sessionId,
      ) === true
    );
  }

  private isOpen(snapshotKey: string): boolean {
    const snapshot = this.snapshot;
    return Boolean(
      snapshot?.openSessionKeys.some(
        (sessionKey) =>
          resolveChatSnapshotKey(snapshot.snapshotHost, { sessionKey }) === snapshotKey,
      ),
    );
  }

  private cancelScheduledWork(): void {
    this.delayDeadline = null;
    if (this.delayTimer !== null) {
      globalThis.clearTimeout(this.delayTimer);
      this.delayTimer = null;
    }
  }
}

/** Owns page-lifetime observation; history requests and cache custody stay synchronous. */
export function createSessionPrefetch(
  host: HTMLElement,
  cache: ChatMessageCache,
  snapshotStore: SessionSnapshotStore,
  readContext: () => SessionPrefetchContext | undefined,
): () => void {
  const prefetcher = new SessionPrefetcher(cache, snapshotStore);
  let context: SessionPrefetchContext | undefined;
  let subscriptions: Array<() => void> = [];
  let intentSessionKey: string | null = null;
  let paneRoot: Element;
  let paneListeners: AbortController | undefined;

  function clearSubscriptions(): void {
    for (const unsubscribe of subscriptions) {
      unsubscribe();
    }
    subscriptions = [];
    context = undefined;
  }

  function syncSnapshot(): void {
    const next = readContext();
    if (next !== context) {
      clearSubscriptions();
      context = next;
      if (context) {
        // Retire obsolete request scopes on each publication, even while rendering is parked.
        subscriptions = [
          context.gateway.subscribe(syncSnapshot),
          context.sessions.subscribe(syncSnapshot),
        ];
      }
    }
    if (!context) {
      return;
    }
    const source = context;
    // The shell owns these sibling panes, whose public host properties describe readiness.
    const panes = chatPanesWithin(paneRoot).filter(
      (pane) => pane.closest("openclaw-app-shell") === paneRoot.closest("openclaw-app-shell"),
    );
    const openSessionKeys = panes.flatMap((pane) => (pane.sessionKey ? [pane.sessionKey] : []));
    const sessions = source.sessions;
    const connection = sessions.captureConnectionScope();
    prefetcher.update({
      client: connection?.client ?? null,
      isCurrent: () =>
        context === source &&
        source.sessions === sessions &&
        connection !== null &&
        sessions.isConnectionScopeCurrent(connection),
      listRevision: source.sessions.canonicalListRevision,
      openSessionKeys,
      intentSessionKey,
      presentedTranscriptsReady: !panes.some(
        (pane) => pane.presented !== false && pane.transcriptLoading === true,
      ),
      rows: source.sessions.state.result?.sessions ?? null,
      snapshotHost: {
        settings: source.gateway.connection,
        client: source.gateway.snapshot.client,
        assistantAgentId: source.gateway.snapshot.assistantAgentId,
        agentsList: source.agents.state.agentsList,
        hello: source.gateway.snapshot.hello,
      },
    });
  }

  function handleNavigationIntent(event: Event): void {
    const row = event
      .composedPath()
      .find(
        (target): target is HTMLElement =>
          target instanceof HTMLElement && target.hasAttribute("data-session-key"),
      );
    if (row && row.closest("openclaw-app-shell") !== paneRoot.closest("openclaw-app-shell")) {
      return;
    }
    const sessionKey = row?.dataset.sessionKey ?? null;
    if (sessionKey !== intentSessionKey) {
      intentSessionKey = sessionKey;
      syncSnapshot();
    }
  }

  function sync(): void {
    // Solid constructs the page before attachment; its commit supplies the shell.
    const root = host.closest("openclaw-app-shell") ?? host;
    if (root !== paneRoot) {
      paneListeners?.abort();
      paneRoot = root;
      paneListeners = new AbortController();
      const options = { signal: paneListeners.signal };
      listen(paneRoot, CHAT_TRANSCRIPT_LOADING_CHANGED_EVENT, syncSnapshot, options);
      listen(paneRoot, CHAT_PANE_LIFECYCLE_CHANGED_EVENT, syncSnapshot, options);
      listen(paneRoot, "pointerover", handleNavigationIntent, options);
      listen(paneRoot, "focusin", handleNavigationIntent, options);
    }
    syncSnapshot();
  }

  onCleanup(() => {
    paneListeners?.abort();
    clearSubscriptions();
    prefetcher.disconnect();
  });
  // Start with the page owner, before its first commit can trigger sibling work.
  sync();
  prefetcher.connect();
  return sync;
}
