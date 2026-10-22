import { sleepWithAbort } from "@openclaw/retry";
import { createMemo, Loading, onCleanup, Show } from "solid-js";
import { lookupClientGeolocation, type ClientGeolocation } from "../lib/geolocation-lookup.ts";
import { Icon } from "./solid/icon.tsx";

type IpLocationProps = { ip?: string };

// The first lookup can wait for a database download; unavailable answers retry.
const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

export function IpLocation(props: IpLocationProps) {
  let host!: HTMLElement;
  const ip = createMemo(() => props.ip?.trim());
  const location = createMemo(async (): Promise<ClientGeolocation | null> => {
    const address = ip();
    if (!address) {
      return null;
    }
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    for (const delay of [0, ...RETRY_DELAYS_MS]) {
      if (delay) {
        await sleepWithAbort(delay, controller.signal).catch(() => undefined);
      }
      if (controller.signal.aborted) {
        return null;
      }
      const result = await lookupClientGeolocation(address);
      // Shared lookups may populate their cache after this connection ends.
      if (controller.signal.aborted || !host.isConnected) {
        return null;
      }
      if (result.status !== "unavailable") {
        return result.status === "located" ? result.location : null;
      }
    }
    return null;
  });
  const label = () =>
    [location()?.city, location()?.region ?? location()?.country].filter(Boolean).join(", ");
  return (
    <openclaw-ip-location ref={(element) => (host = element)} style="display: contents">
      <Loading on={ip()} fallback={null}>
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
      </Loading>
    </openclaw-ip-location>
  );
}
