import { createSignal } from "solid-js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context-types.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import type { ConfigPageId } from "./config-sections.ts";

/** Retains the config page's admitted read; the overlay still owns request authority. */
export function createConfigUpdateStatusRead(context: ApplicationContext) {
  let client: GatewayBrowserClient | null = null;
  const [read, setRead] = createSignal<Promise<boolean> | null>(null, { ownedWrite: true });
  function refresh() {
    const completion = context.overlays.refreshUpdateStatus();
    void setRead(() => completion);
    return completion;
  }
  return {
    read,
    refresh,
    reset() {
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
