import { html } from "lit";
import type { PresentationValue } from "../lib/presentation.ts";
import { livePresentation } from "../lit/presentation-binding.ts";

export type ViewKind = "pages" | "panels" | "accessories" | "widgets" | "replacements";

export function renderPluginContribution(
  kind: Exclude<ViewKind, "replacements">,
  key: string,
  props: unknown,
  presented: PresentationValue = true,
) {
  return html`<openclaw-plugin-view
    .kind=${kind}
    .contributionKey=${key}
    .props=${props}
    .presented=${livePresentation(presented)}
  ></openclaw-plugin-view>`;
}
