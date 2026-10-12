import { html, type TemplateResult } from "lit";
import { solidContent } from "../../lit/solid-content.tsx";
import { BoardWidgetError } from "./board-widget-error.tsx";
export type { BoardWidgetPageMenu } from "./board-widget-cell-options.ts";

export function renderBoardWidgetError(
  error: unknown,
  options: { onRetry?: () => void } = {},
): TemplateResult {
  return html`${solidContent(BoardWidgetError, { error, onRetry: options.onRetry })}`;
}
