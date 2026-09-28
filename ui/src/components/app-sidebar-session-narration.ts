import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  resolveSafeTimeoutDelayMs,
} from "@openclaw/gateway-client/browser";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Value } from "typebox/value";
import {
  SessionObserverDigestSchema,
  type SessionObserverDigest,
} from "../../../packages/gateway-protocol/src/schema/sessions.js";
import {
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  stripInternalRuntimeContext,
} from "../../../src/agents/internal-runtime-context.js";
import {
  isSuppressedControlReplyLeadFragment,
  isSuppressedControlReplyText,
  stripSuppressedControlReplyToken,
} from "../../../src/gateway/control-reply-text.js";
import { extractAssistantPhaseText } from "../../../src/shared/chat-message-content.js";
import { stripInlineDirectiveTagsForDisplay } from "../../../src/utils/directive-tags.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import { stripHeartbeatTokenForDisplay } from "../lib/chat/heartbeat-display.ts";
import { pickFreshestObserverDigest } from "../lib/observer-digest.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import {
  areUiSessionKeysEquivalent,
  isUiGlobalSessionKey,
  normalizeAgentId,
} from "../lib/sessions/session-key.ts";
import { stripThinkingTags } from "../lib/strip-thinking-tags.ts";
import type { SidebarRecentSession, SidebarToolActivity } from "./app-sidebar-session-types.ts";
import {
  deriveSidebarNarrationLine,
  trailingInternalDelimiterPrefix,
} from "./sidebar-narration-line.ts";
import { readSidebarToolActivity } from "./sidebar-tool-activity.ts";

const SIDEBAR_NARRATION_SUBSCRIPTION_LIMIT = 6;
const SIDEBAR_NARRATION_THROTTLE_MS = 2_000;
const SIDEBAR_NARRATION_BUFFER_CHARS = 16_384;
const SIDEBAR_NARRATION_RETRY_INITIAL_MS = 500;
const SIDEBAR_NARRATION_RETRY_MAX_MS = 30_000;

type SessionMessageSubscription = Awaited<ReturnType<SessionCapability["subscribeMessages"]>>;
type NarrationSource = Pick<SessionCapability, "subscribeMessages" | "unsubscribeMessages">;

type NarrationSubscription = {
  key: string;
  source: NarrationSource;
  connectionIdentity: object;
  subscription: SessionMessageSubscription;
  release?: Promise<void>;
};

type NarrationRetry = {
  retryWindowMs: number;
  retryAt: number;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
};

type PendingSubscription = NarrationRetry & { agentId: string | null };

function createNarrationRetry(): NarrationRetry {
  return { retryWindowMs: SIDEBAR_NARRATION_RETRY_INITIAL_MS, retryAt: 0, timer: null };
}

type NarrationActivity = { text: string };

type ThrottledLine = {
  lastPublishedAt: number;
  pending: NarrationActivity | null;
  timer: ReturnType<typeof globalThis.setTimeout> | null;
};

type NarrationStream = {
  // Keep the full stream length even after visibleText trims its bounded buffer.
  consumedLength: number;
  internalDepth: number;
  delimiterTail: string;
  visibleText: string;
};

export type SidebarNarrationSyncInput = {
  enabled: boolean;
  connected: boolean;
  connectionIdentity: object | null;
  source: NarrationSource | null;
  rows: readonly SidebarRecentSession[];
  openSessionKey: string;
  agentId: string;
};

// TRANSITIONAL(marker-retirement): live narration strips inline markers because
// streamed drafts still carry them mid-run; persisted data is already clean.
// Drop the stripInlineDirectiveTagsForDisplay call when the visibleReplies
// default flips to "message_tool".
function normalizeSidebarNarrationText(text: string): string | null {
  const displayText = stripSuppressedControlReplyToken(
    stripInternalRuntimeContext(stripInlineDirectiveTagsForDisplay(text).text),
  );
  const heartbeat = stripHeartbeatTokenForDisplay(displayText);
  if (
    !displayText ||
    isSuppressedControlReplyText(displayText) ||
    isSuppressedControlReplyLeadFragment(displayText) ||
    heartbeat.shouldSkip
  ) {
    return null;
  }
  return heartbeat.text;
}

function rowRecency(row: SidebarRecentSession): number {
  return row.startedAt ?? row.updatedAt ?? 0;
}

