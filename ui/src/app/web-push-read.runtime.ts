import {
  readWebPushCompletion,
  webPushCompletionKey,
  type WebPushCompletion,
} from "../../../src/shared/web-push-completion.js";
import { listen } from "../lib/reactive/listener.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { isSameOriginGateway } from "./gateway-control-ui-reload.ts";

// Push TTL is five minutes. A small margin covers an already queued display.
// Closing all pages forgets receipts: a later delivery waits for another view.
const SEEN_TTL_MS = 6 * 60_000;
const MAX_SEEN = 512;

export type ViewedWebPushCompletion = Omit<WebPushCompletion, "version" | "profileId">;

export function createWebPushReadRuntime(gateway: ApplicationGateway) {
  const seen = new Map<string, number>();
  let disposed = false;
  const scope = () =>
    gateway.snapshot.phase === "connected" &&
    gateway.snapshot.client &&
    gateway.snapshot.selfUser !== undefined &&
    isSameOriginGateway(gateway.connection.gatewayUrl)
      ? JSON.stringify([
          gateway.connection.gatewayUrl,
          gateway.connectionRevision,
          gateway.snapshot.selfUser?.id ?? null,
        ])
      : null;
  let admittedScope = scope();
  let admittedClient = gateway.snapshot.client;
  let generation = 0;
  const stopGateway = gateway.subscribe(() => {
    const next = scope();
    if (next !== admittedScope || gateway.snapshot.client !== admittedClient) {
      seen.clear();
      admittedScope = next;
      admittedClient = gateway.snapshot.client;
      generation += 1;
    }
  });
  const prune = () => {
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [key, at] of seen) {
      if (at < cutoff) {
        seen.delete(key);
      }
    }
  };
  const reconcile = async (stillPresented: () => boolean = () => true) => {
    const admitted = scope();
    const admittedGeneration = generation;
    const client = gateway.snapshot.client;
    if (disposed || !admitted || document.visibilityState !== "visible") {
      return;
    }
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      if (!registration) {
        return;
      }
      const registered = new URL(registration.scope);
      const gatewayUrl = new URL(gateway.connection.gatewayUrl.replace(/^ws/u, "http"));
      // Same origin alone is insufficient for two Gateways hosted at different paths.
      const root = registered.pathname.replace(/\/$/u, "");
      if (
        gatewayUrl.origin !== registered.origin ||
        gatewayUrl.search || gatewayUrl.hash ||
        ![root || "/", root + "/", root + "/ws"].includes(gatewayUrl.pathname)
      ) {
        return;
      }
      const notifications = await registration.getNotifications();
      if (
        disposed || scope() !== admitted || generation !== admittedGeneration ||
        gateway.snapshot.client !== client ||
        document.visibilityState !== "visible" || !stillPresented()
      ) {
        return;
      }
      prune();
      for (const notification of notifications) {
        const completion = readWebPushCompletion(notification.data?.completion);
        if (completion && seen.has(webPushCompletionKey(completion))) {
          notification.close();
        }
      }
    } catch {
      // Optional browser cleanup must not fail chat loading or request permission.
    }
  };
  const serviceWorker = globalThis.navigator?.serviceWorker;
  const stopMessages = serviceWorker
    ? listen(serviceWorker, "message", (event: MessageEvent) => {
        if (event.data?.type === "openclaw-completion-delivered") {
          // A hint grants no read authority: only prior exact visibility receipts match.
          void reconcile();
        }
      })
    : () => {};
  return {
    viewed(completion: ViewedWebPushCompletion, stillPresented: () => boolean): void {
      if (disposed || !scope() || !stillPresented() || document.visibilityState !== "visible") {
        return;
      }
      const value = readWebPushCompletion({
        ...completion,
        version: 1,
        profileId: gateway.snapshot.selfUser?.id ?? null,
      });
      if (!value) {
        return;
      }
      prune();
      const key = webPushCompletionKey(value);
      seen.delete(key);
      seen.set(key, Date.now());
      if (seen.size > MAX_SEEN) {
        const oldest = seen.keys().next().value;
        if (oldest !== undefined) {
          seen.delete(oldest);
        }
      }
      void reconcile(stillPresented);
    },
    dispose(): void {
      disposed = true;
      seen.clear();
      stopGateway();
      stopMessages();
    },
  };
}
