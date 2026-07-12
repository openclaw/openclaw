// Parent side of the custom-widget postMessage bridge (00 §6, spec-50 §Bridge).
//
// DOM-free and unit-testable: the browser host (`workspace-custom-widget.ts`)
// wires a real iframe + window listener to `createWidgetBridge`, but every
// security decision — accept filter, manifest gating, capability checks, rate
// limiting, timeouts — lives here so it can be tested without a DOM.
//
// SECURITY MODEL (normative):
// - The child's origin is opaque (`null`) because the iframe is sandboxed without
//   `allow-same-origin`. The host accepts one token-bound bootstrap from the
//   iframe, then all traffic uses that document's MessagePort. Navigation loses
//   the port, unlike the iframe's stable WindowProxy.
// - A widget may only request bindings declared in the manifest the operator
//   approved. Undeclared bindingId → `workspace:error {code:"binding_denied"}`.
// - `sendPrompt` requires the manifest `prompt:send` capability AND an operator
//   confirm per invocation AND a rate limit (1 in-flight, 10/min).
// - Inter-widget pub/sub is parent-brokered and requires `bus:pubsub` for both
//   publishing and subscribing. The host owns tab and connection identity.
// - Parent→child posts always use targetOrigin "*" (opaque origin), carrying only
//   binding data / theme tokens the widget is entitled to — never secrets.

import type { WidgetManifestView } from "./types.ts";

export const BRIDGE_ENVELOPE_VERSION = 1;

/** child→parent message types. */
export type WidgetInboundType =
  | "workspace:ready"
  | "workspace:getData"
  | "workspace:getTheme"
  | "workspace:sendPrompt"
  | "workspace:publish"
  | "workspace:subscribe"
  | "workspace:unsubscribe";

export type WidgetErrorCode =
  | "binding_denied"
  | "capability_denied"
  | "rate_limited"
  | "prompt_declined"
  | "timeout"
  | "resolve_failed"
  | "payload_too_large"
  | "malformed";

export type WidgetOutboundMessage =
  | { v: 1; type: "workspace:data"; requestId: string; bindingId: string; data: unknown }
  | { v: 1; type: "workspace:push"; bindingId: string; data: unknown }
  | { v: 1; type: "workspace:theme"; requestId: string; tokens: Record<string, string> }
  | { v: 1; type: "workspace:message"; channel: string; payload: unknown }
  | { v: 1; type: "workspace:error"; requestId?: string; code: WidgetErrorCode; message: string };

export type WidgetBusBridge = {
  publish: (channel: string, payload: unknown) => void;
  subscribe: (channel: string, deliver: (channel: string, payload: unknown) => void) => () => void;
};

/** Injected side effects — real implementations live in the browser host. */
export type WidgetBridgeDeps = {
  manifest: WidgetManifestView;
  /** Resolve a manifest-declared binding by id. */
  resolveBinding: (bindingId: string) => Promise<unknown>;
  /**
   * Resolve-time gate run BEFORE `resolveBinding`. Return a WidgetErrorCode to
   * deny without resolving the binding, or null to allow. Optional; when omitted,
   * every declared binding is allowed to resolve.
   */
  assertBindingAllowed?: (bindingId: string) => WidgetErrorCode | null;
  /** Current theme tokens (CSS custom-property values from the document root). */
  resolveTheme: () => Record<string, string>;
  /** Operator confirm dialog quoting the exact prompt text; resolves true to send. */
  confirmPrompt: (text: string) => Promise<boolean>;
  /** Dispatch the prompt through the existing chat-send path. */
  sendPrompt: (text: string) => Promise<void>;
  /** Post a message to the child (host wires targetOrigin "*"). */
  post: (message: WidgetOutboundMessage) => void;
  /** Parent-owned bus connection already bound to this widget's tab and identity. */
  bus?: WidgetBusBridge;
  /** getData answer deadline; posts a timeout error if the resolver overruns. Default 10s. */
  getDataTimeoutMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
};

