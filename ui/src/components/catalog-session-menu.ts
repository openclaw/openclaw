import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { DropdownMenuController } from "./dropdown-menu-controller.ts";
import { icons } from "./icons.ts";
import { promoteToPopoverTopLayer, renderMenuTrigger } from "./menu-surface.ts";
import "./web-awesome.ts";

export type CatalogSessionMenuAction = "viewer" | "import" | "terminal" | "delete";

class CatalogSessionMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) x = 0;
  @property({ attribute: false }) y = 0;
  @property({ attribute: false }) trigger: HTMLElement | null = null;
  @property({ attribute: false }) lastActive = "";
  @property({ attribute: false }) terminalDisabled = false;
  @property({ attribute: false }) canDelete = false;
  @property({ attribute: false }) canImport = false;
  @property({ attribute: false }) onAction: (action: CatalogSessionMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};
  readonly menuLifecycle = new DropdownMenuController(this, {
    getTrigger: () => this.trigger,
    onClose: () => this.onClose(),
  });

  override connectedCallback() {
    super.connectedCallback();
    promoteToPopoverTopLayer(this);
  }

  private run(action: CatalogSessionMenuAction) {
    // Dispatch while the controller still owns the menu snapshot; close clears it synchronously.
    this.onAction(action);
    this.onClose();
  }

  private readonly handleSelect = (
    event: CustomEvent<{ item: { value?: CatalogSessionMenuAction } }>,
  ) => {
    event.preventDefault();
    const action = event.detail.item.value;
    if (action) {
      this.run(action);
    }
  };

  private readonly handleAfterHide = (event: Event) => {
    if (event.currentTarget instanceof Node && event.currentTarget.isConnected) {
      this.onClose();
    }
  };

  override render() {
    const menuWidth = 240;
    const menuMaxHeight = 140 + (this.canDelete ? 40 : 0) + (this.canImport ? 40 : 0);
    const x = Math.max(8, Math.min(this.x, window.innerWidth - menuWidth - 8));
    const y = Math.max(8, Math.min(this.y, window.innerHeight - menuMaxHeight - 8));
    const menuLabel = t("chat.catalog.sessionMenu");
    return html`
      <wa-dropdown
        class="session-menu"
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        aria-label=${menuLabel}
        @wa-select=${this.handleSelect}
        @wa-after-hide=${this.handleAfterHide}
      >
        ${renderMenuTrigger({ x, y }, menuLabel)}
        ${
          this.lastActive
            ? html`<div class="session-menu__info">
                ${t("sessionsView.lastActive", { time: this.lastActive })}
              </div>`
            : ""
        }
        ${(
          [
            ["viewer", true, "chat.catalog.openInOpenClaw", icons.messageSquare],
            ["import", this.canImport, "chat.catalog.importToOpenClaw", icons.download],
            ["terminal", true, "chat.catalog.openInTerminal", icons.terminal],
            ["delete", this.canDelete, "chat.catalog.deleteSession", icons.trash],
          ] as const
        ).map(([action, visible, label, icon]) =>
          visible
            ? html`<wa-dropdown-item
                class=${`session-menu__item${action === "delete" ? " session-menu__item--destructive" : ""}`}
                variant=${action === "delete" ? "danger" : nothing}
                value=${action}
                title=${action === "terminal" ? (this.terminalDisabled ? t("chat.catalog.terminalUnavailable") : "") : nothing}
                ?disabled=${action === "terminal" && this.terminalDisabled}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true">${icon}</span>
                <span class="session-menu__text">${t(label)}</span>
              </wa-dropdown-item>`
            : "",
        )}
      </wa-dropdown>
    `;
  }
}

if (!customElements.get("openclaw-catalog-session-menu")) {
  customElements.define("openclaw-catalog-session-menu", CatalogSessionMenu);
}
