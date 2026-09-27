import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { icons } from "../icons.ts";
import { renderPanelEmptyState } from "../panel-empty-state.ts";
import { renderPanelLoadingSkeleton } from "../panel-loading-skeleton.ts";
import {
  TerminalOpenTimeoutError,
  TerminalOpenUnusableSessionError,
} from "./terminal-connection.ts";
import {
  renderTerminalUploadLayer,
  type TerminalPanelUploadController,
} from "./terminal-panel-upload.ts";

type TerminalPanelViewportParams = {
  activeId: string | null;
  tabsInHeader?: boolean;
  connecting: boolean;
  error: { text: string; retry?: () => void } | null;
  uploadController: TerminalPanelUploadController;
};

export function renderTerminalPanelViewport({
  activeId,
  tabsInHeader = false,
  connecting,
  error,
  uploadController,
}: TerminalPanelViewportParams): TemplateResult {
  return html`
    ${
      error
        ? html`<div class="tp-error" role="alert">
            <span>${error.text}</span>
            ${
              error.retry
                ? html`<button class="btn btn--sm" type="button" @click=${error.retry}>
                    ${t("common.retry")}
                  </button>`
                : nothing
            }
          </div>`
        : nothing
    }
    <wa-tab-panel
      id="terminal-tab-panel"
      class="tp-viewport"
      name=${activeId ?? "terminal"}
      active
      aria-labelledby=${activeId && !tabsInHeader ? `terminal-tab-${activeId}` : nothing}
      aria-label=${tabsInHeader ? t("terminal.title") : nothing}
      @dragenter=${uploadController.handleDragEnter}
      @dragover=${uploadController.handleDragOver}
      @dragleave=${uploadController.handleDragLeave}
      @drop=${uploadController.handleDrop}
    >
      ${
        connecting
          ? renderPanelLoadingSkeleton("terminal", t("terminal.connecting"), false, true)
          : nothing
      }
      ${
        !activeId && !connecting && !error
          ? renderPanelEmptyState({
              icon: icons.terminal,
              heading: t("chat.sidePanel.terminal"),
              description: t("chat.sidePanel.terminalEmpty"),
            })
          : nothing
      }
      <input
        class="tp-file-input"
        type="file"
        multiple
        aria-hidden="true"
        tabindex="-1"
        @change=${uploadController.handleFileSelection}
      />
      ${renderTerminalUploadLayer(uploadController)}
    </wa-tab-panel>
  `;
}

/** Operator-facing text for a failed terminal.open; typed errors map to copy. */
export function terminalOpenErrorText(error: unknown): string {
  if (error instanceof TerminalOpenTimeoutError) {
    return t("terminal.connectionTimedOut");
  }
  if (error instanceof TerminalOpenUnusableSessionError) {
    return t("terminal.unusableSession", { field: error.field });
  }
  return formatUiError(error);
}