function eventAgentMatches(targetAgentId: string, payloadAgentId: unknown): boolean {
  return (
    typeof payloadAgentId !== "string" ||
    !payloadAgentId.trim() ||
    normalizeAgentId(payloadAgentId) === normalizeAgentId(targetAgentId)
  );
}

/** Owns the bounded session subscriptions and per-row activity throttles. */
export class SidebarSessionNarrationController {
  private source: NarrationSource | null = null;
  private input: SidebarNarrationSyncInput | null = null;
  private visibilityDocument: Document | null = null;
  private readonly handleVisibilityChange = () => {
    if (this.input) {
      this.sync(this.input);
    }
  };
  private connectionIdentity: object | null = null;
  private connected = false;
  private enabled = false;
  private agentId = "main";
  private desiredKeys = new Set<string>();
  private subscriptions = new Map<string, NarrationSubscription>();
  private pendingReleases = new Map<NarrationSubscription, NarrationRetry>();
  private pendingSubscriptions = new Map<string, PendingSubscription>();
  private streams = new Map<string, NarrationStream>();
  private runIds = new Map<string, string>();
  private throttles = new Map<string, ThrottledLine>();
  private lines = new Map<string, string>();
  private observerDigests = new Map<string, SessionObserverDigest>();
  private tools = new Map<string, SidebarToolActivity>();

  constructor(
    private readonly onLinesChanged: (lines: ReadonlyMap<string, string>) => void,
    private readonly onObserverDigestsChanged: (
      digests: ReadonlyMap<string, SessionObserverDigest>,
    ) => void = () => undefined,
    private readonly onToolsChanged: (
      tools: ReadonlyMap<string, SidebarToolActivity>,
    ) => void = () => undefined,
  ) {}

  sync(input: SidebarNarrationSyncInput): void {
    if (!this.input) {
      this.visibilityDocument = globalThis.document ?? null;
      this.visibilityDocument?.addEventListener("visibilitychange", this.handleVisibilityChange);
    }
    this.input = input;
    const connectionChanged = this.connectionIdentity !== input.connectionIdentity;
    const sourceChanged = this.source !== input.source;
    const disconnected = !input.connected || !input.connectionIdentity || !input.source;
    if (connectionChanged || sourceChanged || disconnected) {
      this.resetSubscriptions();
    }

    this.source = input.source;
    this.connectionIdentity = input.connectionIdentity;
    this.connected = input.connected;
    this.enabled = input.enabled && this.visibilityDocument?.visibilityState !== "hidden";
    this.agentId = normalizeAgentId(input.agentId);

    if (disconnected || !this.enabled) {
      this.desiredKeys = new Set();
      this.resetSubscriptions();
      this.syncReleases();
      this.clearAllLines();
      return;
    }

    const openSessionKey = input.openSessionKey.trim();
    const nextDesired = new Set<string>();
    let backgroundSubscriptions = 0;
    for (const row of input.rows
      .filter((candidate) => candidate.hasActiveRun)
      .toSorted(
        (left, right) =>
          Number(this.subscriptions.has(right.key) || this.pendingSubscriptions.has(right.key)) -
            Number(this.subscriptions.has(left.key) || this.pendingSubscriptions.has(left.key)) ||
          rowRecency(right) - rowRecency(left),
      )) {
      const open = areUiSessionKeysEquivalent(row.key, openSessionKey);
      if (!open && backgroundSubscriptions >= SIDEBAR_NARRATION_SUBSCRIPTION_LIMIT) {
        continue;
      }
      nextDesired.add(row.key);
      if (!open) {
        backgroundSubscriptions += 1;
      }
    }

    for (const key of this.desiredKeys) {
      if (nextDesired.has(key)) {
        continue;
      }
      this.releaseKey(key);
    }

    this.desiredKeys = nextDesired;
    for (const key of nextDesired) {
      const targetAgentId = this.subscriptionAgentId(key);
      const ownedAgentId = this.subscriptions.get(key)?.subscription.agentId ?? null;
      const pendingAgentId = this.pendingSubscriptions.get(key)?.agentId ?? null;
      if (
        (this.subscriptions.has(key) && ownedAgentId !== targetAgentId) ||
        (this.pendingSubscriptions.has(key) && pendingAgentId !== targetAgentId)
      ) {
        this.releaseKey(key);
      }
      if (
        this.subscriptions.has(key) ||
        (this.pendingSubscriptions.get(key)?.retryAt ?? 0) > Date.now()
      ) {
        continue;
      }
      void this.subscribeKey(key);
    }
    this.syncReleases();
  }

