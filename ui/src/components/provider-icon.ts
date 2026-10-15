import { html } from "lit";
import { solidContent } from "../lit/solid-content.tsx";
import { ProviderBrandIcon } from "./solid/provider-icon.tsx";

export {
  formatRawProviderLabel,
  hasProviderBrandIcon,
  providerDisplayLabel,
  providerIdFromModelRef,
} from "./provider-icon-data.ts";

export function renderProviderBrandIcon(provider: string, options?: { className?: string }) {
  return html`${solidContent(ProviderBrandIcon, { provider, class: options?.className })}`;
}
