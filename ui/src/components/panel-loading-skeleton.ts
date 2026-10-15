import { solidContent } from "../lit/solid-content.tsx";
import {
  PanelLoadingSkeleton,
  type PanelLoadingSkeletonElement,
  type PanelLoadingSkeletonVariant,
} from "./solid/panel-loading-skeleton.tsx";

export type { PanelLoadingSkeletonVariant } from "./solid/panel-loading-skeleton.tsx";

export function renderPanelLoadingSkeleton(
  variant: PanelLoadingSkeletonVariant,
  label: string,
  compact = false,
  overlay = false,
) {
  return solidContent(PanelLoadingSkeleton, { variant, label, compact, overlay });
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-panel-loading-skeleton": PanelLoadingSkeletonElement;
  }
}
