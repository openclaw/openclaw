import type { JSX } from "@solidjs/web";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import {
  fetchGatewayContextResource,
  readAvatarGatewayContext,
} from "../../lib/identity-avatar-context.ts";
import { iconData, type IconName } from "../icon-data.ts";
import { resolveProviderIconName } from "../provider-icon-data.ts";
import type { ProviderPresentation } from "../provider-icon-data.ts";
import { Icon } from "./icon.tsx";
import { ProviderBrandIcon } from "./provider-icon.tsx";

type ConfiguredIcon = NonNullable<ProviderPresentation["providerIcon"]>;
function isBuiltinIconName(name: string): name is IconName {
  return Object.hasOwn(iconData, name);
}

/** Optional artwork and icon-registry code stays out of the ordinary provider-brand path. */
export default function ConfiguredProviderIcon(props: {
  icon: ConfiguredIcon;
  class?: JSX.ClassValue;
  fallback: JSX.Element;
}) {
  const [failed, setFailed] = createSignal(false);
  const builtin = () => {
    const icon = props.icon;
    return icon.source === "builtin" && isBuiltinIconName(icon.name) ? icon.name : undefined;
  };
  const artwork = createMemo(
    async () => {
      const icon = props.icon;
      if (icon.source !== "asset") {
        return undefined;
      }
      let active = true;
      let objectUrl: string | undefined;
      onCleanup(() => {
        active = false;
        if (objectUrl) {
          URL.revokeObjectURL(objectUrl);
        }
      });
      try {
        const { origin, resourceBasePath } = readAvatarGatewayContext();
        const url = new URL(resourceBasePath + icon.url, origin ?? globalThis.location.origin).href;
        const response = await fetchGatewayContextResource(url, 5_000);
        if (!response.ok) {
          return undefined;
        }
        const blob = await response.blob();
        if (!active) {
          return undefined;
        }
        objectUrl = URL.createObjectURL(blob);
        return objectUrl;
      } catch {
        return undefined;
      }
    },
    { lazy: true },
  );
  const brand = () =>
    props.icon.source === "builtin" ? resolveProviderIconName(props.icon.name) : null;
  return (
    <Show
      when={builtin()}
      fallback={
        <Show
          when={brand()}
          fallback={
            <Show when={!failed() && artwork()} fallback={props.fallback}>
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