  handleEvent(event: GatewayEventFrame): void {
    if (!this.enabled || !this.connected) {
      return;
    }
    if (event.event === "chat") {
      this.handleChatEvent(event.payload);
      return;
    }
    if (event.event === "session.observer") {
      this.handleObserverEvent(event.payload);
      return;
    }
    if (event.event === "agent" || event.event === "session.tool") {
      this.handleAgentEvent(event.payload);
    }
  }

  disconnect(): void {
    this.visibilityDocument?.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.visibilityDocument = null;
    this.input = null;
    this.desiredKeys = new Set();
    this.resetSubscriptions();
    this.clearAllLines();
    this.connected = false;
    this.syncReleases();
  }

  private async subscribeKey(key: string): Promise<void> {
    const source = this.source;
    const connectionIdentity = this.connectionIdentity;
    if (
      !source ||
      !connectionIdentity ||
      !this.connected ||
      !this.enabled ||
      !this.desiredKeys.has(key)
    ) {
      return;
    }
    const pending = this.pendingSubscriptions.get(key) ?? {
      agentId: this.subscriptionAgentId(key),
      ...createNarrationRetry(),
    };
    this.cancelRetry(pending);
    // Both in-flight and non-retryable failures hold their slot until intent changes.
    pending.retryAt = Infinity;
    this.pendingSubscriptions.set(key, pending);
    try {
      const subscription = await source.subscribeMessages(key, {
        agentId: pending.agentId ?? undefined,
      });
      const owned = { key, source, connectionIdentity, subscription };
      const current = this.pendingSubscriptions.get(key) === pending;
      if (current) {
        this.pendingSubscriptions.delete(key);
      }
      if (
        !current ||
        source !== this.source ||
        !this.connected ||
        !this.enabled ||
        !this.desiredKeys.has(key)
      ) {
        this.releaseSubscription(owned);
        return;
      }
      this.subscriptions.set(key, owned);
      this.syncReleases();
    } catch (error) {
      if (this.pendingSubscriptions.get(key) === pending) {
        this.scheduleRetry(pending, error);
      }
    }
  }

  private scheduleRetry(retry: NarrationRetry, error: unknown): void {
    retry.retryAt = Infinity;
    if (
      !(error instanceof GatewayProtocolRequestTimeoutError) &&
      (!(error instanceof GatewayProtocolRequestError) || !error.retryable)
    ) {
      return;
    }
    const hint = error instanceof GatewayProtocolRequestError ? error.retryAfterMs : undefined;
    const floor = typeof hint === "number" && Number.isFinite(hint) ? Math.max(0, hint) : 0;
    const delay = resolveSafeTimeoutDelayMs(floor + Math.random() * retry.retryWindowMs);
    retry.retryWindowMs = Math.min(retry.retryWindowMs * 2, SIDEBAR_NARRATION_RETRY_MAX_MS);
    retry.retryAt = Date.now() + delay;
    retry.timer = globalThis.setTimeout(() => {
      retry.timer = null;
      retry.retryAt = 0;
      if (this.input) {
        this.sync(this.input);
      }
    }, delay);
  }

  private cancelRetry(retry: NarrationRetry): void {
    if (retry.timer !== null) {
      globalThis.clearTimeout(retry.timer);
      retry.timer = null;
    }
  }

  private subscriptionAgentId(key: string): string | null {
    return isUiGlobalSessionKey(key) ? this.agentId : null;
  }

  private releaseKey(key: string): void {
    const pending = this.pendingSubscriptions.get(key);
    if (pending) {
      this.cancelRetry(pending);
    }
    this.pendingSubscriptions.delete(key);
    const owned = this.subscriptions.get(key);
    this.subscriptions.delete(key);
    if (owned) {
      this.releaseSubscription(owned);
    }
    this.clearLine(key);
  }

