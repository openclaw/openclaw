import { Show } from "solid-js";
import { t } from "../i18n/index.ts";
import type { JSX } from "../types/solid-elements.d.ts";
import "./web-awesome.ts";

export type LobsterPetDismissMenuPosition = { x: number; y: number };

export function LobsterPetDismissMenu(params: {
  position: LobsterPetDismissMenuPosition | null;
  onDismiss: (permanently: boolean) => void;
  onClose: () => void;
}): JSX.Element {
  // Auto-size clamps the menu to whatever placement flip picks rather than
  // relocating it, so top-start is forced directly since the footer always
  // has clear room above — leaving it to flip risks a shrunk-in-place menu.
  return (
    <Show when={params.position}>
      {(position) => (
        <wa-dropdown
          class="session-menu lobster-pet-dismiss-menu"
          prop:open={true}
          placement="top-start"
          prop:distance={0}
          aria-label={t("quickSettings.appearance.lobsterVisits")}
          onWa-select={(event: CustomEvent<{ item: { value?: string } }>) => {
            event.preventDefault();
            if (event.detail.item.value === "dismiss") {
              params.onDismiss(false);
            } else if (event.detail.item.value === "dismiss-permanently") {
              params.onDismiss(true);
            }
          }}
          onWa-after-hide={params.onClose}
        >
          <button
            slot="trigger"
            type="button"
            tabindex="-1"
            aria-hidden="true"
            aria-label={t("quickSettings.appearance.lobsterVisits")}
            style={`position: fixed; left: ${position().x}px; top: ${position().y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;`}
          />
          <wa-dropdown-item class="session-menu__item" value="dismiss">
            {t("common.dismiss")}
          </wa-dropdown-item>
          <wa-dropdown-item class="session-menu__item" value="dismiss-permanently">
            {t("common.dismissAndDontShowAgain")}
          </wa-dropdown-item>
        </wa-dropdown>
      )}
    </Show>
  );
}
