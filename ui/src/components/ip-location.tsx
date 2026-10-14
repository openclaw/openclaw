import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { lookupClientGeolocation, type ClientGeolocation } from "../lib/geolocation-lookup.ts";
import { defineSolidBridge, type SolidBridgeElement } from "../lit/solid-bridge.ts";
import { Icon } from "./solid/icon.tsx";

type IpLocationProps = { ip: string | undefined };

// The first lookup can wait for a database download; unavailable answers retry.
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

function IpLocationContent(props: IpLocationProps, host: HTMLElement) {
  const [location, setLocation] = createSignal<ClientGeolocation | null>(null);
  createEffect(
    () => props.ip?.trim(),
    (ip) => {
      let active = true;
      let retryTimer: ReturnType<typeof setTimeout> | undefined;
      let retryAttempt = 0;
      setLocation(null);
      const resolve = async () => {
        const result = await lookupClientGeolocation(ip!);
        // Shared lookups may populate their cache after this connection ends.
        if (!active || !host.isConnected) {
          return;
        }
        if (result.status === "located") {
          setLocation(result.location);
        } else if (result.status === "unavailable") {
          const delay = RETRY_DELAYS_MS[retryAttempt++];
          if (delay !== undefined) {
            retryTimer = setTimeout(() => void resolve(), delay);
          }
        }
      };
      if (ip) {
        void resolve();
      }
      return () => {
        active = false;
        clearTimeout(retryTimer);
      };
    },
  );
  const label = createMemo(() =>
    [location()?.city, location()?.region ?? location()?.country].filter(Boolean).join(", "),
  );
  return (
    <Show when={label()}>
      <span class="activity-feed__device-location">
        {label()}
        <Show when={location()?.attribution}>
          {(attribution) => (
            <a
              class="activity-feed__device-attribution"
              href={attribution().url}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={attribution().text}
              title={attribution().text}
            >
              <Icon name="info" />
            </a>
          )}
        </Show>
      </span>
    </Show>
  );
}

defineSolidBridge<IpLocationProps>("openclaw-ip-location", IpLocationContent, {
  properties: { ip: { default: undefined, attribute: false } },
  connected: (host) => {
    host.style.display = "contents";
  },
});

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-ip-location": SolidBridgeElement<IpLocationProps>;
  }
}
