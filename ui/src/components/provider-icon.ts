import { html } from "lit";
import { solidContent } from "../lit/solid-content.tsx";
import { resolveCloudProfileIconData, type CloudProfileIdentity } from "./provider-icon-data.ts";
import {
  CloudProfileIcon,
  ProviderBrandIcon,
  ProviderFallbackIcon,
} from "./solid/provider-icon.tsx";

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

/** Lettered badge for surfaces that must not infer a provider identity. */
export function renderProviderFallbackIcon(label: string, options?: { className?: string }) {
  return html`${solidContent(ProviderFallbackIcon, { label, class: options?.className })}`;
}

export function renderProviderBrandIcon(provider: string, options?: { className?: string }) {
  return html`${solidContent(ProviderBrandIcon, { provider, class: options?.className })}`;
}
