import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { DropdownMenuController } from "../../components/dropdown-menu-controller.ts";
import { icons } from "../../components/icons.ts";
import { promoteToPopoverTopLayer } from "../../components/menu-surface.ts";
import "../../components/web-awesome.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";

export type DashboardCardMenuAction = "toggle-archived" | "delete";

/** Card-scoped subset of the session menu: the gallery only offers the
 *  lifecycle actions that remove a dashboard from view or delete its board. */
class DashboardCardMenu extends OpenClawLightDomElement {
  @property({ attribute: false }) x = 0;
  @property({ attribute: false }) y = 0;
  @property({ attribute: false }) trigger: HTMLElement | null = null;
  @property({ attribute: false }) archived = false;
  @property({ attribute: false }) archiving = false;
  @property({ attribute: false }) archiveAllowed = false;
  @property({ attribute: false }) deleteAllowed = false;
  @property({ attribute: false }) archiveDisabledReason: string | null = null;
  @property({ attribute: false }) deleteDisabledReason: string | null = null;
  @property({ attribute: false }) onAction: (action: DashboardCardMenuAction) => void = () => {};
  @property({ attribute: false }) onClose: () => void = () => {};
  readonly menuLifecycle = new DropdownMenuController(this, {
    getTrigger: () => this.trigger,
    onClose: () => this.onClose(),
  });

  override connectedCallback() {
    super.connectedCallback();
    promoteToPopoverTopLayer(this);
  }

  private readonly handleSelect = (
    event: CustomEvent<{ item: { value?: DashboardCardMenuAction } }>,
  ) => {
    event.preventDefault();
    const action = event.detail.item.value;
    if (action) {
      // Dispatch while the controller still owns the menu snapshot; close clears it synchronously.
      this.onAction(action);
      this.onClose();
    }
  };

  private readonly handleAfterHide = (event: Event) => {
    if (event.currentTarget instanceof Node && event.currentTarget.isConnected) {
      this.onClose();
    }
  };

  override render() {
    const menuWidth = 220;
    const menuMaxHeight = 96;
    const x = Math.max(8, Math.min(this.x, window.innerWidth - menuWidth - 8));
    const y = Math.max(8, Math.min(this.y, window.innerHeight - menuMaxHeight - 8));
    const menuLabel = t("chat.sidebar.openSessionMenu");
    const archiveLabel = this.archiving
      ? t("sessionsView.archiving")
      : this.archived
        ? t("sessionsView.restoreSession")
        : t("sessionsView.archiveSession");
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
        <button
          slot="trigger"
          type="button"
          tabindex="-1"
          aria-hidden="true"
          aria-label=${menuLabel}
          style="position: fixed; left: ${x}px; top: ${y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
        ></button>
        ${
          this.archiveAllowed
            ? html`<wa-dropdown-item
                class="session-menu__item"
                value="toggle-archived"
                title=${this.archiveDisabledReason ?? nothing}
                ?disabled=${this.archiving || this.archiveDisabledReason !== null}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true"
                  >${this.archived ? icons.archiveRestore : icons.archive}</span
                >
                <span class="session-menu__text">${archiveLabel}</span>
              </wa-dropdown-item>`
            : nothing
        }
        ${
          this.deleteAllowed
            ? html`<wa-dropdown-item
                class="session-menu__item session-menu__item--destructive"
                variant="danger"
                value="delete"
                title=${this.deleteDisabledReason ?? nothing}
                ?disabled=${this.deleteDisabledReason !== null}
              >
                <span slot="icon" class="session-menu__icon" aria-hidden="true"
                  >${icons.trash}</span
                >
                <span class="session-menu__text">${t("sessionsView.deleteSessionMenu")}</span>
              </wa-dropdown-item>`
            : nothing
        }
        ${
          this.archiveAllowed || this.deleteAllowed
            ? nothing
            : html`<wa-dropdown-item class="session-menu__item" disabled>
                <span class="session-menu__text">${t("dashboardsPage.noCardActions")}</span>
              </wa-dropdown-item>`
        }
      </wa-dropdown>
    `;
  }
}

if (!customElements.get("openclaw-dashboard-card-menu")) {
  customElements.define("openclaw-dashboard-card-menu", DashboardCardMenu);
}
