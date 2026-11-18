import type { JSX } from "@solidjs/web";
import { Errored, lazy, Loading, Show } from "solid-js";
import { inferControlUiPublicAssetPath } from "../../app/public-assets.ts";
import {
  providerDisplayLabel,
  providerFallbackLetter,
  type ProviderPresentation,
  resolveProviderIconName,
} from "../provider-icon-data.ts";

export function ProviderAsset(props: { icon: string; assetPath: string; class?: JSX.ClassValue }) {
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

const ConfiguredProviderIcon = lazy(() => import("./configured-provider-icon.tsx"));

export function ProviderBrandIcon(props: {
  provider: string;
  presentation?: ProviderPresentation;
  class?: JSX.ClassValue;
}) {
  const defaultIcon = () => {
    const icon = resolveProviderIconName(props.provider);
    return icon ? (
      <ProviderAsset
        icon={icon}
        assetPath={inferControlUiPublicAssetPath(`provider-icons/ProviderIcon-${icon}.svg`)}
        class={props.class}
      />
    ) : (
      <ProviderFallbackIcon
        label={providerDisplayLabel(props.provider, props.presentation)}
        class={props.class}
      />
    );
  };
  return (
    <Show when={props.presentation?.providerIcon} keyed fallback={defaultIcon()}>
      {(_selected) => (
        <Errored fallback={defaultIcon}>
          <Loading fallback={defaultIcon()}>
            <ConfiguredProviderIcon {...props} />
          </Loading>
        </Errored>
      )}
    </Show>
  );
}
