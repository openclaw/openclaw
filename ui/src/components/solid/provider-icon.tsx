import { createMemo, Show } from "solid-js";
import {
  providerFallbackLetter,
  resolveCloudProfileIconData,
  resolveProviderIconData,
  type BrandIconData,
  type CloudProfileIdentity,
} from "../provider-icon-data.ts";
import { Icon } from "./icon.tsx";

function ProviderAsset(props: { data: BrandIconData; class?: string }) {
  return (
    <span
      class={["provider-brand-icon", props.class]}
      data-provider-icon={props.data.icon}
      style={{ "--provider-icon-url": `url("${props.data.assetPath}")` }}
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
  const data = createMemo(() => resolveProviderIconData(props.provider));
  const brand = () => {
    const value = data();
    return value.kind === "brand" ? value : undefined;
  };
  return (
    <Show
      when={brand()}
      fallback={<ProviderFallbackIcon label={props.provider} class={props.class} />}
    >
      {(asset) => <ProviderAsset data={asset()} class={props.class} />}
    </Show>
  );
}

export function CloudProfileIcon(props: { profile?: CloudProfileIdentity; class?: string }) {
  const data = createMemo(() => resolveCloudProfileIconData(props.profile).icon);
  const brand = () => {
    const value = data();
    return value.kind === "brand" ? value : undefined;
  };
  const symbol = () => {
    const value = data();
    return value.kind === "symbol" ? value.name : undefined;
  };
  return (
    <span class={["cloud-profile-icon", props.class]} aria-hidden="true">
      <Show
        when={brand()}
        fallback={<Show when={symbol()}>{(name) => <Icon name={name()} />}</Show>}
      >
        {(asset) => <ProviderAsset data={asset()} class="cloud-provider-icon" />}
      </Show>
    </span>
  );
}