export type WidgetBridge = {
  /** Handle one already-source-verified inbound message. Returns true if accepted. */
  handleMessage: (data: unknown) => boolean;
  /** Push fresh data for a declared binding to the child (broadcast-driven). */
  push: (bindingId: string) => Promise<void>;
  /** Count of messages dropped by the accept filter (well-formedness). For tests. */
  readonly droppedCount: number;
  dispose: () => void;
};

const DEFAULT_GET_DATA_TIMEOUT_MS = 10_000;
const PROMPT_RATE_WINDOW_MS = 60_000;
const PROMPT_RATE_MAX = 10;
const BUS_PUBLISH_RATE_WINDOW_MS = 60_000;
const BUS_PUBLISH_RATE_MAX = 60;
const BUS_MAX_PAYLOAD_BYTES = 8 * 1024;
const BUS_MAX_CHANNEL_LENGTH = 128;

/**
 * sendPrompt rate-limit state, keyed by STABLE widget identity (the custom widget
 * name), NOT the iframe/bridge instance. The lit host recreates the iframe (and a
 * fresh bridge) on layout drag / tab switch / widget re-add, so per-closure state
 * would let a widget reset its "10/min + 1 in-flight" cap simply by triggering a
 * remount. Persisting this at module scope keyed by name closes that hole: the
 * rolling window survives bridge re-instantiation. Each distinct widget name has
 * its own independent budget.
 */
type PromptRateState = { timestamps: number[]; inFlight: boolean };
const promptRateStates = new Map<string, PromptRateState>();

function getPromptRateState(widgetName: string): PromptRateState {
  let state = promptRateStates.get(widgetName);
  if (!state) {
    state = { timestamps: [], inFlight: false };
    promptRateStates.set(widgetName, state);
  }
  return state;
}

/** Test-only: reset all persisted rate-limit budgets. */
export function resetPromptRateStatesForTest(): void {
  promptRateStates.clear();
}

type BusRateState = { timestamps: number[] };
const busRateStates = new Map<string, BusRateState>();

function getBusRateState(widgetName: string): BusRateState {
  let state = busRateStates.get(widgetName);
  if (!state) {
    state = { timestamps: [] };
    busRateStates.set(widgetName, state);
  }
  return state;
}

/** Test-only: reset all persisted pub/sub rate-limit budgets. */
export function resetBusRateStatesForTest(): void {
  busRateStates.clear();
}

function payloadByteLength(payload: unknown): number | null {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    return null;
  }
  if (json === undefined) {
    return 0;
  }
  return new TextEncoder().encode(json).length;
}

