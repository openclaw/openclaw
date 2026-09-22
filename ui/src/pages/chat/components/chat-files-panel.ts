import { html, nothing, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../../components/icons.ts";
import {
  PANEL_HOSTED_TABS_CHANGE_EVENT,
  type PanelHostedTab,
} from "../../../components/panel-hosted-tabs.ts";
import { renderPanelLoadingSkeleton } from "../../../components/panel-loading-skeleton.ts";
import { renderPanelTabStrip } from "../../../components/panel-tab-strip.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import { renderAttachmentFileIcon } from "./chat-attachment-file-icon.ts";
import type { SessionWorkspacePreview } from "./chat-session-workspace-types.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";

let filesPanelSequence = 0;

function nextFilesPanelId(): string {
  filesPanelSequence += 1;
  return `chat-files-content-${filesPanelSequence}`;
}

/** Projection of the workspace controller; tab order and selection have no second store here. */
class ChatFilesPanel extends OpenClawLightDomElement {
  private readonly contentId = nextFilesPanelId();
  @property({ attribute: false }) previews: SessionWorkspacePreview[] = [];
  @property({ attribute: false }) activeId: string | null = null;
  @property({ type: Boolean }) tabsInHeader = true;
  @property({ attribute: false }) browser: TemplateResult | typeof nothing = nothing;
  @property({ attribute: false }) renderDetail:
    | ((content: SidebarContent) => TemplateResult)
    | null = null;
  @property({ attribute: false }) onSelect: (id: string | null) => void = () => {};
  @property({ attribute: false }) onClose: (id: string) => void = () => {};

  get hostedTabs(): PanelHostedTab[] {
    const tabs = this.previews.map(({ id, label, content }) => ({
      id,
      label,
      title: content.kind === "file" ? content.path : label,
      icon: renderAttachmentFileIcon({ filename: label, mode: "preview-with-favicon" }),
      className: content.kind === "loading" ? "is-connecting" : undefined,
    }));
    return this.activeId === null && tabs.length
      ? [{ id: "browse", label: t("chat.sidePanel.files"), icon: icons.folder }, ...tabs]
      : tabs;
  }

  get activeHostedTabId(): string | null {
    return this.activeId ?? (this.previews.length ? "browse" : null);
  }

  get hostedActions() {
    return html`<button
      class="rail-header__action"
      type="button"
      aria-label=${t("chat.sidePanel.files")}
      title=${t("chat.sidePanel.files")}
      @click=${() => this.onSelect(null)}
    >
      ${icons.folder}
    </button>`;
  }

  selectHostedTab(id: string): void {
    this.onSelect(id === "browse" ? null : id);
  }

  async closeHostedTab(id: string): Promise<void> {
    if (id === "browse") {
      this.onSelect(this.previews.at(-1)?.id ?? null);
    } else {
      this.onClose(id);
    }
  }

  protected override updated() {
    this.dispatchEvent(new CustomEvent(PANEL_HOSTED_TABS_CHANGE_EVENT, { bubbles: true }));
  }

  override render() {
    return html`
      ${
        this.tabsInHeader
          ? nothing
          : html`<header class="rail-header side-panel__header">
              <div class="side-panel__header-tabs">
                ${renderPanelTabStrip({
                  tabs: this.hostedTabs.map((tab) => ({
                    ...tab,
                    domId: `${this.contentId}-tab-${tab.id}`,
                    closeLabel: `${t("browser.closeTab")}: ${tab.label}`,
                  })),
                  activeId: this.activeHostedTabId,
                  ariaControls: this.contentId,
                  onSelect: (id) => this.selectHostedTab(id),
                  onClose: (id) => this.closeHostedTab(id),
                  onNew: () => this.onSelect(null),
                  newLabel: t("chat.sidePanel.files"),
                  newControl: this.hostedActions,
                })}
              </div>
            </header>`
      }
      <div id=${this.contentId} class="chat-files-panel__content">
        <div class="chat-files-panel__page" ?hidden=${this.activeId !== null}>${this.browser}</div>
        ${repeat(
          this.previews,
          (preview) => preview.id,
          (preview) => html`
            <div class="chat-files-panel__page" ?hidden=${this.activeId !== preview.id}>
              ${
                preview.content.kind === "loading"
                  ? renderPanelLoadingSkeleton("files", t("common.loading"))
                  : preview.content.kind === "unavailable"
                    ? html`<div class="callout danger" role="alert">
                        ${preview.content.message}
                      </div>`
                    : this.renderDetail?.(preview.content)
              }
            </div>
          `,
        )}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-chat-files-panel")) {
  customElements.define("openclaw-chat-files-panel", ChatFilesPanel);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-chat-files-panel": ChatFilesPanel;
  }
}
