import type { JSX } from "@solidjs/web";

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
