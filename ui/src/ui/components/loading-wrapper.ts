/**
 * Loading skeleton component helpers
 * 
 * Simplified wrappers for common loading patterns
 */

import { html, nothing } from "lit";
import type { TemplateResult } from "lit";
import {
  renderSkeletonSessionList,
  renderSkeletonConfigForm,
  renderSkeletonCronJobCard,
  renderProgressBar,
} from "../loading-skeletons.ts";

export type LoadingWrapperProps = {
  loading: boolean;
  error?: string | null;
  hasData: boolean;
  skeletonType?: "sessions" | "config" | "cron" | "channels";
  rows?: number;
};

/**
 * Render loading skeleton or content
 */
export function renderWithLoading(
  props: LoadingWrapperProps,
  content: () => TemplateResult | typeof nothing,
): TemplateResult | typeof nothing {
  // Show error (error takes priority)
  if (props.error) {
    return nothing; // Error is handled by error-display component
  }

  // Show skeleton only if loading AND no data yet (initial load)
  if (props.loading && !props.hasData) {
    switch (props.skeletonType) {
      case "sessions":
        return renderSkeletonSessionList(props.rows || 5);
      case "config":
        return renderSkeletonConfigForm();
      case "cron":
        return html`
          <div style="display: flex; flex-direction: column; gap: 12px;">
            ${Array.from({ length: props.rows || 3 }, () => renderSkeletonCronJobCard())}
          </div>
        `;
      default:
        return renderProgressBar({ indeterminate: true });
    }
  }

  // Show content (even if loading, to show live updates)
  return content();
}

/**
 * Render inline loading indicator (for refresh/pagination)
 */
export function renderInlineLoading(
  loading: boolean,
  text: string = "Loading...",
): TemplateResult | typeof nothing {
  if (!loading) {
    return nothing;
  }

  return html`
    <div class="muted" style="display: flex; align-items: center; gap: 8px; padding: 8px;">
      <div style="width: 16px; height: 16px;">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" style="animation: spin 1s linear infinite;">
          <circle cx="12" cy="12" r="10" stroke-width="4" stroke-dasharray="60" stroke-dashoffset="40" opacity="0.3"></circle>
          <circle cx="12" cy="12" r="10" stroke-width="4" stroke-dasharray="60" stroke-linecap="round"></circle>
        </svg>
      </div>
      <span>${text}</span>
    </div>
    <style>
      @keyframes spin {
        to { transform: rotate(360deg); }
      }
    </style>
  `;
}
