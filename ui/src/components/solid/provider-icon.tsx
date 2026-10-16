import { createMemo, Show } from "solid-js";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import {
  providerFallbackLetter,
  resolveCloudProfileIconData,
  resolveProviderIconName,
  type CloudProfileIdentity,
} from "../provider-icon-data.ts";
import { Icon } from "./icon.tsx";

function ProviderAsset(props: { icon: string; assetPath: string; class?: string }) {
  return (
    <span
      class={["provider-brand-icon", props.class]}
      data-provider-icon={props.icon}
      style={{ "--provider-icon-url": `url("${props.assetPath}")` }}
      aria-hidden="true"
    />
  );
}

export function ProviderFallbackIcon(props: { label: string; class?: string }) {
  return (
    <span
      class={["provider-brand-icon", "provider-brand-icon--fallback", props.class]}
      aria-hidden="true"
    >
      {providerFallbackLetter(props.label)}
    </span>
  );
}

export function ProviderBrandIcon(props: { provider: string; class?: string }) {
  const icon = createMemo(() => resolveProviderIconName(props.provider));
  return (
    <Show
      when={icon()}
      fallback={<ProviderFallbackIcon label={props.provider} class={props.class} />}
    >
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