  private releaseSubscription(owned: NarrationSubscription): void {
    const retry = this.pendingReleases.get(owned) ?? createNarrationRetry();
    if (owned.release || retry.retryAt > Date.now()) {
      return;
    }
    this.cancelRetry(retry);
    retry.retryAt = Infinity;
    this.pendingReleases.set(owned, retry);
    owned.release = owned.source
      .unsubscribeMessages(owned.subscription)
      .then(() => {
        this.pendingReleases.delete(owned);
      })
      .catch((error: unknown) => {
        if (this.pendingReleases.get(owned) === retry && !this.releaseIsDesired(owned)) {
          this.scheduleRetry(retry, error);
        }
      })
      .finally(() => {
        owned.release = undefined;
        this.syncReleases();
      });
  }

  private releaseIsDesired(owned: NarrationSubscription): boolean {
    return (
      owned.source === this.source &&
      this.desiredKeys.has(owned.key) &&
      (owned.subscription.agentId ?? null) === this.subscriptionAgentId(owned.key)
    );
  }

  private syncReleases(): void {
    for (const [owned, retry] of this.pendingReleases) {
      if (!this.connected || owned.connectionIdentity !== this.connectionIdentity) {
        this.cancelRetry(retry);
        retry.retryAt = 0;
        // DOM detachment pauses cleanup without retiring the socket's leases.
        if (this.input || owned.connectionIdentity !== this.connectionIdentity) {
          this.pendingReleases.delete(owned);
        }
        continue;
      }
      if (this.releaseIsDesired(owned)) {
        this.cancelRetry(retry);
        retry.retryAt = 0;
        // Reacquire through the coordinator before retiring the old handle: a
        // timed-out unsubscribe may already have removed its wire observer.
        if (!this.subscriptions.has(owned.key)) {
          continue;
        }
      }
      this.releaseSubscription(owned);
    }
  }

  private resetSubscriptions(): void {
    const keys = new Set([...this.subscriptions.keys(), ...this.pendingSubscriptions.keys()]);
    for (const key of keys) {
      this.releaseKey(key);
    }
  }

  private matchingDesiredKey(sessionKey: unknown, payloadAgentId: unknown): string | null {
    if (typeof sessionKey !== "string" || !sessionKey.trim()) {
      return null;
    }
    for (const key of this.desiredKeys) {
      if (
        areUiSessionKeysEquivalent(key, sessionKey) &&
        (!isUiGlobalSessionKey(key) || eventAgentMatches(this.agentId, payloadAgentId))
      ) {
        return key;
      }
    }
    return null;
  }

