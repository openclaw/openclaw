import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { isRestrictedSessionGuest } from "../app/operator-access.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { listen } from "../lib/reactive/listener.ts";
import type { VisitorAccessNotice } from "./sidebar-attention-entries.ts";

const METHOD = "visitor-access.notice.get";

/** The active guest's notice only; a lost or replaced connection retires its cached data. */
export function createVisitorAccessNoticeSource(gateway: ApplicationGateway, onChange: () => void) {
  let notice: VisitorAccessNotice | null = null;
  let active: { stop: () => void; refresh: () => void } | undefined;
  let scope = gatewayPresentationScope(gateway);
  let client = gateway.snapshot.client;
  const setNotice = (next: VisitorAccessNotice | null) => {
    if (next?.id !== notice?.id || next?.note !== notice?.note) {
      notice = next;
      onChange();
    }
  };
  const synchronize = () => {
    const { snapshot } = gateway;
    const nextScope = gatewayPresentationScope(gateway);
    const nextClient = snapshot.client;
    const available =
      isRestrictedSessionGuest(snapshot.hello?.auth ?? null) &&
      canCallGatewayMethod(snapshot, METHOD, "operator.sessions.read");
    if (scope !== nextScope || client !== nextClient || !available) {
      active?.stop();
      active = undefined;
      scope = nextScope;
      client = nextClient;
      setNotice(null);
    }
    if (active || !nextClient || !available) {
      return;
    }
    let stopped = false;
    let reading = false;
    let refreshQueued = false;
    const refresh = () => {
      if (stopped || document.visibilityState === "hidden") {
        return;
      }
      if (reading) {
        refreshQueued = true;
        return;
      }
      reading = true;
      void nextClient
        .request<{ notice: VisitorAccessNotice | null }>(METHOD, {})
        .then(
          (result) => {
            if (!stopped) {
              setNotice(result.notice);
            }
          },
          () => {
            if (!stopped) {
              setNotice(null);
            }
          },
        )
        .finally(() => {
          reading = false;
          if (refreshQueued) {
            refreshQueued = false;
            refresh();
          }
        });
    };
    // Renewals don't reconnect the guest. Only visible guest tabs need a refresh.
    const timer = globalThis.setInterval(refresh, 30_000);
    const stopVisibility = listen(document, "visibilitychange", refresh);
    active = {
      refresh,
      stop() {
        stopped = true;
        globalThis.clearInterval(timer);
        stopVisibility();
      },
    };
    refresh();
  };
  const unsubscribe = gateway.subscribe(synchronize);
  synchronize();
  return {
    get notice() {
      return notice;
    },
    refresh: () => active?.refresh(),
    dispose() {
      unsubscribe();
      active?.stop();
    },
  };
}