const INBOUND_TYPES = new Set<WidgetInboundType>([
  "workspace:ready",
  "workspace:getData",
  "workspace:getTheme",
  "workspace:sendPrompt",
  "workspace:publish",
  "workspace:subscribe",
  "workspace:unsubscribe",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Well-formedness filter: a valid inbound message is an object with `v === 1` and
 * a known `type`. Anything else is dropped silently (counted for tests). This runs
 * after the host has moved traffic onto the approved document's MessagePort.
 */
export function isWellFormedInbound(
  data: unknown,
): data is { v: 1; type: WidgetInboundType } & Record<string, unknown> {
  return (
    isRecord(data) &&
    data.v === BRIDGE_ENVELOPE_VERSION &&
    typeof data.type === "string" &&
    INBOUND_TYPES.has(data.type as WidgetInboundType)
  );
}

/** Creates the parent-side bridge for one approved custom widget. */
export function createWidgetBridge(deps: WidgetBridgeDeps): WidgetBridge {
  const now = deps.now ?? (() => Date.now());
  const getDataTimeoutMs = deps.getDataTimeoutMs ?? DEFAULT_GET_DATA_TIMEOUT_MS;
  const declaredBindingIds = new Set(Object.keys(deps.manifest.bindings));
  const capabilities = new Set(deps.manifest.capabilities);
  let dropped = 0;
  let disposed = false;
  // Rate-limit state is keyed by the widget NAME (stable identity), so it persists
  // across bridge re-instantiation when the iframe is recreated.
  const rateState = getPromptRateState(deps.manifest.name);
  const busRateState = getBusRateState(deps.manifest.name);
  const busSubscriptions = new Map<string, () => void>();
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  function error(code: WidgetErrorCode, message: string, requestId?: string): void {
    deps.post({
      v: 1,
      type: "workspace:error",
      ...(requestId !== undefined ? { requestId } : {}),
      code,
      message,
    });
  }

  async function handleGetData(requestId: string, bindingId: string): Promise<void> {
    if (!capabilities.has("data:read")) {
      error("capability_denied", "widget lacks the data:read capability", requestId);
      return;
    }
    if (!declaredBindingIds.has(bindingId)) {
      // A widget cannot request a binding the operator did not approve.
      error("binding_denied", `binding not declared in manifest: ${bindingId}`, requestId);
      return;
    }
    // Resolve-time gate: host-specific grant mismatches are denied before any
    // resolver or gateway access.
    const denied = deps.assertBindingAllowed?.(bindingId);
    if (denied) {
      error(denied, `binding not allowed: ${bindingId}`, requestId);
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled || disposed) {
        return;
      }
      settled = true;
      pendingTimers.delete(timer);
      error("timeout", "binding resolution timed out", requestId);
    }, getDataTimeoutMs);
    pendingTimers.add(timer);
    try {
      const data = await deps.resolveBinding(bindingId);
      if (settled || disposed) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      pendingTimers.delete(timer);
      deps.post({ v: 1, type: "workspace:data", requestId, bindingId, data });
    } catch (err) {
      if (settled || disposed) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      pendingTimers.delete(timer);
      error("resolve_failed", err instanceof Error ? err.message : String(err), requestId);
    }
  }

  function handleGetTheme(requestId: string): void {
    deps.post({ v: 1, type: "workspace:theme", requestId, tokens: deps.resolveTheme() });
  }

  async function handleSendPrompt(requestId: string, text: string): Promise<void> {
    if (!capabilities.has("prompt:send")) {
      // Denied WITHOUT showing a dialog — the capability gate is first.
      error("capability_denied", "widget lacks the prompt:send capability", requestId);
      return;
    }
    // Rate limit: at most one in-flight prompt and 10 per rolling minute, keyed by
    // widget name so a remount cannot reset the budget.
    const cutoff = now() - PROMPT_RATE_WINDOW_MS;
    rateState.timestamps = rateState.timestamps.filter((ts) => ts > cutoff);
    if (rateState.inFlight || rateState.timestamps.length >= PROMPT_RATE_MAX) {
      error("rate_limited", "prompt send rate limit exceeded", requestId);
      return;
    }
    rateState.inFlight = true;
    try {
      const confirmed = await deps.confirmPrompt(text);
      if (disposed) {
        return;
      }
      if (!confirmed) {
        // Deny path sends NOTHING.
        error("prompt_declined", "operator declined the prompt", requestId);
        return;
      }
      rateState.timestamps.push(now());
      await deps.sendPrompt(text);
    } catch (err) {
      if (!disposed) {
        error("resolve_failed", err instanceof Error ? err.message : String(err), requestId);
      }
    } finally {
      rateState.inFlight = false;
    }
  }

  function handlePublish(channel: string, payload: unknown, requestId?: string): void {
    if (!capabilities.has("bus:pubsub")) {
      error("capability_denied", "widget lacks the bus:pubsub capability", requestId);
      return;
    }
    if (!deps.bus) {
      return;
    }
    const byteLength = payloadByteLength(payload);
    if (byteLength === null) {
      error("malformed", "publish payload is not serializable", requestId);
      return;
    }
    if (byteLength > BUS_MAX_PAYLOAD_BYTES) {
      error(
        "payload_too_large",
        `publish payload exceeds ${BUS_MAX_PAYLOAD_BYTES} bytes`,
        requestId,
      );
      return;
    }
    const cutoff = now() - BUS_PUBLISH_RATE_WINDOW_MS;
    busRateState.timestamps = busRateState.timestamps.filter((timestamp) => timestamp > cutoff);
    if (busRateState.timestamps.length >= BUS_PUBLISH_RATE_MAX) {
      error("rate_limited", "publish rate limit exceeded", requestId);
      return;
    }
    busRateState.timestamps.push(now());
    deps.bus.publish(channel, payload);
  }

  function handleSubscribe(channel: string): void {
    if (!capabilities.has("bus:pubsub")) {
      error("capability_denied", "widget lacks the bus:pubsub capability");
      return;
    }
    if (!deps.bus || busSubscriptions.has(channel)) {
      return;
    }
    const unsubscribe = deps.bus.subscribe(channel, (deliveredChannel, payload) => {
      if (!disposed) {
        deps.post({ v: 1, type: "workspace:message", channel: deliveredChannel, payload });
      }
    });
    busSubscriptions.set(channel, unsubscribe);
  }

  function handleUnsubscribe(channel: string): void {
    const unsubscribe = busSubscriptions.get(channel);
    if (!unsubscribe) {
      return;
    }
    busSubscriptions.delete(channel);
    unsubscribe();
  }

  function handleMessage(data: unknown): boolean {
    if (disposed) {
      return false;
    }
    if (!isWellFormedInbound(data)) {
      dropped += 1;
      return false;
    }
    switch (data.type) {
      case "workspace:ready":
        return true;
      case "workspace:getData": {
        const requestId = typeof data.requestId === "string" ? data.requestId : null;
        const bindingId = typeof data.bindingId === "string" ? data.bindingId : null;
        if (requestId === null || bindingId === null) {
          dropped += 1;
          return false;
        }
        void handleGetData(requestId, bindingId);
        return true;
      }
      case "workspace:getTheme": {
        const requestId = typeof data.requestId === "string" ? data.requestId : null;
        if (requestId === null) {
          dropped += 1;
          return false;
        }
        handleGetTheme(requestId);
        return true;
      }
      case "workspace:sendPrompt": {
        const requestId = typeof data.requestId === "string" ? data.requestId : null;
        const text = typeof data.text === "string" ? data.text : null;
        if (requestId === null || text === null || !text.trim()) {
          dropped += 1;
          return false;
        }
        void handleSendPrompt(requestId, text);
        return true;
      }
      case "workspace:publish": {
        const channel = typeof data.channel === "string" ? data.channel : null;
        const requestId = typeof data.requestId === "string" ? data.requestId : undefined;
        if (
          channel === null ||
          !channel.trim() ||
          channel.length > BUS_MAX_CHANNEL_LENGTH ||
          !Object.hasOwn(data, "payload")
        ) {
          dropped += 1;
          return false;
        }
        handlePublish(channel, data.payload, requestId);
        return true;
      }
      case "workspace:subscribe":
      case "workspace:unsubscribe": {
        const channel = typeof data.channel === "string" ? data.channel : null;
        if (channel === null || !channel.trim() || channel.length > BUS_MAX_CHANNEL_LENGTH) {
          dropped += 1;
          return false;
        }
        if (data.type === "workspace:subscribe") {
          handleSubscribe(channel);
        } else {
          handleUnsubscribe(channel);
        }
        return true;
      }
      default:
        dropped += 1;
        return false;
    }
  }

  async function push(bindingId: string): Promise<void> {
    if (
      disposed ||
      !capabilities.has("data:read") ||
      !declaredBindingIds.has(bindingId) ||
      deps.assertBindingAllowed?.(bindingId)
    ) {
      // A disallowed binding is never pushed (same gate as getData; silent for push).
      return;
    }
    try {
      const data = await deps.resolveBinding(bindingId);
      if (!disposed) {
        deps.post({ v: 1, type: "workspace:push", bindingId, data });
      }
    } catch {
      // Push is best-effort; a failed refresh keeps the last value on the child.
    }
  }

  return {
    handleMessage,
    push,
    get droppedCount() {
      return dropped;
    },
    dispose() {
      disposed = true;
      for (const timer of pendingTimers) {
        clearTimeout(timer);
      }
      pendingTimers.clear();
      for (const unsubscribe of busSubscriptions.values()) {
        unsubscribe();
      }
      busSubscriptions.clear();
      // Release the in-flight lock so a remount can send again, but PRESERVE the
      // rolling-window timestamps — clearing them would reopen the very reset hole
      // this state exists to close.
      rateState.inFlight = false;
    },
  };
}
