import {
  GatewayProtocolRequestError,
  GatewayProtocolRequestTimeoutError,
  resolveSafeTimeoutDelayMs,
} from "@openclaw/gateway-client/browser";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { SessionObserverDigest } from "../../../packages/gateway-protocol/src/schema/sessions.js";
import { extractAssistantPhaseText } from "../../../src/shared/chat-message-content.js";
import type { GatewayEventFrame } from "../api/gateway.ts";
import { pickFreshestObserverDigest } from "../lib/observer-digest.ts";
import {
  isSessionNarrationEvent,
  isSessionObserverDigest,
} from "../lib/protocol-validators.generated/activity.js";
import { listen } from "../lib/reactive/listener.ts";
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
  stripSidebarInternalRuntimeFragment,
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
  source: NarrationSource;
  subscription: SessionMessageSubscription;
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

type ThrottledLine = {
  lastPublishedAt: number;
  pending: string | null;
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
  rows: readonly Pick<SidebarRecentSession, "key" | "hasActiveRun" | "startedAt" | "updatedAt">[];
  openSessionKey: string;
  agentId: string;
};

function rowRecency(row: Pick<SidebarRecentSession, "startedAt" | "updatedAt">): number {
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
export function createSidebarNarration() {
  const listeners = new Set<() => void>();
  let stopVisibility: (() => void) | undefined;
  function notify() {
    for (const listener of listeners) {
      listener();
    }
  }
  let currentSource: NarrationSource | null = null;
  let currentInput: SidebarNarrationSyncInput | null = null;
  let visibilityDocument: Document | null = null;
  const handleVisibilityChange = () => {
    if (currentInput) {
      sync(currentInput);
    }
  };
  let currentConnectionIdentity: object | null = null;
  let connected = false;
  let enabled = false;
  let currentAgentId = "main";
  let desiredKeys = new Set<string>();
  const subscriptions = new Map<string, NarrationSubscription>();
  const pendingSubscriptions = new Map<string, PendingSubscription>();
  const streams = new Map<string, NarrationStream>();
  const runIds = new Map<string, string>();
  const throttles = new Map<string, ThrottledLine>();
  let lines = new Map<string, string>();
  let observerDigests = new Map<string, SessionObserverDigest>();
  let tools = new Map<string, SidebarToolActivity>();

  function sync(input: SidebarNarrationSyncInput): void {
    if (!currentInput) {
      visibilityDocument = globalThis.document ?? null;
      if (visibilityDocument) {
        stopVisibility = listen(visibilityDocument, "visibilitychange", handleVisibilityChange);
      }
    }
    currentInput = input;
    const connectionChanged = currentConnectionIdentity !== input.connectionIdentity;
    const sourceChanged = currentSource !== input.source;
    const disconnected = !input.connected || !input.connectionIdentity || !input.source;
    if (connectionChanged || sourceChanged || disconnected) {
      resetSubscriptions();
    }

    currentSource = input.source;
    currentConnectionIdentity = input.connectionIdentity;
    connected = input.connected;
    enabled = input.enabled && visibilityDocument?.visibilityState !== "hidden";
    currentAgentId = normalizeAgentId(input.agentId);

    if (disconnected || !enabled) {
      desiredKeys = new Set();
      resetSubscriptions();
      clearAllLines();
      return;
    }

    const openSessionKey = input.openSessionKey.trim();
    const nextDesired = new Set<string>();
    let backgroundSubscriptions = 0;
    for (const row of input.rows
      .filter((candidate) => candidate.hasActiveRun)
      .toSorted(
        (left, right) =>
          Number(subscriptions.has(right.key) || pendingSubscriptions.has(right.key)) -
            Number(subscriptions.has(left.key) || pendingSubscriptions.has(left.key)) ||
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

    for (const key of desiredKeys) {
      if (nextDesired.has(key)) {
        continue;
      }
      releaseKey(key);
    }

    desiredKeys = nextDesired;
    for (const key of nextDesired) {
      const targetAgentId = subscriptionAgentId(key);
      const ownedAgentId = subscriptions.get(key)?.subscription.agentId ?? null;
      const pendingAgentId = pendingSubscriptions.get(key)?.agentId ?? null;
      if (
        (subscriptions.has(key) && ownedAgentId !== targetAgentId) ||
        (pendingSubscriptions.has(key) && pendingAgentId !== targetAgentId)
      ) {
        releaseKey(key);
      }
      if (subscriptions.has(key) || (pendingSubscriptions.get(key)?.retryAt ?? 0) > Date.now()) {
        continue;
      }
      void subscribeKey(key);
    }
  }

  function handleEvent(event: GatewayEventFrame): void {
    if (!enabled || !connected) {
      return;
    }
    if (event.event === "chat") {
      handleChatEvent(event.payload);
      return;
    }
    if (event.event === "session.narration") {
      handleNarrationEvent(event.payload);
      return;
    }
    if (event.event === "session.observer") {
      handleObserverEvent(event.payload);
      return;
    }
    if (event.event === "agent" || event.event === "session.tool") {
      handleAgentEvent(event.payload);
    }
  }

  function disconnect(): void {
    stopVisibility?.();
    stopVisibility = undefined;
    visibilityDocument = null;
    currentInput = null;
    desiredKeys = new Set();
    resetSubscriptions();
    clearAllLines();
    connected = false;
  }

  async function subscribeKey(key: string): Promise<void> {
    const source = currentSource;
    const connectionIdentity = currentConnectionIdentity;
    if (!source || !connectionIdentity || !connected || !enabled || !desiredKeys.has(key)) {
      return;
    }
    const pending = pendingSubscriptions.get(key) ?? {
      agentId: subscriptionAgentId(key),
      ...createNarrationRetry(),
    };
    cancelRetry(pending);
    // Both in-flight and non-retryable failures hold their slot until intent changes.
    pending.retryAt = Infinity;
    pendingSubscriptions.set(key, pending);
    try {
      const subscription = await source.subscribeMessages(key, {
        agentId: pending.agentId ?? undefined,
        mode: "narration",
      });
      const owned = { source, subscription };
      const current = pendingSubscriptions.get(key) === pending;
      if (current) {
        pendingSubscriptions.delete(key);
      }
      if (!current || source !== currentSource || !connected || !enabled || !desiredKeys.has(key)) {
        releaseSubscription(owned);
        return;
      }
      subscriptions.set(key, owned);
    } catch (error) {
      if (pendingSubscriptions.get(key) === pending) {
        scheduleRetry(pending, error);
      }
    }
  }

  function scheduleRetry(retry: NarrationRetry, error: unknown): void {
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
      if (currentInput) {
        sync(currentInput);
      }
    }, delay);
  }

  function cancelRetry(retry: NarrationRetry): void {
    if (retry.timer !== null) {
      globalThis.clearTimeout(retry.timer);
      retry.timer = null;
    }
  }

  function subscriptionAgentId(key: string): string | null {
    return isUiGlobalSessionKey(key) ? currentAgentId : null;
  }

  function releaseKey(key: string): void {
    const pending = pendingSubscriptions.get(key);
    if (pending) {
      cancelRetry(pending);
    }
    pendingSubscriptions.delete(key);
    const owned = subscriptions.get(key);
    subscriptions.delete(key);
    if (owned) {
      releaseSubscription(owned);
    }
    clearLine(key);
  }

  function releaseSubscription(owned: NarrationSubscription): void {
    // A failed unsubscribe may leave narration traffic until the next reconnect.
    void owned.source.unsubscribeMessages(owned.subscription).catch((error: unknown) => {
      console.warn("Failed to release sidebar narration subscription", error);
    });
  }

  function resetSubscriptions(): void {
    const keys = new Set([...subscriptions.keys(), ...pendingSubscriptions.keys()]);
    for (const key of keys) {
      releaseKey(key);
    }
  }

  function matchingDesiredKey(sessionKey: unknown, payloadAgentId: unknown): string | null {
    if (typeof sessionKey !== "string" || !sessionKey.trim()) {
      return null;
    }
    for (const key of desiredKeys) {
      if (
        areUiSessionKeysEquivalent(key, sessionKey) &&
        (!isUiGlobalSessionKey(key) || eventAgentMatches(currentAgentId, payloadAgentId))
      ) {
        return key;
      }
    }
    return null;
  }

  function handleChatEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const record = payload as Record<string, unknown>;
    const key = matchingDesiredKey(record.sessionKey, record.agentId);
    if (!key) {
      return;
    }
    observeRun(key, record.runId);
    if (observerDigests.has(key)) {
      return;
    }
    const immediate =
      record.state === "final" || record.state === "aborted" || record.state === "error";
    const message = record.message as Record<string, unknown> | undefined;
    if (message && typeof message.role === "string" && message.role !== "assistant") {
      return;
    }
    const deltaText = typeof record.deltaText === "string" ? record.deltaText : "";
    const messageText = message
      ? stripThinkingTags(extractAssistantPhaseText(message) ?? "")
      : null;
    const consumed = streams.get(key)?.consumedLength ?? 0;
    // A newly subscribed sidebar can join mid-run. Within one run the server's
    // cumulative snapshot grows monotonically, so length arithmetic decides
    // append vs rejoin without storing the raw stream.
    const replacement = record.replace === true;
    if (replacement || messageText !== null) {
      const snapshot = messageText ?? deltaText;
      const appends =
        !replacement &&
        deltaText !== "" &&
        consumed > 0 &&
        snapshot.length - deltaText.length === consumed;
      // An empty replacement still reaches publishText's clearing path.
      publishText(key, {
        streamLength: snapshot.length,
        fragment: appends ? deltaText : snapshot,
        reset: !appends,
        immediate,
      });
      return;
    }
    if (deltaText) {
      if (consumed > 0) {
        publishText(key, {
          streamLength: consumed + deltaText.length,
          fragment: deltaText,
          reset: false,
          immediate,
        });
      }
      // A bare delta cannot align a mid-run join inside an internal-context block.
      // Stay silent until a cumulative snapshot or replacement aligns the stream.
      return;
    }
    if (immediate) {
      const pending = throttles.get(key)?.pending;
      if (pending != null) {
        publishImmediate(key, pending);
      }
    }
  }

  function handleNarrationEvent(payload: unknown): void {
    if (!isSessionNarrationEvent(payload)) {
      return;
    }
    const key = matchingDesiredKey(payload.sessionKey, payload.agentId);
    if (!key) {
      return;
    }
    observeRun(key, payload.runId);
    if (observerDigests.has(key)) {
      return;
    }
    // The Gateway bounds already-sanitized text and owns digest pacing. Retire
    // any full-owner stream and pending tool line before publishing its snapshot.
    streams.delete(key);
    publishImmediate(key, payload.text);
  }

  function publishText(
    key: string,
    update: { streamLength: number; fragment: string; reset: boolean; immediate?: boolean },
  ): void {
    if (update.streamLength <= 0) {
      if (update.reset) {
        // An empty replacement retracts prior content; a stale line must not
        // outlive it (the draft it showed may have been withdrawn).
        clearNarration(key);
      }
      return;
    }
    const stream = streams.get(key) ?? {
      consumedLength: 0,
      internalDepth: 0,
      delimiterTail: "",
      visibleText: "",
    };
    stream.consumedLength = update.streamLength;
    streams.set(key, stream);
    if (update.reset) {
      stream.internalDepth = 0;
      stream.delimiterTail = "";
      stream.visibleText = "";
      // A replacement supersedes anything still queued behind the throttle;
      // otherwise a pre-replacement draft could republish after retraction.
      const throttle = throttles.get(key);
      if (throttle) {
        throttle.pending = null;
      }
    }
    const visibleFragment = stripSidebarInternalRuntimeFragment(stream, update.fragment);
    const nextVisibleText = `${stream.visibleText}${visibleFragment}`;
    if (!nextVisibleText) {
      if (update.reset && lines.has(key)) {
        lines = new Map(lines);
        lines.delete(key);
        notify();
      }
      return;
    }
    stream.visibleText =
      nextVisibleText.length > SIDEBAR_NARRATION_BUFFER_CHARS
        ? sliceUtf16Safe(nextVisibleText, -SIDEBAR_NARRATION_BUFFER_CHARS)
        : nextVisibleText;
    if (update.immediate) {
      publishImmediate(key, stream.visibleText);
    } else {
      publishThrottled(key, stream.visibleText);
    }
  }

  function handleAgentEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const record = payload as Record<string, unknown>;
    const key = matchingDesiredKey(record.sessionKey, record.agentId);
    if (!key) {
      return;
    }
    if (record.stream === "lifecycle") {
      observeRun(key, record.runId);
      return;
    }
    const runId = typeof record.runId === "string" ? record.runId.trim() : "";
    const sameRun = runId !== "" && runIds.get(key) === runId;
    const activity = readSidebarToolActivity(
      record.stream,
      record.data,
      !runId || sameRun ? tools.get(key) : undefined,
    );
    if (activity === null) {
      // A visibility change withdraws only the identified call in the current run.
      if (sameRun && tools.has(key)) {
        tools = new Map(tools);
        tools.delete(key);
        notify();
      }
      return;
    }
    if (!activity) {
      return;
    }
    observeRun(key, runId);
    const previous = tools.get(key);
    if (
      previous?.name !== activity.name ||
      previous.itemId !== activity.itemId ||
      previous.toolCallId !== activity.toolCallId ||
      previous.text !== activity.text
    ) {
      tools = new Map(tools).set(key, activity);
      notify();
    }
  }

  function handleObserverEvent(payload: unknown): void {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const record = payload as Record<string, unknown>;
    const key = matchingDesiredKey(record.sessionKey, record.agentId);
    const runId = typeof record.runId === "string" ? record.runId.trim() : "";
    if (!key || !runId) {
      return;
    }
    const digest = { ...record, runId };
    if (!isSessionObserverDigest(digest)) {
      return;
    }
    observeRun(key, runId);
    const previous = observerDigests.get(key);
    if (previous && pickFreshestObserverDigest(previous, digest) === previous) {
      return;
    }
    clearNarration(key);
    observerDigests = new Map(observerDigests).set(key, digest);
    notify();
  }

  function observeRun(key: string, runIdValue: unknown): void {
    const runId = typeof runIdValue === "string" ? runIdValue.trim() : "";
    if (!runId) {
      return;
    }
    const previousRunId = runIds.get(key);
    if (previousRunId && previousRunId !== runId) {
      clearLine(key);
    }
    runIds.set(key, runId);
  }

  function publishThrottled(key: string, text: string): void {
    const now = Date.now();
    const throttle = throttles.get(key);
    if (!throttle || now - throttle.lastPublishedAt >= SIDEBAR_NARRATION_THROTTLE_MS) {
      publishImmediate(key, text);
      return;
    }
    throttle.pending = text;
    if (throttle.timer) {
      return;
    }
    throttle.timer = globalThis.setTimeout(
      () => {
        throttle.timer = null;
        const pending = throttle.pending;
        throttle.pending = null;
        if (pending === null || !desiredKeys.has(key)) {
          return;
        }
        throttle.lastPublishedAt = Date.now();
        publishActivity(key, pending);
      },
      SIDEBAR_NARRATION_THROTTLE_MS - (now - throttle.lastPublishedAt),
    );
  }

  function publishImmediate(key: string, text: string): void {
    const timer = throttles.get(key)?.timer;
    if (timer) {
      globalThis.clearTimeout(timer);
    }
    throttles.set(key, { lastPublishedAt: Date.now(), pending: null, timer: null });
    publishActivity(key, text);
  }

  function publishActivity(key: string, text: string): void {
    const line = deriveSidebarNarrationLine(text);
    // A full visible buffer that normalizes to nothing retracts the prior line.
    const changed = line ? lines.get(key) !== line : lines.has(key);
    if (!changed) {
      return;
    }
    lines = new Map(lines);
    if (line) {
      lines.set(key, line);
    } else {
      lines.delete(key);
    }
    notify();
  }

  function clearLine(key: string): void {
    clearNarration(key);
    runIds.delete(key);
    if (tools.has(key)) {
      tools = new Map(tools);
      tools.delete(key);
      notify();
    }
    if (observerDigests.has(key)) {
      observerDigests = new Map(observerDigests);
      observerDigests.delete(key);
      notify();
    }
  }

  function clearNarration(key: string): void {
    streams.delete(key);
    const throttle = throttles.get(key);
    if (throttle?.timer) {
      globalThis.clearTimeout(throttle.timer);
    }
    throttles.delete(key);
    if (lines.has(key)) {
      lines = new Map(lines);
      lines.delete(key);
      notify();
    }
  }

  function clearAllLines(): void {
    for (const throttle of throttles.values()) {
      if (throttle.timer) {
        globalThis.clearTimeout(throttle.timer);
      }
    }
    streams.clear();
    runIds.clear();
    throttles.clear();
    if (tools.size > 0) {
      tools = new Map();
      notify();
    }
    if (lines.size > 0) {
      lines = new Map();
      notify();
    }
    if (observerDigests.size > 0) {
      observerDigests = new Map();
      notify();
    }
  }
  return {
    read: () => ({ lines, observerDigests, tools }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    sync,
    handleEvent,
    disconnect,
  };
}

export type SidebarNarration = ReturnType<typeof createSidebarNarration>;
