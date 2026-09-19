import { html } from "lit";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { t } from "../i18n/index.ts";
import { renderLinkReaderContent } from "./link-reader-content.ts";
import type { LinkReaderTarget } from "./link-reader-target.ts";
type PanelView =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; detail: ControlUiLinkReaderDocument };
export type ReaderTab = { id: string; history: LinkReaderTarget[]; index: number; view: PanelView };
export function tabTarget(tab: ReaderTab | undefined): LinkReaderTarget | null {
  return tab?.history[tab.index] ?? null;
}
export function tabLabel(tab: ReaderTab): string {
  if (tab.view.status === "ready") {
    return tab.view.detail.title;
  }
  const target = tabTarget(tab);
  return target
    ? target.reader.label + " · " + new URL(target.href).pathname
    : t("linkReader.newTab");
}

export function renderLinkReaderPanelContent(
  tab: ReaderTab,
  available: boolean,
  refresh: () => void,
) {
  const target = tabTarget(tab);
  if (!target) {
    return html`<p class="lr-status">${t("linkReader.urlPlaceholder")}</p>`;
  }
  if (!available || tab.view.status === "error") {
    return html`<div class="lr-status" role="alert">
      <h2>${t("linkReader.unavailableTitle")}</h2>
      <p>${!available ? t("linkReader.disconnected") : t("linkReader.unavailable")}</p>
      <button class="lr-retry" type="button" ?disabled=${!available} @click=${refresh}>
        ${t("linkReader.retry")}</button
      ><a href=${target.href} target="_blank" rel="noopener noreferrer" data-link-reader-external
        >${t("linkReader.openExternal", { provider: target.reader.label })}</a
      >
    </div>`;
  }
  if (tab.view.status !== "ready") {
    return html`<p class="lr-status" role="status">${t("linkReader.loadingPreview")}</p>`;
  }
  return renderLinkReaderContent(tab.view.detail, target);
}
