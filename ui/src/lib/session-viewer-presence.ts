import { SESSION_VIEWER_PRESENCE_MAX_KEYS } from "../../../packages/gateway-protocol/src/schema/sessions-viewer-presence.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import { isGatewayMethodAdvertised } from "./gateway-methods.ts";
import { createGatewaySetSyncLifecycle } from "./gateway-set-sync-lifecycle.ts";
import { resolveSessionKey } from "./sessions/index.ts";

const SESSION_VIEWERS_SET_METHOD = "sessions.viewers.set";
const RENEW_MS = 10_000;
const HUMAN_IDLE_MS = 120_000;

type SessionViewerPresenceStore = {
  watch: (owner: object, sessionKeys: readonly string[]) => void;
  unwatch: (owner: object) => void;
};

const stores = new WeakMap<ApplicationGateway, SessionViewerPresenceStore>();

function createStore(gateway: ApplicationGateway): SessionViewerPresenceStore {
  const watchedByOwner = new Map<object, Set<string>>();
  let knownClient = gateway.snapshot.client;
  let lastHello: object | null = null;
  let lastSignature: string | null = null;
  let acknowledgedSignature: string | null = null;
  let acknowledgedGeneration = 0;
  let requestGeneration = 0;

  let focused = false;
  let lastActivityAt = 0;
  let renewAt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: object | null = null;
  let syncQueued = false;

  const isViewing = () =>
    isActive() &&
    focused &&
    typeof document !== "undefined" &&
    document.visibilityState !== "hidden" &&
    Date.now() - lastActivityAt < HUMAN_IDLE_MS;

  function stopTimer() {
    if (timer !== null) {
      clearTimeout(timer);
    }
    timer = null;
  }

  function armTimer(available: boolean) {
    stopTimer();
    if (!available || !isViewing()) {
      return;
    }
    timer = setTimeout(
      () => {
        timer = null;
        lifecycle.sync();
      },
      Math.max(
        1,
        Math.min(
          renewAt > Date.now() ? renewAt : Date.now() + RENEW_MS,
          lastActivityAt + HUMAN_IDLE_MS,
        ) - Date.now(),
      ),
    );
  }

  function onActivity() {
    if (!focused || document.visibilityState === "hidden") {
      return;
    }
    lastActivityAt = Date.now();
    lifecycle.schedule();
  }
  function onFocus() {
    focused = true;
    onActivity();
  }
  function onBlur() {
    focused = false;
    lifecycle.sync();
  }
  function onVisibility() {
    if (document.visibilityState !== "hidden" && document.hasFocus()) {
      focused = true;
      onActivity();
    } else {
      lifecycle.sync();
    }
  }

  const isActive = () => watchedByOwner.size > 0;

  const visibleSessionKeys = (): string[] => {
    const hello = gateway.snapshot.hello;
    const keys = new Set<string>();
    for (const watched of watchedByOwner.values()) {
      for (const rawKey of watched) {
        const key = resolveSessionKey(rawKey, hello).trim();
        if (key) {
          keys.add(key);
        }
      }
    }
    return [...keys].toSorted().slice(0, SESSION_VIEWER_PRESENCE_MAX_KEYS);
  };

  const lifecycle = createGatewaySetSyncLifecycle(gateway, {
    sync,
    onAttach: () => {
      focused = typeof document !== "undefined" && document.hasFocus();
      lastActivityAt = Date.now();
      renewAt = 0;
      if (typeof window !== "undefined") {
        window.addEventListener("focus", onFocus);
        window.addEventListener("blur", onBlur);
      }
      if (typeof document !== "undefined") {
        document.addEventListener("pointerdown", onActivity, true);
        document.addEventListener("pointermove", onActivity, true);
        document.addEventListener("keydown", onActivity, true);
        document.addEventListener("scroll", onActivity, true);
        document.addEventListener("visibilitychange", onVisibility);
      }
      knownClient = gateway.snapshot.client;
      lastHello = null;
      lastSignature = null;
      acknowledgedSignature = null;
      acknowledgedGeneration = 0;
    },
    onDetach: () => {
      stopTimer();
      inFlight = null;
      syncQueued = false;
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("blur", onBlur);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("pointerdown", onActivity, true);
        document.removeEventListener("pointermove", onActivity, true);
        document.removeEventListener("keydown", onActivity, true);
        document.removeEventListener("scroll", onActivity, true);
        document.removeEventListener("visibilitychange", onVisibility);
      }
      requestGeneration += 1;
      lastHello = null;
      lastSignature = null;
      acknowledgedSignature = null;
      acknowledgedGeneration = 0;
    },
  });
  const { retry } = lifecycle;

  function sync() {
    const snapshot = gateway.snapshot;
    const client = snapshot.client;
    if (client !== knownClient) {
      retry.reset();
      inFlight = null;
      syncQueued = false;
      requestGeneration += 1;
      knownClient = client;
      lastHello = null;
      lastSignature = null;
      acknowledgedSignature = null;
      acknowledgedGeneration = 0;
    }
    const available =
      snapshot.phase === "connected" &&
      client !== null &&
      snapshot.hello !== null &&
      isGatewayMethodAdvertised(snapshot, SESSION_VIEWERS_SET_METHOD) === true;
    if (!available) {
      stopTimer();
      inFlight = null;
      syncQueued = false;
      requestGeneration += 1;
      lastHello = null;
      lastSignature = null;
      acknowledgedSignature = null;
      acknowledgedGeneration = 0;
      if (!isActive()) {
        lifecycle.detach();
      }
      return;
    }
    const sessionKeys = isViewing() ? visibleSessionKeys() : [];
    const agentId = sessionKeys.some((key) => !key.startsWith("agent:"))
      ? snapshot.assistantAgentId
      : undefined;
    const signature = JSON.stringify({ agentId, sessionKeys });
    armTimer(available);
    if (inFlight !== null) {
      syncQueued = true;
      return;
    }
    if (
      snapshot.hello === lastHello &&
      signature === lastSignature &&
      (sessionKeys.length === 0 || Date.now() < renewAt)
    ) {
      if (
        !isActive() &&
        acknowledgedSignature === signature &&
        acknowledgedGeneration === requestGeneration
      ) {
        lifecycle.detach();
      }
      return;
    }
    lastHello = snapshot.hello;
    lastSignature = signature;
    renewAt = Date.now() + RENEW_MS;
    armTimer(available);
    const flight = {};
    inFlight = flight;
    syncQueued = false;
    const currentGeneration = ++requestGeneration;
    const isCurrentRequest = () =>
      lifecycle.attached &&
      gateway.snapshot.client === client &&
      gateway.snapshot.hello === snapshot.hello &&
      gateway.snapshot.phase === "connected" &&
      currentGeneration === requestGeneration &&
      snapshot.hello === lastHello &&
      signature === lastSignature;
    retry.cancel();
    const request = client.request(SESSION_VIEWERS_SET_METHOD, {
      ...(agentId ? { agentId } : {}),
      sessionKeys,
    });
    void request
      .then(() => {
        if (isCurrentRequest()) {
          acknowledgedSignature = signature;
          acknowledgedGeneration = currentGeneration;
          retry.reset();
          if (!isActive() && sessionKeys.length === 0) {
            lifecycle.detach();
          }
        }
      })
      .catch(() => {
        if (!isCurrentRequest()) {
          return;
        }
        lastSignature = null;
        retry.schedule(lifecycle.schedule);
      })
      .finally(() => {
        if (inFlight !== flight) {
          return;
        }
        inFlight = null;
        if (syncQueued) {
          syncQueued = false;
          lifecycle.schedule();
        }
      });
  }

  const watch = (owner: object, sessionKeys: readonly string[]) => {
    const next = new Set(sessionKeys.map((key) => key.trim()).filter(Boolean));
    const current = watchedByOwner.get(owner);
    const unchanged =
      current === undefined
        ? next.size === 0
        : current.size === next.size && [...next].every((key) => current.has(key));
    if (unchanged) {
      return;
    }
    if (next.size === 0) {
      watchedByOwner.delete(owner);
    } else {
      watchedByOwner.set(owner, next);
    }
    retry.reset();
    if (isActive()) {
      lifecycle.attach();
      lifecycle.schedule();
    } else if (lifecycle.attached) {
      lifecycle.sync();
    }
  };

  return { watch, unwatch: (owner) => watch(owner, []) };
}

export function sessionViewerPresenceForGateway(
  gateway: ApplicationGateway,
): SessionViewerPresenceStore {
  const existing = stores.get(gateway);
  if (existing) {
    return existing;
  }
  const store = createStore(gateway);
  stores.set(gateway, store);
  return store;
}
