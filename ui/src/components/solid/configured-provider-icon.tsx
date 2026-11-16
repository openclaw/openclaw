import { createMemo, createSignal, onSettled, Show } from "solid-js";
import { AuthenticatedAvatarRouteLoader } from "../../lib/authenticated-avatar-route.ts";
import { iconData, type IconName } from "../icon-data.ts";
import { resolveProviderIconName } from "../provider-icon-data.ts";
import { Icon } from "./icon.tsx";
import { ProviderBrandIcon } from "./provider-icon.tsx";

function isBuiltinIconName(name: string): name is IconName {
  return Object.hasOwn(iconData, name);
}

/** Optional artwork and icon-registry code stays out of the ordinary provider-brand path. */
export default function ConfiguredProviderIcon(props: Parameters<typeof ProviderBrandIcon>[0]) {
  const [failed, setFailed] = createSignal(false);
  // The outer keyed boundary owns icon changes; omit artwork from the fallback to
  // retain the configured label without recursively loading this component.
  const icon = () => props.presentation!.providerIcon!;
  const fallback = () => (
    <ProviderBrandIcon
      provider={props.provider}
      presentation={{ providerName: props.presentation?.providerName }}
      class={props.class}
    />
  );
  const builtin = () => {
    const selected = icon();
    return selected.source === "builtin" && isBuiltinIconName(selected.name)
      ? selected.name
      : undefined;
  };
  const [revision, invalidate] = createSignal(0, { ownedWrite: true });
  const loader = new AuthenticatedAvatarRouteLoader(() => invalidate((value) => value + 1), {
    gatewayContext: true,
  });
  onSettled(() => {
    loader.connect();
    return () => loader.disconnect();
  });
  const artwork = createMemo(() => {
    revision();
    const selected = icon();
    const routeUrl = selected.source === "asset" && !failed() ? selected.url : null;
    return loader.withActiveRoutes(() => (routeUrl ? loader.resolve(routeUrl) : null));
  });
  const brand = () => {
    const selected = icon();
    return selected.source === "builtin" ? resolveProviderIconName(selected.name) : null;
  };
  return (
    <Show
      when={builtin()}
      fallback={
        <Show
          when={brand()}
          fallback={
            <Show when={!failed() && artwork()} fallback={fallback()}>
              {(url) => (
                <img
                  class={["provider-brand-icon", props.class]}
                  style={{ "object-fit": "contain" }}
                  src={url()}
                  alt=""
                  aria-hidden="true"
                  onError={() => setFailed(true)}
                />
              )}
            </Show>
          }
        >
          {(name) => <ProviderBrandIcon provider={name()} class={props.class} />}
        </Show>
      }
    >
      {(name) => (
        <span class={["provider-brand-icon", props.class]} aria-hidden="true">
          <Icon name={name()} />
        </span>
      )}
    </Show>
  );
}
