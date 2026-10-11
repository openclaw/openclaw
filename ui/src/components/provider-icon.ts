import { html } from "lit";
import { inferControlUiPublicAssetPath } from "../app/public-assets.ts";
import { icons } from "./icons.ts";
import {
  providerFallbackLetter,
  resolveCloudProfileIconData,
  resolveProviderIconName,
  type CloudProfileIdentity,
} from "./provider-icon-data.ts";

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
  const icon =
    data.providerId !== undefined
      ? renderBrandIcon(
          inferControlUiPublicAssetPath(`cloud-provider-icons/${data.providerId}.svg`),
          data.providerId,
          "cloud-provider-icon",
        )
      : icons[data.iconName];
  return {
    label: data.label,
    icon: html`<span class="cloud-profile-icon" aria-hidden="true">${icon}</span>`,
  };
}

function renderBrandIcon(assetPath: string, icon: string, className = "") {
  return html`<span
    class="provider-brand-icon ${className}"
    data-provider-icon=${icon}
    style=${`--provider-icon-url: url("${assetPath}")`}
    aria-hidden="true"
  ></span>`;
}

/** Lettered badge for surfaces that must not infer a provider identity. */
export function renderProviderFallbackIcon(label: string, options?: { className?: string }) {
  const surfaceClass = options?.className ? ` ${options.className}` : "";
  return html`<span
    class="provider-brand-icon provider-brand-icon--fallback${surfaceClass}"
    aria-hidden="true"
    >${providerFallbackLetter(label)}</span
  >`;
}

export function renderProviderBrandIcon(provider: string, options?: { className?: string }) {
  const icon = resolveProviderIconName(provider);
  return icon
    ? renderBrandIcon(
        inferControlUiPublicAssetPath(`provider-icons/ProviderIcon-${icon}.svg`),
        icon,
        options?.className?.trim() ?? "",
      )
    : renderProviderFallbackIcon(provider, options);
}
