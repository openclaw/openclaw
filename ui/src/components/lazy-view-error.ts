import { emptyLegacyContent, solidContent } from "../lit/solid-content.tsx";
import {
  LazyElementModal,
  LazyElementStateView,
  LazyViewError,
  type LazyElementState,
} from "./solid/lazy-view-error.tsx";

export function renderLazyElementState(
  state: LazyElementState,
  onRetry: () => void,
  onClose: () => void,
) {
  return solidContent(LazyElementStateView, { state, onRetry, onClose });
}

export function renderLazyElementModal(controller: {
  visibleState: LazyElementState | undefined;
  retry(): void;
  close(): void;
}) {
  const state = controller.visibleState;
  if (!state) {
    return emptyLegacyContent;
  }
  return solidContent(LazyElementModal, {
    state,
    onRetry: () => controller.retry(),
    onClose: () => controller.close(),
  });
}

export function renderLazyViewError(params: {
  actionLabel?: string;
  error: unknown;
  onClose?: (event: Event) => void;
  onRetry: (event: Event) => void;
  render?: () => unknown;
  inline?: boolean;
  stale?: boolean;
  subtitle?: string;
}) {
  const { render, inline, ...props } = params;
  return [render?.(), solidContent(LazyViewError, { ...props, inline: inline ?? Boolean(render) })];
}
