import type { GatewayBrowserClient } from "../api/gateway.ts";
import { t } from "../i18n/index.ts";
import { listen } from "../lib/reactive/listener.ts";
import { showToast } from "../lib/toast.ts";
import { registerControlUiReloadGuard } from "./document-reload-guard.ts";
import type { ApplicationGatewayDeferredIntent, ApplicationGatewaySnapshot } from "./gateway.ts";

export function createGatewayDeferredIntents(host: {
  snapshot: () => ApplicationGatewaySnapshot;
  isStopped: () => boolean;
  publish: (count: number) => void;
}) {
  const intents = new Map<string, ApplicationGatewayDeferredIntent>();
  let identity: { client: GatewayBrowserClient; scope: string } | undefined;
  let draining = false;
  let releaseGuard: (() => void) | undefined;
  let releaseBeforeUnload: (() => void) | undefined;

  const publish = () => {
    if (intents.size && !releaseGuard) {
      releaseGuard = registerControlUiReloadGuard(
        () => intents.size === 0,
        () => showToast({ message: t("connection.offlineChangesReloadBlocked") }),
      );
      if (typeof window !== "undefined") {
        releaseBeforeUnload = listen(window, "beforeunload", (event) => {
          event.preventDefault();
          event.returnValue = "";
        });
      }
    } else if (!intents.size) {
      releaseGuard?.();
      releaseGuard = undefined;
      releaseBeforeUnload?.();
      releaseBeforeUnload = undefined;
    }
    host.publish(intents.size);
  };

  const discardIntent = (intent: ApplicationGatewayDeferredIntent) => {
    try {
      intent.discard?.();
    } catch (error) {
      console.error("[gateway] deferred intent discard failed:", error);
    }
  };
  const discard = () => {
    const discarded = [...intents.values()];
    intents.clear();
    identity = undefined;
    if (!discarded.length) {
      return;
    }
    for (const intent of discarded) {
      discardIntent(intent);
    }
    publish();
    showToast({
      message: t("connection.offlineChangesDiscarded", { count: String(discarded.length) }),
    });
  };

  const flush = async () => {
    if (draining || !identity) {
      return;
    }
    const owner = identity;
    draining = true;
    try {
      while (intents.size) {
        if (identity !== owner) {
          break;
        }
        const snapshot = host.snapshot();
        if (
          host.isStopped() ||
          snapshot.client !== owner.client ||
          owner.client.offlineRecoveryRetired
        ) {
          discard();
          break;
        }
        if (snapshot.phase !== "connected" || !owner.client.recoveryScopeReady) {
          break;
        }
        if (owner.client.recoveryScope !== owner.scope) {
          discard();
          break;
        }
        const intent = intents.values().next().value!;
        // Retire before dispatch: a lost response belongs to the feature's existing
        // uncertain-outcome handling, never to this unsent-intent queue.
        intents.delete(intent.key);
        try {
          const result = intent.run(owner.client);
          publish();
          await result;
        } catch (error) {
          publish();
          console.error("[gateway] deferred intent failed:", error);
        }
      }
    } finally {
      draining = false;
      if (!intents.size) {
        identity = undefined;
      } else if (
        host.snapshot().phase === "connected" &&
        host.snapshot().client?.recoveryScopeReady
      ) {
        void flush();
      }
    }
  };

  return {
    defer(this: void, intent: ApplicationGatewayDeferredIntent): boolean {
      const snapshot = host.snapshot();
      const client = snapshot.client;
      if (
        host.isStopped() ||
        snapshot.phase === "connected" ||
        !snapshot.hello ||
        !client ||
        client.offlineRecoveryRetired
      ) {
        return false;
      }
      identity ??= {
        client,
        scope: client.recoveryScopeReady
          ? client.recoveryScope
          : (snapshot.hello.auth?.recoveryScope ??
            client.offlineRecoveryScope ??
            client.recoveryScope),
      };
      const previous = intents.get(intent.key);
      if (previous) {
        intents.delete(intent.key);
        discardIntent(previous);
      }
      intents.set(intent.key, intent);
      publish();
      return true;
    },
    discard,
    flush,
  };
}
