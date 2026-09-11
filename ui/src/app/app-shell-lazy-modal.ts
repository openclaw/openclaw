import { nothing } from "lit";
import { renderLazyElementModal } from "../components/lazy-view-error.ts";
import { renderCommandPaletteLoading } from "./app-shell-command-palette-loading.ts";
import type {
  LazyCustomElementRequestController,
  OptionalCustomElement,
} from "./lazy-custom-element.ts";

export function renderShellLazyModal(
  requests: LazyCustomElementRequestController,
  sidebar: LazyCustomElementRequestController,
  commandPalette: OptionalCustomElement,
) {
  const state = requests.visibleState;
  if (state?.status === "loading" && state.element === commandPalette) {
    return renderCommandPaletteLoading(() => requests.close());
  }
  if (state) {
    return renderLazyElementModal(requests);
  }
  return sidebar.visibleState?.status === "error" ? renderLazyElementModal(sidebar) : nothing;
}
