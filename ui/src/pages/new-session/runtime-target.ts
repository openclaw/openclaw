import { html, nothing } from "lit";
import { icons } from "../../components/icons.ts";
import type { NewSessionRouteData } from "./location.ts";

export function renderNewSessionRuntimeTarget(data: NewSessionRouteData | undefined) {
  if (!data?.catalogLabel) {
    return nothing;
  }
  return html`<span class="new-session-page__trigger new-session-page__runtime" title=${data.model}>
    <span class="new-session-page__target-icon" aria-hidden="true">${icons.terminal}</span>
    <span>${data.catalogLabel}</span>
  </span>`;
}
