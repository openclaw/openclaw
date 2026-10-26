import { t } from "../i18n/index.ts";
import { listen } from "../lib/reactive/listener.ts";
import { showToast } from "../lib/toast.ts";
import { registerControlUiReloadGuard } from "./document-reload-guard.ts";
import type { ApplicationGatewayDeferredIntent, ApplicationGatewaySnapshot } from "./gateway.ts";

type IntentIdentity = { revision: number; scope: string };

export function createGatewayDeferredIntents(host: {
  snapshot: () => ApplicationGatewaySnapshot;
  connectionRevision: () => number;
  isStopped: () => boolean;
  publish: (
    patch: Pick<ApplicationGatewaySnapshot, "deferredIntentCount" | "deferredIntentDraining">,
  ) => void;
}) {
  const intents = new Map<string, ApplicationGatewayDeferredIntent>();
  let identity: IntentIdentity | undefined;
  let draining: IntentIdentity | undefined;
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
    host.publish({
      deferredIntentCount: intents.size,
      deferredIntentDraining: Boolean(draining && draining === identity),
    });
  };

  const discardIntent = (intent: ApplicationGatewayDeferredIntent) => {
    try {
      intent.discard?.();
    } catch (error) {
      console.error("[gateway] deferred intent discard failed:", error);
    }
  };
  const discard = () => {
    if (!identity) {
      return;
    }
    const discarded = [...intents.values()];
    intents.clear();
    identity = undefined;
    for (const intent of discarded) {
      discardIntent(intent);
    }
    publish();
    if (!discarded.length) {
      return;
    }
    showToast({
      message: t("connection.offlineChangesDiscarded", { count: String(discarded.length) }),
    });
  };

  const flush = async () => {
    if (draining || !identity) {
      return;
    }
    const owner = identity;
    draining = owner;
    try {
      while (intents.size) {
        if (identity !== owner) {
          break;
        }
        const snapshot = host.snapshot();
        const client = snapshot.client;
        if (
          host.isStopped() ||
          host.connectionRevision() !== owner.revision ||
          client?.offlineRecoveryRetired
        ) {
          discard();
          break;
        }
        if (snapshot.phase !== "connected" || !client?.recoveryScopeReady) {
          break;
        }
        if (client.recoveryScope !== owner.scope) {
          discard();
          break;
        }
        const intent = intents.values().next().value!;
        // Retire before dispatch: a lost response belongs to the feature's existing
        // uncertain-outcome handling, never to this unsent-intent queue.
        intents.delete(intent.key);
        try {
          const result = intent.run(client);
          publish();
          await result;
        } catch (error) {
          publish();
          console.error("[gateway] deferred intent failed:", error);
        }
      }
    } finally {
      draining = undefined;
      if (!intents.size) {
        identity = undefined;
      }
      publish();
      if (
        intents.size &&
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
        (snapshot.phase === "connected" &&
          intents.size === 0 &&
          (!draining || draining !== identity)) ||
        !snapshot.hello ||
        !client ||
        client.offlineRecoveryRetired
      ) {
        return false;
      }
      identity ??= {
        revision: host.connectionRevision(),
        scope: client.recoveryScopeReady
          ? client.recoveryScope
          : (snapshot.hello.auth?.recoveryScope ??
            client.offlineRecoveryScope ??
            client.recoveryScope),
      };
      const previous = intents.get(intent.key);
      if (previous) {
        if (!intent.preservePosition) {
          intents.delete(intent.key);
        }
        discardIntent(previous);
      }
      if (intent.discardGroup && intent.group) {
        for (const queued of intents.values()) {
          if (queued.key !== intent.key && queued.group === intent.group) {
            intents.delete(queued.key);
            discardIntent(queued);
          }
        }
      }
      intents.set(intent.key, intent);
      publish();
      if (snapshot.phase === "connected") {
        void flush();
      }
      return true;
    },
    discard,
    flush,
  };
}
