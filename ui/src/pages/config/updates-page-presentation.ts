import { createSignal, onSettled } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { ConfigPageId } from "./config-sections.ts";
import type { UpdatesCommandPresentation } from "./updates-types.ts";

/** Owns Updates presentation lifetimes; the overlay retains operation authority. */
export function createConfigUpdatesPresentation(context: ApplicationContext) {
  let client: GatewayBrowserClient | null = null;
  let presentation = Promise.withResolvers<void>();
  function retire() {
    presentation.resolve();
    presentation = Promise.withResolvers<void>();
  }
  onSettled(() => {
    // Release the old presentation before Solid commits the destination route.
    const stop = context.router.subscribe(retire);
    return () => {
      stop();
      retire();
    };
  });
  const [read, setRead] = createSignal<Promise<boolean> | null>(null, { ownedWrite: true });
  function refresh() {
    const completion = context.overlays.refreshUpdateStatus();
    void setRead(() => completion);
    return completion;
  }
  return {
    read,
    refresh,
    captureCommandPresentation(this: void): UpdatesCommandPresentation {
      const captured = presentation;
      return { retired: captured.promise, isCurrent: () => captured === presentation };
    },
    reset() {
      retire();
      client = null;
      setRead(null);
    },
    synchronize(pageId: ConfigPageId) {
      const snapshot = context.gateway.snapshot;
      const next =
        pageId === "updates" && canCallGatewayMethod(snapshot, "update.status", "operator.admin")
          ? snapshot.client
          : null;
      if (next !== client) {
        client = next;
        setRead(null);
        if (next) {
          void refresh();
        }
      }
    },
  };
}
