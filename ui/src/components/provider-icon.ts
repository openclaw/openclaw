import { html } from "lit";
import { solidContent } from "../lit/solid-content.tsx";
import { resolveCloudProfileIconData, type CloudProfileIdentity } from "./provider-icon-data.ts";
import { CloudProfileIcon, ProviderBrandIcon } from "./solid/provider-icon.tsx";

export {
  compareCloudProfiles,
  formatRawProviderLabel,
  hasProviderBrandIcon,
  providerDisplayLabel,
  providerIdFromModelRef,
} from "./provider-icon-data.ts";

/** One presentation resolver for cloud triggers, menus, and move-session rows. */
export function resolveCloudProfileIcon(profile?: CloudProfileIdentity) {
  const data = resolveCloudProfileIconData(profile);
  return {
    label: data.label,
    icon: html`${solidContent(CloudProfileIcon, { profile })}`,
  };
}

export function renderProviderBrandIcon(provider: string, options?: { className?: string }) {
  return html`${solidContent(ProviderBrandIcon, { provider, class: options?.className })}`;
}
