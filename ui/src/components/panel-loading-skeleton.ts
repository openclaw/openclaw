import { html, type TemplateResult } from "lit";
import type {
  PanelLoadingSkeletonElement,
  PanelLoadingSkeletonVariant,
} from "./solid/panel-loading-skeleton.tsx";
import "./solid/panel-loading-skeleton.tsx";

export type { PanelLoadingSkeletonVariant } from "./solid/panel-loading-skeleton.tsx";

export function renderPanelLoadingSkeleton(
  variant: PanelLoadingSkeletonVariant,
  label: string,
  compact = false,
  overlay = false,
): TemplateResult {
  return html`
    <openclaw-panel-loading-skeleton
      .variant=${variant}
      .label=${label}
      ?compact=${compact}
      ?overlay=${overlay}
      role="status"
      aria-busy="true"
      aria-label=${label}
    ></openclaw-panel-loading-skeleton>
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-panel-loading-skeleton": PanelLoadingSkeletonElement;
  }
}
