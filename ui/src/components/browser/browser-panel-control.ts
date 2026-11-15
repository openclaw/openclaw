import { t } from "../../i18n/index.ts";
import { registerBrowserEnglish } from "../../i18n/locales/en-browser.ts";
import { requestBrowserOperatorControl, type BrowserRequestClient } from "./browser-client.ts";
import type { BrowserPanelOperations } from "./browser-panel-operation-ownership.ts";
import type { BrowserPanelStateWriter } from "./browser-panel-state.ts";
import { browserRouteKey } from "./browser-target.ts";

registerBrowserEnglish();

const CONTROL_CHECK_INTERVAL_MS = 30_000;

interface BrowserPanelControlHost extends BrowserPanelStateWriter<
  "controlling" | "controlAvailable" | "noticeText"
> {
  readonly operations: Pick<BrowserPanelOperations, "route" | "captureClient">;
}

/** Take control in the Browser panel; the Gateway owns control, this mirrors it per route. */
export function createBrowserPanelControl(host: BrowserPanelControlHost) {
  let probed: { client: BrowserRequestClient; routeKey: string } | undefined;
  let watch = 0;
  return {
    /**
     * Default routing can resolve to a browser node, where takeover is unavailable; only the
     * Gateway knows the execution target, so ask it once per route and connection.
     */
    probe(client: BrowserRequestClient): void {
      const routeKey = browserRouteKey(host.operations.route);
      if (probed?.client === client && probed.routeKey === routeKey) {
        return;
      }
      const probe = { client, routeKey };
      probed = probe;
      void requestBrowserOperatorControl(client, "read").then(
        (control) => {
          if (probed === probe) {
            host.setState("controlAvailable", control.available);
          }
        },
        () => {
          // Without an answer Take control stays hidden; the next route or client asks again.
        },
      );
    },

    /** The Gateway releases control when the holding connection or route goes away. */
    reset(): void {
      probed = undefined;
      host.setState("controlling", false);
      host.setState("controlAvailable", false);
    },

    /**
     * The Gateway also releases control after idle input or from another window; keep the
     * button true. Scoped to the route, not the view epoch that navigation renews.
     */
    watch(): void {
      const current = ++watch;
      const routeKey = browserRouteKey(host.operations.route);
      const live = () =>
        current === watch &&
        host.controlling &&
        browserRouteKey(host.operations.route) === routeKey;
      const check = async () => {
        const client = live() ? host.operations.captureClient() : null;
        if (client) {
          try {
            const control = await requestBrowserOperatorControl(client, "read");
            if (live() && !control.byYou) {
              host.setState("controlling", false);
              host.setState("noticeText", t("browser.controlReleased"));
            }
          } catch {
            // A transient read failure keeps the current state; the next check retries.
          }
        }
        if (live()) {
          setTimeout(() => void check(), CONTROL_CHECK_INTERVAL_MS);
        }
      };
      setTimeout(() => void check(), CONTROL_CHECK_INTERVAL_MS);
    },
  };
}
