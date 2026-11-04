import type { JSX } from "@solidjs/web";
import { createEffect, createMemo, createSignal, Show } from "solid-js";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import {
  fetchGatewayContextResource,
  readAvatarGatewayContext,
} from "../../lib/identity-avatar-context.ts";
import { useProviderPresentation } from "../../lib/reactive/provider-presentation.tsx";
import { iconData, type IconName } from "../icon-data.ts";
import {
  providerDisplayLabel,
  providerFallbackLetter,
  type ProviderPresentation,
  resolveCloudProfileIconData,
  resolveProviderIconName,
  type CloudProfileIdentity,
} from "../provider-icon-data.ts";
import { Icon } from "./icon.tsx";

function ProviderAsset(props: { icon: string; assetPath: string; class?: JSX.ClassValue }) {
  return (
    <span
      class={["provider-brand-icon", props.class]}
      data-provider-icon={props.icon}
      style={{ "--provider-icon-url": `url("${props.assetPath}")` }}
      aria-hidden="true"
    />
  );
}

export function ProviderFallbackIcon(props: { label: string; class?: JSX.ClassValue }) {
  return (
    <span
      class={["provider-brand-icon", "provider-brand-icon--fallback", props.class]}
      aria-hidden="true"
    >
      {providerFallbackLetter(props.label)}
    </span>
  );
}

function isBuiltinIconName(name: string): name is IconName {
  return Object.hasOwn(iconData, name);
}

export function ProviderBrandIcon(props: {
  provider: string;
  presentation?: ProviderPresentation;
  class?: JSX.ClassValue;
}) {
  const lookup = useProviderPresentation();
  const presentation = createMemo(() => props.presentation ?? lookup(props.provider));
  const [failedIcon, setFailedIcon] = createSignal<ProviderPresentation["providerIcon"]>();
  const configured = createMemo(() => presentation()?.providerIcon);
  const artwork = createMemo(() => {
    const candidate = configured();
    return candidate?.source === "asset" && candidate !== failedIcon() ? candidate : undefined;
  });
  const [loadedArtwork, setLoadedArtwork] = createSignal<{
    url: string;
    icon: NonNullable<ProviderPresentation["providerIcon"]>;
  }>();
  createEffect(artwork, (asset) => {
    setLoadedArtwork(undefined);
    if (!asset) {
      return undefined;
    }
    let active = true;
    let objectUrl: string | undefined;
    const release = () => {
      active = false;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
    const { origin, resourceBasePath } = readAvatarGatewayContext();
    const url = new URL(resourceBasePath + asset.url, origin ?? globalThis.location.origin).href;
    void fetchGatewayContextResource(url, 5_000)
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Provider artwork is unavailable");
        }
        const blob = await response.blob();
        if (active) {
          objectUrl = URL.createObjectURL(blob);
          setLoadedArtwork({ url: objectUrl, icon: asset });
        }
      })
      .catch(() => {
        if (active) {
          setFailedIcon(asset);
        }
      });
    return release;
  });
  const builtin = createMemo(() => {
    const candidate = configured();
    return candidate?.source === "builtin" && isBuiltinIconName(candidate.name)
      ? candidate.name
      : undefined;
  });
  const icon = createMemo(() => {
    const candidate = configured();
    return (
      (candidate?.source === "builtin" ? resolveProviderIconName(candidate.name) : null) ??
      resolveProviderIconName(props.provider)
    );
  });
  const label = createMemo(() => providerDisplayLabel(props.provider, presentation()));
  return (
    <Show
      when={loadedArtwork()}
      keyed
      fallback={
        <Show
          when={builtin()}
          fallback={
            <ProviderDefaultIcon
              provider={props.provider}
              icon={icon()}
              label={label()}
              class={props.class}
            />
          }
        >
          {(name) => (
            <span class={["provider-brand-icon", props.class]} aria-hidden="true">
              <Icon name={name()} />
            </span>
          )}
        </Show>
      }
    >
      {(asset) => (
        <img
          class={["provider-brand-icon", "provider-brand-icon--custom", props.class]}
          src={asset.url}
          alt=""
          aria-hidden="true"
          onError={() => setFailedIcon(asset.icon)}
        />
      )}
    </Show>
  );
}

function ProviderDefaultIcon(props: {
  provider: string;
  icon: string | null;
  label: string;
  class?: JSX.ClassValue;
}) {
  const icon = () => props.icon;
  return (
    <Show when={icon()} fallback={<ProviderFallbackIcon label={props.label} class={props.class} />}>
      {(name) => (
        <ProviderAsset
          icon={name()}
          assetPath={inferControlUiPublicAssetPath(`provider-icons/ProviderIcon-${name()}.svg`)}
          class={props.class}
        />
      )}
    </Show>
  );
}

export function CloudProfileIcon(props: { profile?: CloudProfileIdentity; class?: string }) {
  const data = createMemo(() => resolveCloudProfileIconData(props.profile));
  return (
    <span class={["cloud-profile-icon", props.class]} aria-hidden="true">
      <Show
        when={data().providerId}
        fallback={<Show when={data().iconName}>{(name) => <Icon name={name()} />}</Show>}
      >
        {(providerId) => (
          <ProviderAsset
            icon={providerId()}
            assetPath={inferControlUiPublicAssetPath(`cloud-provider-icons/${providerId()}.svg`)}
            class="cloud-provider-icon"
          />
        )}
      </Show>
    </span>
  );
}