  private handleChatEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const record = payload as Record<string, unknown>;
    const key = this.matchingDesiredKey(record.sessionKey, record.agentId);
    if (!key) {
      return;
    }
    this.observeRun(key, record.runId);
    if (this.observerDigests.has(key)) {
      return;
    }
    const message = record.message as Record<string, unknown> | undefined;
    if (message && typeof message.role === "string" && message.role !== "assistant") {
      return;
    }
    const deltaText = typeof record.deltaText === "string" ? record.deltaText : "";
    const messageText = message
      ? stripThinkingTags(extractAssistantPhaseText(message) ?? "")
      : null;
    const consumed = this.streams.get(key)?.consumedLength ?? 0;
    // A newly subscribed sidebar can join mid-run. Within one run the server's
    // cumulative snapshot grows monotonically, so length arithmetic decides
    // append vs rejoin without storing the raw stream.
    if (record.replace === true) {
      // Handle before any truthiness gate: an EMPTY replacement retracts the
      // narration line (streamLength 0 takes publishText's clearing path).
      const replacement = messageText ?? deltaText;
      this.publishText(key, {
        streamLength: replacement.length,
        fragment: replacement,
        reset: true,
      });
      return;
    }
    if (deltaText) {
      if (messageText !== null) {
        const appends = consumed > 0 && messageText.length - deltaText.length === consumed;
        this.publishText(key, {
          streamLength: messageText.length,
          fragment: appends ? deltaText : messageText,
          reset: !appends,
        });
      } else if (consumed > 0) {
        this.publishText(key, {
          streamLength: consumed + deltaText.length,
          fragment: deltaText,
          reset: false,
        });
      }
      // consumed === 0 with a bare delta: a mid-run join may sit INSIDE an
      // internal-context block whose opening delimiter we never saw. Stay
      // silent until a cumulative snapshot or replacement aligns the stream.
      return;
    }
    if (messageText !== null) {
      this.publishText(key, {
        streamLength: messageText.length,
        fragment: messageText,
        reset: true,
      });
    }
  }

  private publishText(
    key: string,
    update: { streamLength: number; fragment: string; reset: boolean },
  ): void {
    if (update.streamLength <= 0) {
      if (update.reset) {
        // An empty replacement retracts prior content; a stale line must not
        // outlive it (the draft it showed may have been withdrawn).
        this.clearNarration(key);
      }
      return;
    }
    const stream = this.streams.get(key) ?? {
      consumedLength: 0,
      internalDepth: 0,
      delimiterTail: "",
      visibleText: "",
    };
    stream.consumedLength = update.streamLength;
    this.streams.set(key, stream);
    if (update.reset) {
      stream.internalDepth = 0;
      stream.delimiterTail = "";
      stream.visibleText = "";
      // A replacement supersedes anything still queued behind the throttle;
      // otherwise a pre-replacement draft could republish after retraction.
      const throttle = this.throttles.get(key);
      if (throttle) {
        throttle.pending = null;
      }
    }
    const visibleFragment = this.stripInternalRuntimeFragment(stream, update.fragment);
    const nextVisibleText = `${stream.visibleText}${visibleFragment}`;
    if (!nextVisibleText) {
      if (update.reset && this.lines.delete(key)) {
        this.onLinesChanged(new Map(this.lines));
      }
      return;
    }
    stream.visibleText =
      nextVisibleText.length > SIDEBAR_NARRATION_BUFFER_CHARS
        ? sliceUtf16Safe(nextVisibleText, -SIDEBAR_NARRATION_BUFFER_CHARS)
        : nextVisibleText;
    this.publishThrottled(key, { text: stream.visibleText });
  }

  private stripInternalRuntimeFragment(stream: NarrationStream, fragment: string): string {
    const text = `${stream.delimiterTail}${fragment}`;
    stream.delimiterTail = "";
    let depth = stream.internalDepth;
    let cursor = 0;
    let visible = "";

    while (cursor < text.length) {
      const nextBegin = text.indexOf(INTERNAL_RUNTIME_CONTEXT_BEGIN, cursor);
      const nextEnd = text.indexOf(INTERNAL_RUNTIME_CONTEXT_END, cursor);
      if (depth === 0) {
        if (nextBegin === -1 && nextEnd === -1) {
          visible += text.slice(cursor);
          break;
        }
        if (nextEnd !== -1 && (nextBegin === -1 || nextEnd < nextBegin)) {
          // A stray closing delimiter means this fragment may start inside an
          // already-trimmed block. Fail closed until that boundary passes.
          cursor = nextEnd + INTERNAL_RUNTIME_CONTEXT_END.length;
          continue;
        }
        visible += text.slice(cursor, nextBegin);
        depth = 1;
        cursor = nextBegin + INTERNAL_RUNTIME_CONTEXT_BEGIN.length;
        continue;
      }
      if (nextBegin === -1 && nextEnd === -1) {
        break;
      }
      if (nextBegin !== -1 && (nextEnd === -1 || nextBegin < nextEnd)) {
        depth += 1;
        cursor = nextBegin + INTERNAL_RUNTIME_CONTEXT_BEGIN.length;
        continue;
      }
      depth -= 1;
      cursor = nextEnd + INTERNAL_RUNTIME_CONTEXT_END.length;
    }

    const delimiterPrefix = trailingInternalDelimiterPrefix(text);
    if (delimiterPrefix) {
      stream.delimiterTail = delimiterPrefix;
      if (depth === 0 && visible.endsWith(delimiterPrefix)) {
        visible = visible.slice(0, -delimiterPrefix.length);
      }
    }
    stream.internalDepth = depth;
    return visible;
  }

  private handleAgentEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const record = payload as Record<string, unknown>;
    const key = this.matchingDesiredKey(record.sessionKey, record.agentId);
    if (!key) {
      return;
    }
    const runId = typeof record.runId === "string" ? record.runId.trim() : "";
    const sameRun = runId !== "" && this.runIds.get(key) === runId;
    const activity = readSidebarToolActivity(
      record.stream,
      record.data,
      !runId || sameRun ? this.tools.get(key) : undefined,
    );
    if (activity === null) {
      // A visibility change withdraws only the identified call in the current run.
      if (sameRun && this.tools.delete(key)) {
        this.onToolsChanged(new Map(this.tools));
      }
      return;
    }
    if (!activity) {
      return;
    }
    this.observeRun(key, runId);
    const previous = this.tools.get(key);
    if (
      previous?.name !== activity.name ||
      previous.itemId !== activity.itemId ||
      previous.toolCallId !== activity.toolCallId ||
      previous.text !== activity.text
    ) {
      this.tools.set(key, activity);
      this.onToolsChanged(new Map(this.tools));
    }
  }

  private handleObserverEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const record = payload as Record<string, unknown>;
    const key = this.matchingDesiredKey(record.sessionKey, record.agentId);
    const runId = typeof record.runId === "string" ? record.runId.trim() : "";
    if (!key || !runId) {
      return;
    }
    const digest = { ...record, runId };
    if (!Value.Check(SessionObserverDigestSchema, digest)) {
      return;
    }
    this.observeRun(key, runId);
    const previous = this.observerDigests.get(key);
    if (previous && pickFreshestObserverDigest(previous, digest) === previous) {
      return;
    }
    this.clearNarration(key);
    this.observerDigests.set(key, digest);
    this.onObserverDigestsChanged(new Map(this.observerDigests));
  }

  private observeRun(key: string, runIdValue: unknown): void {
    const runId = typeof runIdValue === "string" ? runIdValue.trim() : "";
    if (!runId) {
      return;
    }
    const previousRunId = this.runIds.get(key);
    if (previousRunId && previousRunId !== runId) {
      this.clearLine(key);
    }
    this.runIds.set(key, runId);
  }

  private publishThrottled(key: string, activity: NarrationActivity): void {
    const now = Date.now();
    const throttle = this.throttles.get(key);
    if (!throttle || now - throttle.lastPublishedAt >= SIDEBAR_NARRATION_THROTTLE_MS) {
      if (throttle?.timer) {
        globalThis.clearTimeout(throttle.timer);
      }
      this.throttles.set(key, { lastPublishedAt: now, pending: null, timer: null });
      this.publishActivity(key, activity);
      return;
    }
    throttle.pending = activity;
    if (throttle.timer) {
      return;
    }
    throttle.timer = globalThis.setTimeout(
      () => {
        throttle.timer = null;
        const pending = throttle.pending;
        throttle.pending = null;
        if (!pending || !this.desiredKeys.has(key)) {
          return;
        }
        throttle.lastPublishedAt = Date.now();
        this.publishActivity(key, pending);
      },
      SIDEBAR_NARRATION_THROTTLE_MS - (now - throttle.lastPublishedAt),
    );
  }

  private publishActivity(key: string, activity: NarrationActivity): void {
    const safeText = normalizeSidebarNarrationText(activity.text);
    const line = safeText ? deriveSidebarNarrationLine(safeText) : "";
    if (line) {
      if (this.lines.get(key) !== line) {
        this.lines.set(key, line);
        this.onLinesChanged(new Map(this.lines));
      }
      return;
    }
    // The activity text is the full visible buffer: normalizing it to nothing
    // means only suppressed content remains (e.g. a replacement that reduced
    // to REPLY_SKIP or a heartbeat), so retract any previously shown line.
    if (this.lines.delete(key)) {
      this.onLinesChanged(new Map(this.lines));
    }
  }

  private clearLine(key: string): void {
    this.clearNarration(key);
    this.runIds.delete(key);
    if (this.tools.delete(key)) {
      this.onToolsChanged(new Map(this.tools));
    }
    if (this.observerDigests.delete(key)) {
      this.onObserverDigestsChanged(new Map(this.observerDigests));
    }
  }

  private clearNarration(key: string): void {
    this.streams.delete(key);
    const throttle = this.throttles.get(key);
    if (throttle?.timer) {
      globalThis.clearTimeout(throttle.timer);
    }
    this.throttles.delete(key);
    if (this.lines.delete(key)) {
      this.onLinesChanged(new Map(this.lines));
    }
  }

  private clearAllLines(): void {
    for (const throttle of this.throttles.values()) {
      if (throttle.timer) {
        globalThis.clearTimeout(throttle.timer);
      }
    }
    this.streams.clear();
    this.runIds.clear();
    this.throttles.clear();
    if (this.tools.size > 0) {
      this.tools.clear();
      this.onToolsChanged(new Map());
    }
    if (this.lines.size > 0) {
      this.lines.clear();
      this.onLinesChanged(new Map());
    }
    if (this.observerDigests.size > 0) {
      this.observerDigests.clear();
      this.onObserverDigestsChanged(new Map());
    }
  }
}
